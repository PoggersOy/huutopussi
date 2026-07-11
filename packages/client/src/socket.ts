/**
 * Typed WebSocket client for the frozen @hp/protocol wire contract.
 *
 *  - Single connection singleton; `connect()` is idempotent per room.
 *  - Auto-reconnect with exponential backoff (250 ms → 5 s cap).
 *  - Session tokens persisted in sessionStorage per room code, i.e. PER TAB: a
 *    reload or wake reconnects to the same seat, while a second tab of the same
 *    room in the same browser gets its OWN session — so two seats can be played
 *    side by side (e.g. host + a local second player). Trade-off vs localStorage:
 *    fully closing a tab drops its reconnect token (reopening rejoins fresh).
 *  - iOS suspend rule (docs/plan.md §3): on visibilitychange→visible and on
 *    pageshow we UNCONDITIONALLY refresh — resync over the live socket plus a
 *    watchdog that force-reconnects if the socket is a zombie (iOS kills
 *    sockets silently; readyState may lie).
 *  - App-level ping every 20 s (in addition to server-side ws pings).
 *
 * This module is the ONLY writer of the store's `server` slice (via
 * `serverApply`). Server→client messages are trusted per the protocol header:
 * typed cast, no runtime validation.
 */
import type { PlayerAction } from '@hp/engine';
import {
  type ClientMsg,
  type ConfigPatch,
  type LobbyCmd,
  PROTOCOL_VERSION,
  type ServerMsg,
} from '@hp/protocol';
import { recordRoomHistory } from './history';
import { serverApply, useStore } from './store';

// ── Tunables (exported for tests) ────────────────────────────────────────────

export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 5_000;
export const PING_INTERVAL_MS = 20_000;
export const WAKE_WATCHDOG_MS = 3_000;

/** Reconnect delay for the nth consecutive attempt (1-based): 250, 500, … 5000. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Server close codes that must NOT be retried: reconnecting would just earn the
 * same close forever (two tabs stealing each other's session, a gone/full room,
 * a version mismatch). Each maps to the i18n key surfaced as a dead-end. Every
 * other close (network blips, 1006, server restart) still auto-reconnects.
 */
export const TERMINAL_CLOSE: Readonly<Record<number, string>> = {
  4000: 'error.roomClosed', // room idle-closed / abandoned
  4001: 'error.sessionReplaced', // superseded by another connection (other tab)
  4002: 'error.protocolVersion', // client too old
  4004: 'error.roomNotFound', // room does not exist
  4006: 'error.roomFull', // room at its session cap
};

/** sessionStorage key holding this tab's session token for a room. */
export function sessionKey(roomCode: string): string {
  return `hp:session:${roomCode.toUpperCase()}`;
}

export function loadSessionToken(roomCode: string): string | null {
  try {
    // sessionStorage (not localStorage): the token is per-tab, so two tabs of
    // the same room hold two independent seats instead of colliding on one.
    return sessionStorage.getItem(sessionKey(roomCode));
  } catch {
    return null;
  }
}

function storeSessionToken(roomCode: string, token: string): void {
  try {
    sessionStorage.setItem(sessionKey(roomCode), token);
  } catch {
    // Private mode etc. — session survives only as long as the socket.
  }
}

// ── Connection singleton ─────────────────────────────────────────────────────

interface Desired {
  roomCode: string | undefined;
  sessionToken: string | undefined;
  nickname: string | undefined;
  /** Initial room config for creation; ignored by the server on join/rejoin. */
  config: ConfigPatch | undefined;
}

let desired: Desired | null = null;
let ws: WebSocket | null = null;
/** Bumped on every new socket; stale socket callbacks are ignored. */
let generation = 0;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let wakeWatchdog: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function clearTimers(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (pingTimer !== null) clearInterval(pingTimer);
  if (wakeWatchdog !== null) clearTimeout(wakeWatchdog);
  reconnectTimer = null;
  pingTimer = null;
  wakeWatchdog = null;
}

function send(msg: ClientMsg): boolean {
  if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function openSocket(): void {
  if (desired === null) return;
  const gen = ++generation;
  if (wakeWatchdog !== null) {
    clearTimeout(wakeWatchdog);
    wakeWatchdog = null;
  }

  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.onopen = () => {
    if (gen !== generation || desired === null) return;
    const hello: Extract<ClientMsg, { t: 'hello' }> = { t: 'hello', v: PROTOCOL_VERSION };
    if (desired.roomCode !== undefined) hello.roomCode = desired.roomCode;
    if (desired.sessionToken !== undefined) hello.sessionToken = desired.sessionToken;
    if (desired.nickname !== undefined) hello.nickname = desired.nickname;
    // Only meaningful when creating a room (no roomCode yet).
    if (desired.roomCode === undefined && desired.config !== undefined) {
      hello.config = desired.config;
    }
    socket.send(JSON.stringify(hello));
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping' }), PING_INTERVAL_MS);
  };

  socket.onmessage = (raw: MessageEvent) => {
    if (gen !== generation) return;
    if (wakeWatchdog !== null) {
      // Any traffic proves the socket is alive; call off the zombie hunt.
      clearTimeout(wakeWatchdog);
      wakeWatchdog = null;
    }
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(raw.data)) as ServerMsg;
    } catch {
      return; // garbage frame; ignore
    }
    handleMessage(msg);
  };

  socket.onclose = (ev: CloseEvent) => {
    if (gen !== generation) return;
    ws = null;
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    serverApply.setConnected(false);
    const terminal = TERMINAL_CLOSE[ev.code];
    if (terminal !== undefined) {
      // The server told us this connection is a dead end — stop the reconnect
      // loop entirely (otherwise two tabs / a gone room flap forever) and hand
      // the reason to the UI.
      desired = null;
      clearTimers();
      serverApply.setFatal(terminal);
      return;
    }
    if (!intentionalClose) scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose always follows; reconnect logic lives there.
  };
}

function scheduleReconnect(): void {
  if (desired === null || reconnectTimer !== null) return;
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Re-read the persisted token: a parallel tab may have refreshed it.
    if (desired !== null && desired.roomCode !== undefined) {
      desired.sessionToken = loadSessionToken(desired.roomCode) ?? desired.sessionToken;
    }
    openSocket();
  }, backoffDelay(attempts));
}

function handleMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      attempts = 0;
      if (desired !== null) {
        // Room creation: we learn the code from the welcome. Persist it so
        // reconnects rejoin (and Home can navigate to /r/CODE).
        desired.roomCode = msg.room.code;
        desired.sessionToken = msg.sessionToken;
      }
      storeSessionToken(msg.room.code, msg.sessionToken);
      serverApply.welcome(msg);
      break;
    case 'room':
      serverApply.room(msg);
      break;
    case 'update':
      serverApply.update(msg);
      break;
    case 'error':
      serverApply.error(msg);
      break;
    case 'history': {
      // Room-scoped match summaries; persisted locally for the History screen.
      const code = useStore.getState().server.room?.code ?? desired?.roomCode;
      if (code !== undefined) recordRoomHistory(code, msg.matches);
      useStore.getState().setHistory(msg.matches);
      break;
    }
    case 'pong':
      break; // pong only feeds the watchdog above
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Connect (or reconnect) to a room. Omit `roomCode` to create a new room;
 * `config` is the initial room config for creation (preset + overrides) and
 * is ignored by the server when joining an existing room. Idempotent: calling
 * again for the room we are already connected to just triggers a resync.
 */
export function connect(
  roomCode?: string,
  sessionToken?: string,
  nickname?: string,
  config?: ConfigPatch,
): void {
  const code = roomCode?.toUpperCase();
  installWakeHandlers();

  if (
    desired !== null &&
    code !== undefined &&
    desired.roomCode === code &&
    ws !== null &&
    ws.readyState === WebSocket.OPEN
  ) {
    send({ t: 'resync' });
    return;
  }

  const switchingRoom = desired !== null && desired.roomCode !== code;
  intentionalClose = true; // silence the auto-reconnect of the old socket
  ws?.close();
  clearTimers();
  if (switchingRoom) serverApply.reset();
  // A fresh attempt clears any prior dead-end so screens leave the error state.
  serverApply.setFatal(null);

  desired = {
    roomCode: code,
    sessionToken:
      sessionToken ?? (code !== undefined ? (loadSessionToken(code) ?? undefined) : undefined),
    nickname,
    config,
  };
  attempts = 0;
  intentionalClose = false;
  openSocket();
}

/** Tear the connection down on purpose (leaving the room). */
export function disconnect(): void {
  intentionalClose = true;
  clearTimers();
  ws?.close();
  ws = null;
  desired = null;
  serverApply.setConnected(false);
  serverApply.setFatal(null);
}

/**
 * Submit a game action. Returns the generated actionId (also stored as
 * ui.pendingActionId), or null if the socket is down.
 */
export function sendAction(action: PlayerAction): string | null {
  const actionId = crypto.randomUUID();
  const knownSeq = useStore.getState().server.seq;
  if (!send({ t: 'action', actionId, knownSeq, action })) {
    useStore.getState().pushToast({ kind: 'error', code: 'error.notConnected' });
    return null;
  }
  useStore.getState().setPendingAction(actionId);
  return actionId;
}

/** Submit a lobby command. Returns the generated actionId, or null if offline. */
export function sendLobby(cmd: LobbyCmd): string | null {
  const actionId = crypto.randomUUID();
  if (!send({ t: 'lobby', actionId, cmd })) {
    useStore.getState().pushToast({ kind: 'error', code: 'error.notConnected' });
    return null;
  }
  return actionId;
}

/** Ask the server for a fresh full snapshot. */
export function resync(): void {
  send({ t: 'resync' });
}

// ── Wake-from-suspend handling (iOS rule — unconditional) ───────────────────

/**
 * Runs on every visibilitychange→visible and pageshow, unconditionally:
 * if the socket claims to be OPEN, resync AND arm a watchdog — no server
 * traffic within WAKE_WATCHDOG_MS means the socket is a zombie and gets
 * force-closed (auto-reconnect takes over). A dead socket reconnects now.
 */
function onWake(): void {
  if (desired === null) return;
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    send({ t: 'resync' });
    if (wakeWatchdog !== null) clearTimeout(wakeWatchdog);
    wakeWatchdog = setTimeout(() => {
      wakeWatchdog = null;
      ws?.close(); // triggers onclose → scheduleReconnect
    }, WAKE_WATCHDOG_MS);
  } else if (reconnectTimer !== null || ws === null) {
    // Skip the remaining backoff: the user is looking at the screen NOW.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    openSocket();
  }
}

let wakeHandlersInstalled = false;

function installWakeHandlers(): void {
  if (wakeHandlersInstalled || typeof document === 'undefined') return;
  wakeHandlersInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onWake();
  });
  window.addEventListener('pageshow', () => onWake());
}
