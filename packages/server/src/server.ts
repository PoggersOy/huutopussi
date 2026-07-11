/**
 * server.ts — createServer(opts): HTTP (static client + /healthz) + WebSocket
 * /ws endpoint implementing the FROZEN @hp/protocol contract.
 *
 * Flow per accepted action: zod-parse -> idempotency LRU -> engine
 * validateAction -> applyEvent chain persisted in one transaction -> exactly
 * ONE 'update' per recipient (per-seat redactViewFor/redactEventFor).
 * TurnInfo.hints go ONLY to the acting seat (hard security requirement);
 * everyone else — including spectators — gets hints: null.
 *
 * The 'update' event field carries the FIRST event of the chain (the direct
 * echo of the action); clients derive trick/deal completion from the snapshot.
 */
import { randomInt, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import {
  allowedActions,
  applyEvent,
  type Card,
  DEFAULT_RULES,
  expectedActor,
  type GameEvent,
  ILLISOFT_RULES,
  initialMatchState,
  isRuleError,
  type MatchState,
  makeDeck,
  nextDealEvent,
  type PlayerAction,
  type RuleConfig,
  redactEventFor,
  redactViewFor,
  type Seat,
  validateAction,
} from '@hp/engine';
import {
  type ClientMsg,
  type ConfigPatch,
  clientMsgSchema,
  type LobbyCmd,
  PROTOCOL_VERSION,
  type ServerMsg,
  type TurnInfo,
} from '@hp/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { computeBotAction, getBot, getFallbackBot } from './botRunner.js';
import { Db, EVENT_RETENTION_MS } from './db.js';
import {
  allSeatsFilled,
  anyHumanConnected,
  createRoom,
  generateRoomCode,
  hostSessionOf,
  type Room,
  type RoomTableSettings,
  roomPublic,
  sessionAtSeat,
} from './rooms.js';
import {
  createSession,
  isConnected,
  rememberResponse,
  replayCachedResponse,
  type Session,
} from './sessions.js';
import {
  botDelayMs,
  clearAllRoomTimers,
  clearIdleTimer,
  clearTurnTimers,
  DEFAULT_TIMER_CONFIG,
  scheduleNextDeal,
  scheduleTurnExpiry,
  startIdleTimer,
  type TimerConfig,
} from './timers.js';

export interface ServerOpts {
  /** Bind host. Tests bind 127.0.0.1 (the default); prod passes 0.0.0.0. */
  host?: string;
  /** 0 = ephemeral. */
  port?: number;
  dbPath?: string;
  /** Directory of the built client; null = no static serving. */
  staticDir?: string | null;
  timers?: Partial<TimerConfig>;
  /** ws keepalive ping interval in ms; null disables the heartbeat. */
  heartbeatMs?: number | null;
  /** Global cap on concurrent live rooms; creation is refused past it. */
  maxRooms?: number;
  /** Cap on sessions per room; new guest joins are refused past it. */
  maxSessionsPerRoom?: number;
}

export interface HpServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  db: Db;
  /** Live rooms by code — exposed as server truth for tests. */
  rooms: Map<string, Room>;
  listen(): Promise<number>;
  port(): number;
  close(): Promise<void>;
}

const ALL_CARDS: readonly Card[] = makeDeck();

/** Fisher-Yates with node:crypto randomness (the shuffle authority). */
export function cryptoShuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** Lobby preset names -> base rulesets (protocol configPatchSchema.preset). */
const PRESET_RULES: Record<'paamuoto' | 'illisoft', RuleConfig> = {
  paamuoto: DEFAULT_RULES,
  illisoft: ILLISOFT_RULES,
};

type ConfigPatchResult =
  | { ok: true; config: RuleConfig }
  | { ok: false; code: string; params: Record<string, string | number> };

/**
 * Applies a host config patch: `preset` first (resets to the named base
 * ruleset), then the remaining fields on top. Cross-field validity that the
 * per-field zod schema cannot see is enforced on the RESULT; an invalid patch
 * is rejected wholesale (the room config is left untouched).
 */
export function applyConfigPatch(current: RuleConfig, patch: ConfigPatch): ConfigPatchResult {
  const { preset, ...fields } = patch;
  const bad = (field: string): ConfigPatchResult => ({
    ok: false,
    code: 'error.badConfig',
    params: { field },
  });
  const next: RuleConfig = { ...(preset !== undefined ? PRESET_RULES[preset] : current) };
  const nextMut = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) nextMut[key] = value;
  }
  // Koinipakka options exist only in the 2-3p modes...
  if (next.players === 4) {
    if (fields.talonSize !== undefined) return bad('talonSize');
    if (fields.openTalon !== undefined) return bad('openTalon');
  } else if (fields.exchangeCount !== undefined) {
    // ...and the partner exchange only in 4p.
    return bad('exchangeCount');
  }
  if (next.maxBid !== null && next.minBid > next.maxBid) return bad('minBid');
  // Bid bounds must be bidStep-aligned or forced openings/maxBid become unreachable.
  if (next.minBid % next.bidStep !== 0) return bad('minBid');
  if (next.maxBid !== null && next.maxBid % next.bidStep !== 0) return bad('maxBid');
  return { ok: true, config: next };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createServer(opts: ServerOpts = {}): HpServer {
  const cfg: TimerConfig = { ...DEFAULT_TIMER_CONFIG, ...opts.timers };
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? 8080;
  const staticDir = opts.staticDir ?? null;
  const maxRooms = opts.maxRooms ?? 1000;
  const maxSessionsPerRoom = opts.maxSessionsPerRoom ?? 64;
  const db = new Db(opts.dbPath ?? './data/hp.db');

  const rooms = new Map<string, Room>(); // by code
  const roomsById = new Map<string, Room>();
  const sessionsByToken = new Map<string, Session>();
  let serverClosed = false;

  // ── outbound plumbing ───────────────────────────────────────────────────────

  function sendJson(sock: WebSocket, msg: ServerMsg): void {
    if (sock.readyState === 1) sock.send(JSON.stringify(msg));
  }

  function sendTo(session: Session, msg: ServerMsg): void {
    if (session.socket) sendJson(session.socket, msg);
  }

  function respondError(
    session: Session,
    refActionId: string | undefined,
    code: string,
    params?: Record<string, string | number>,
  ): void {
    const msg: ServerMsg = {
      t: 'error',
      code,
      ...(refActionId !== undefined ? { refActionId } : {}),
      ...(params !== undefined ? { params } : {}),
    };
    const json = JSON.stringify(msg);
    if (refActionId !== undefined) rememberResponse(session, refActionId, json);
    if (session.socket && session.socket.readyState === 1) session.socket.send(json);
  }

  function buildTurnInfo(room: Room, forSeat: Seat | null): TurnInfo | null {
    const state = room.match;
    if (!state || room.status !== 'playing') return null;
    const actor = expectedActor(state);
    if (actor === null) return null;
    // deadline may be null (autoplay off → no limit); turn/hints ride on the
    // actor, NOT on the deadline, so a present player always gets their hints.
    return {
      seat: actor,
      deadline: room.turnDeadline,
      // Hidden-info rule: hints ONLY to the acting seat itself.
      hints: forSeat === actor ? allowedActions(state, actor) : null,
    };
  }

  /** RoomStatePublic broadcast on every lobby change. */
  function broadcastRoom(room: Room, origin?: { token: string; actionId: string }): void {
    room.seq += 1;
    const msg: ServerMsg = { t: 'room', seq: room.seq, room: roomPublic(room) };
    const json = JSON.stringify(msg);
    for (const s of room.sessions.values()) {
      if (origin && s.token === origin.token) rememberResponse(s, origin.actionId, json);
      if (isConnected(s) && s.socket) s.socket.send(json);
    }
  }

  /** ONE 'update' per recipient, per-seat redaction, hints to actor only. */
  function broadcastUpdate(
    room: Room,
    trigger: GameEvent | null,
    options: { includeRoom?: boolean; origin?: { token: string; actionId: string } } = {},
  ): void {
    const state = room.match;
    if (!state) return;
    const actor = room.status === 'playing' ? expectedActor(state) : null;
    const actorHints = actor !== null ? allowedActions(state, actor) : null;
    const pub = options.includeRoom ? roomPublic(room) : null;
    for (const s of room.sessions.values()) {
      const isOrigin = options.origin !== undefined && s.token === options.origin.token;
      const connected = isConnected(s);
      if (!connected && !isOrigin) continue;
      const viewer = s.seat ?? ('spectator' as const);
      // turn/hints ride on the actor, not the deadline (which is null when the
      // room has autoplay off — a present player still needs their hints).
      const turn: TurnInfo | null =
        actor === null
          ? null
          : {
              seat: actor,
              deadline: room.turnDeadline,
              hints: s.seat === actor ? actorHints : null,
            };
      const msg: ServerMsg = {
        t: 'update',
        seq: room.seq,
        view: redactViewFor(state, viewer),
        event: trigger ? redactEventFor(trigger, viewer) : null,
        turn,
        ...(pub ? { room: pub } : {}),
      };
      const json = JSON.stringify(msg);
      if (isOrigin && options.origin) rememberResponse(s, options.origin.actionId, json);
      if (connected && s.socket) s.socket.send(json);
    }
  }

  function sendHistory(room: Room): void {
    const msg: ServerMsg = { t: 'history', matches: db.matchSummaries(room.id) };
    for (const s of room.sessions.values()) sendTo(s, msg);
  }

  // ── turn/timer orchestration ────────────────────────────────────────────────

  /** Reconnected humans reclaim their seat at the next turn boundary. */
  function processReclaims(room: Room): boolean {
    let changed = false;
    for (const s of room.sessions.values()) {
      if (!s.reclaimPending) continue;
      s.reclaimPending = false;
      if (s.botControlled && isConnected(s)) {
        s.botControlled = false;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The present-human turn budget in ms, or null when the room has autoplay off
   * (a present player then has unlimited time). The awaitWholeAnswer binary
   * choice keeps its short cap, but never longer than the configured budget.
   */
  function humanTurnBudgetMs(room: Room, state: MatchState): number | null {
    const ts = room.tableSettings;
    if (!ts.autoplay) return null;
    return state.deal?.phase.name === 'awaitWholeAnswer'
      ? Math.min(ts.turnTimeoutMs, cfg.wholeAnswerMs)
      : ts.turnTimeoutMs;
  }

  /**
   * Reconnect grace for a DISCONNECTED actor: at least one full turn budget
   * (host-editable) so a dropped player always has a turn's worth of time to
   * come back, never below the configured floor. See timers.ts.
   */
  function reconnectGraceMs(room: Room): number {
    return Math.max(cfg.graceMs, room.tableSettings.turnTimeoutMs);
  }

  function updateTurn(room: Room): void {
    clearTurnTimers(room);
    room.turnDeadline = null;
    const state = room.match;
    if (room.closed || !state || room.status !== 'playing' || state.winnerSide !== null) return;
    const actor = expectedActor(state);
    if (actor === null) return;
    const s = sessionAtSeat(room, actor);
    if (!s || s.kind === 'bot' || s.botControlled) {
      // Bot seats and away seats always play (autoplay governs PRESENT humans).
      scheduleBotAct(room, actor);
      return;
    }
    const budget = humanTurnBudgetMs(room, state);
    if (!isConnected(s)) {
      // Disconnected human: give them at least a full turn to reconnect before
      // autoplay, even when autoplay is off, so one dropped player can't freeze
      // the table.
      const ms = reconnectGraceMs(room);
      room.turnDeadline = Date.now() + ms;
      scheduleTurnExpiry(room, ms, () => onTurnExpired(room, actor));
      return;
    }
    if (budget === null) return; // autoplay off: a present player has unlimited time.
    room.turnDeadline = Date.now() + budget;
    scheduleTurnExpiry(room, budget, () => onTurnExpired(room, actor));
  }

  function onTurnExpired(room: Room, seat: Seat): void {
    if (room.closed || room.status !== 'playing' || !room.match) return;
    if (expectedActor(room.match) !== seat) return;
    const s = sessionAtSeat(room, seat);
    if (s && s.kind === 'human' && !s.botControlled) {
      // Mark the seat away/botControlled and let the bot runner act.
      s.botControlled = true;
      s.reclaimPending = false;
      broadcastRoom(room);
    }
    scheduleBotAct(room, seat);
  }

  function scheduleBotAct(room: Room, seat: Seat): void {
    if (room.botPending === seat && room.timers.bot) return;
    if (room.timers.bot) clearTimeout(room.timers.bot);
    room.botPending = seat;
    room.timers.bot = setTimeout(() => {
      room.timers.bot = null;
      room.botPending = null;
      void runBotTurn(room, seat);
    }, botDelayMs(cfg));
  }

  async function runBotTurn(room: Room, seat: Seat): Promise<void> {
    try {
      if (room.closed || room.status !== 'playing' || !room.match) return;
      if (expectedActor(room.match) !== seat) return;
      const s = sessionAtSeat(room, seat);
      if (!s) return;
      if (s.kind === 'human' && !s.botControlled) return; // reclaimed meanwhile
      const before = room.eventSeq;
      s.bot ??= getBot();
      const action = await computeBotAction(room.match, seat, s.bot);
      // State may have moved while an async bot was thinking.
      if (room.closed || !room.match || room.eventSeq !== before) return;
      if (expectedActor(room.match) !== seat) return;
      // A present human may have reclaimed the seat during the think delay.
      if (s.kind === 'human' && !s.botControlled) return;
      if (submitAction(room, s, randomUUID(), action)) return;
      // Hint/validate mismatch would be an engine bug — retry once with the
      // always-legal fallback bot so the match never stalls.
      const retry = await computeBotAction(room.match, seat, getFallbackBot());
      if (room.closed || !room.match || room.eventSeq !== before) return;
      if (expectedActor(room.match) !== seat) return;
      if (s.kind === 'human' && !s.botControlled) return;
      if (!submitAction(room, s, randomUUID(), retry)) {
        console.error(`[server] bot action rejected twice for seat ${seat} in room ${room.code}`);
      }
    } catch (err) {
      console.error('[server] bot turn failed', err);
    }
  }

  function armIdleTimerIfEmpty(room: Room): void {
    if (room.closed || anyHumanConnected(room)) return;
    startIdleTimer(room, cfg.idleCloseMs, () => closeRoom(room));
  }

  /** Zero connected humans for idleCloseMs: persist as abandoned, close. */
  function closeRoom(room: Room): void {
    if (room.closed) return;
    room.closed = true;
    clearAllRoomTimers(room);
    if (room.matchId && room.status === 'playing') db.abandonMatch(room.matchId);
    db.setRoomStatus(room.id, 'closed');
    for (const s of room.sessions.values()) {
      sessionsByToken.delete(s.token);
      if (s.socket) {
        try {
          s.socket.close(4000, 'room closed');
        } catch {
          // already dead
        }
      }
    }
    rooms.delete(room.code);
    roomsById.delete(room.id);
  }

  // ── game flow ───────────────────────────────────────────────────────────────

  /**
   * Applies an already-validated event chain: persist in ONE transaction,
   * update state, then broadcast exactly one 'update' per recipient.
   * Throws only on engine-bug assertions (caller catches).
   */
  function applyAndBroadcast(
    room: Room,
    events: GameEvent[],
    origin?: { token: string; actionId: string },
    forceRoom = false,
  ): void {
    const matchId = room.matchId;
    const current = room.match;
    if (!matchId || !current) throw new Error('applyAndBroadcast without an active match');
    let state = current;
    for (const e of events) state = applyEvent(state, e);
    const base = room.eventSeq;
    db.transaction(() => {
      events.forEach((e, i) => {
        db.appendEvent(matchId, base + i + 1, e);
        if (e.type === 'dealScored') {
          db.recordDealResult(matchId, state.dealIndex, state.dealer, e.result);
        }
        if (e.type === 'matchEnded') {
          db.finishMatch(matchId, e.winnerSide, state.scores);
        }
      });
    });
    room.eventSeq = base + events.length;
    room.match = state;

    let includeRoom = forceRoom;
    if (state.winnerSide !== null && room.status !== 'finished') {
      room.status = 'finished';
      db.setRoomStatus(room.id, 'finished');
      includeRoom = true;
    }
    if (processReclaims(room)) includeRoom = true;
    updateTurn(room);
    room.seq += 1;
    broadcastUpdate(room, events[0] ?? null, {
      includeRoom,
      ...(origin ? { origin } : {}),
    });

    if (state.winnerSide !== null) {
      sendHistory(room);
    } else if (state.deal === null) {
      // Redeal demanded: author a fresh deal shortly.
      scheduleNextDeal(room, cfg.redealDelayMs, () => authorNextDeal(room));
    } else if (state.deal.phase.name === 'scored') {
      scheduleNextDeal(room, cfg.nextDealDelayMs, () => authorNextDeal(room));
    }
  }

  /** Server-authored dealStarted with a crypto-shuffled deck. */
  function authorNextDeal(room: Room): void {
    if (room.closed || room.status !== 'playing') return;
    const state = room.match;
    if (!state || state.winnerSide !== null) return;
    if (state.deal !== null && state.deal.phase.name !== 'scored') return;
    try {
      applyAndBroadcast(room, [nextDealEvent(state, cryptoShuffle(ALL_CARDS))]);
    } catch (err) {
      console.error(`[server] failed to author next deal in room ${room.code}`, err);
    }
  }

  function startNewMatch(room: Room, origin: { token: string; actionId: string }): void {
    const firstDealer = randomInt(room.config.players) as Seat;
    const matchId = randomUUID();
    room.match = initialMatchState(room.config, firstDealer);
    room.matchId = matchId;
    room.eventSeq = 0;
    room.status = 'playing';
    db.transaction(() => {
      db.createMatch({ id: matchId, roomId: room.id, config: room.config, firstDealer });
      db.setRoomStatus(room.id, 'playing');
    });
    try {
      applyAndBroadcast(room, [nextDealEvent(room.match, cryptoShuffle(ALL_CARDS))], origin, true);
    } catch (err) {
      console.error(`[server] failed to start match in room ${room.code}`, err);
      respondError(
        room.sessions.get(origin.token) ?? createDetachedSession(),
        origin.actionId,
        'error.internal',
      );
    }
  }

  function createDetachedSession(): Session {
    return createSession({ token: '', roomId: '', seat: null, nickname: null, kind: 'human' });
  }

  /**
   * Drop a detached, UNSEATED human guest/spectator session (left behind by a
   * socket close or a re-hello on the same socket). Seated sessions are kept —
   * they hold a seat and may be reclaimed on reconnect — but unseated guests
   * would otherwise pile up in `room.sessions` / `sessionsByToken` / the db
   * until idle-close, since guests mint a fresh token every join and rarely
   * resend one. Bounds memory, sqlite rows and per-event broadcast fan-out.
   */
  function discardDetachedSession(session: Session): void {
    if (session.seat !== null || session.kind !== 'human') return;
    const room = roomsById.get(session.roomId);
    room?.sessions.delete(session.token);
    sessionsByToken.delete(session.token);
    db.deleteSession(session.token);
  }

  /**
   * A human takes their seat back from the fill-in bot (by acting, or on
   * reconnect). Clears the away flag and, if it is still their turn, cancels the
   * scheduled bot move and re-arms a FULL fresh turn budget — a returning player
   * always gets their whole think time, never the tail of the bot's clock (an
   * in-flight bot move aborts on the cleared flag; see runBotTurn). Returns true
   * if a turn was re-armed; broadcasting is left to the caller.
   */
  function reclaimSeat(room: Room, session: Session): boolean {
    if (session.kind !== 'human' || !session.botControlled) return false;
    session.botControlled = false;
    session.reclaimPending = false;
    if (
      room.status === 'playing' &&
      room.match !== null &&
      room.match.winnerSide === null &&
      expectedActor(room.match) === session.seat
    ) {
      updateTurn(room);
      return true;
    }
    return false;
  }

  /**
   * In-band seat reclaim (docs/plan.md §Reconnection — "instant reclaim"): a
   * connected human acting on their own seat takes it back from the fill-in
   * bot immediately. Without this a present-but-idle human who was passed to a
   * bot on one slow turn could never regain control — they stay connected and
   * so never send a second `hello`, the only other path that clears
   * botControlled. Only genuine human WS actions reach here (bot moves go
   * straight to submitAction), so the fill-in bot's own moves never self-clear.
   */
  function reclaimSeatOnAction(room: Room, session: Session): void {
    if (session.kind !== 'human' || !session.botControlled) return;
    reclaimSeat(room, session);
    broadcastRoom(room);
  }

  /** The single action pipeline (WS actions, bot moves, autoplay all land here). */
  function submitAction(
    room: Room,
    session: Session,
    actionId: string,
    action: PlayerAction,
  ): boolean {
    if (room.status !== 'playing' || !room.match || !room.matchId) {
      respondError(session, actionId, 'error.noMatch');
      return false;
    }
    if (session.seat === null) {
      respondError(session, actionId, 'error.notSeated');
      return false;
    }
    const res = validateAction(room.match, session.seat, action);
    if (isRuleError(res)) {
      respondError(session, actionId, res.code, res.params);
      return false;
    }
    try {
      applyAndBroadcast(room, res, { token: session.token, actionId });
      return true;
    } catch (err) {
      console.error(`[server] apply failed in room ${room.code}`, err);
      respondError(session, actionId, 'error.internal');
      return false;
    }
  }

  // ── lobby commands ──────────────────────────────────────────────────────────

  /** Returns false when the command was refused (an error was sent). */
  function handleLobby(session: Session, actionId: string, cmd: LobbyCmd): boolean {
    const room = roomsById.get(session.roomId);
    if (!room || room.closed) {
      respondError(session, actionId, 'error.roomNotFound');
      return false;
    }
    const fail = (code: string, params?: Record<string, string | number>): boolean => {
      respondError(session, actionId, code, params);
      return false;
    };
    const isHost = hostSessionOf(room)?.token === session.token;
    const seatsLocked = room.status === 'playing';

    switch (cmd.type) {
      case 'takeSeat': {
        if (seatsLocked) return fail('error.matchInProgress');
        if (cmd.seat >= room.config.players) return fail('error.badSeat');
        if (sessionAtSeat(room, cmd.seat)) return fail('error.seatTaken');
        session.seat = cmd.seat;
        db.saveSession(sessionRow(session));
        broadcastRoom(room, { token: session.token, actionId });
        return true;
      }
      case 'leaveSeat': {
        if (seatsLocked) return fail('error.matchInProgress');
        if (session.seat === null) return fail('error.notSeated');
        session.seat = null;
        db.saveSession(sessionRow(session));
        broadcastRoom(room, { token: session.token, actionId });
        return true;
      }
      case 'setNickname': {
        session.nickname = cmd.nickname;
        db.saveSession(sessionRow(session));
        broadcastRoom(room, { token: session.token, actionId });
        return true;
      }
      case 'addBot': {
        if (!isHost) return fail('error.notHost');
        if (seatsLocked) return fail('error.matchInProgress');
        if (cmd.seat >= room.config.players) return fail('error.badSeat');
        if (sessionAtSeat(room, cmd.seat)) return fail('error.seatTaken');
        const bot = createSession({
          token: randomUUID(),
          roomId: room.id,
          seat: cmd.seat,
          nickname: null,
          kind: 'bot',
        });
        room.sessions.set(bot.token, bot);
        sessionsByToken.set(bot.token, bot);
        db.saveSession(sessionRow(bot));
        broadcastRoom(room, { token: session.token, actionId });
        return true;
      }
      case 'removeBot': {
        if (!isHost) return fail('error.notHost');
        if (seatsLocked) return fail('error.matchInProgress');
        const bot = sessionAtSeat(room, cmd.seat);
        if (!bot || bot.kind !== 'bot') return fail('error.noBotAtSeat');
        room.sessions.delete(bot.token);
        sessionsByToken.delete(bot.token);
        db.deleteSession(bot.token);
        broadcastRoom(room, { token: session.token, actionId });
        return true;
      }
      case 'setConfig': {
        if (!isHost) return fail('error.notHost');
        if (seatsLocked) return fail('error.matchInProgress');
        const applied = applyConfigPatch(room.config, cmd.patch);
        if (!applied.ok) return fail(applied.code, applied.params);
        room.config = applied.config;
        evictInactiveSeats(room);
        db.setRoomConfig(room.id, room.config);
        broadcastRoom(room, { token: session.token, actionId });
        return true;
      }
      case 'setTableSettings': {
        // Turn pacing is not a game rule, so (unlike setConfig) it may change
        // mid-match. The wire patch is in seconds; the room stores ms.
        if (!isHost) return fail('error.notHost');
        const cur = room.tableSettings;
        const next: RoomTableSettings = {
          autoplay: cmd.patch.autoplay ?? cur.autoplay,
          turnTimeoutMs:
            cmd.patch.turnTimeoutSec !== undefined
              ? cmd.patch.turnTimeoutSec * 1000
              : cur.turnTimeoutMs,
        };
        room.tableSettings = next;
        db.setRoomTableSettings(room.id, next);
        if (room.status === 'playing') {
          // Re-arm the live turn so the new timeout / autoplay toggle takes
          // effect at once, and push the fresh deadline to every countdown.
          updateTurn(room);
          room.seq += 1;
          broadcastUpdate(room, null, {
            includeRoom: true,
            origin: { token: session.token, actionId },
          });
        } else {
          broadcastRoom(room, { token: session.token, actionId });
        }
        return true;
      }
      case 'startMatch': {
        if (!isHost) return fail('error.notHost');
        if (room.status !== 'lobby') return fail('error.matchInProgress');
        if (!allSeatsFilled(room)) return fail('error.seatsNotFilled');
        startNewMatch(room, { token: session.token, actionId });
        return true;
      }
      case 'rematch': {
        if (!isHost) return fail('error.notHost');
        if (room.status !== 'finished') return fail('error.matchNotFinished');
        startNewMatch(room, { token: session.token, actionId });
        return true;
      }
      case 'stopMatch': {
        // Host aborts an ongoing match: abandon it and close the room, which
        // drops every client (WS close 4000 → each lands on the "room closed"
        // dead-end and can go Home). closeRoom persists the match as abandoned.
        if (!isHost) return fail('error.notHost');
        if (room.status !== 'playing') return fail('error.noMatch');
        closeRoom(room);
        return true;
      }
    }
  }

  function sessionRow(s: Session) {
    return { token: s.token, roomId: s.roomId, seat: s.seat, nickname: s.nickname, kind: s.kind };
  }

  /**
   * After a mode shrink (players 4 -> 3/2), seats >= config.players no longer
   * exist: bots there are removed, humans are unseated back to guests. The 2p
   * dummy hand is NOT a seat — nothing ever occupies seats 2..3 in 2p mode.
   */
  function evictInactiveSeats(room: Room): void {
    for (const s of [...room.sessions.values()]) {
      if (s.seat === null || s.seat < room.config.players) continue;
      if (s.kind === 'bot') {
        room.sessions.delete(s.token);
        sessionsByToken.delete(s.token);
        db.deleteSession(s.token);
      } else {
        s.seat = null;
        db.saveSession(sessionRow(s));
      }
    }
  }

  // ── hello / welcome / resync ────────────────────────────────────────────────

  function sendWelcome(session: Session, room: Room): void {
    const msg: ServerMsg = {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      sessionToken: session.token,
      room: roomPublic(room),
      seat: session.seat,
      seq: room.seq,
      view: room.match ? redactViewFor(room.match, session.seat ?? 'spectator') : null,
      turn: buildTurnInfo(room, session.seat),
    };
    sendTo(session, msg);
  }

  function bindSocket(session: Session, sock: WebSocket, room: Room): void {
    // Last-connect-wins: replace any previous socket.
    const old = session.socket;
    if (old && old !== sock) {
      sendJson(old, { t: 'error', code: 'error.sessionReplaced' });
      session.socket = null;
      try {
        old.close(4001, 'replaced');
      } catch {
        // ignore
      }
    }
    session.socket = sock;
    clearIdleTimer(room);
  }

  function handleHello(
    sock: WebSocket,
    msg: Extract<ClientMsg, { t: 'hello' }>,
    setBound: (s: Session) => void,
  ): void {
    if (msg.v !== PROTOCOL_VERSION) {
      sendJson(sock, {
        t: 'error',
        code: 'error.protocolVersion',
        params: { expected: PROTOCOL_VERSION, got: msg.v },
      });
      sock.close(4002, 'protocol version mismatch');
      return;
    }

    // Resume an existing session (reconnect), last-connect-wins.
    if (msg.sessionToken !== undefined) {
      const existing = sessionsByToken.get(msg.sessionToken);
      if (existing && existing.kind === 'human') {
        const room = roomsById.get(existing.roomId);
        if (room && !room.closed && (msg.roomCode === undefined || msg.roomCode === room.code)) {
          if (msg.nickname !== undefined) {
            existing.nickname = msg.nickname;
            db.saveSession(sessionRow(existing));
          }
          bindSocket(existing, sock, room);
          setBound(existing);
          // A returning player takes their seat back from the fill-in bot at
          // once — even mid-turn — and, if it's their turn, gets a full fresh
          // turn budget to think (never the tail of the bot's clock).
          const rearmed = existing.botControlled ? reclaimSeat(room, existing) : false;
          sendWelcome(existing, room);
          if (rearmed) {
            // Push the cleared away-flag AND the fresh deadline to everyone so
            // their badges + countdowns stay in sync (welcome already told the
            // returner).
            room.seq += 1;
            broadcastUpdate(room, null, { includeRoom: true });
          } else if (existing.seat !== null) {
            broadcastRoom(room); // connected flag changed
          }
          return;
        }
      }
      // Unknown/stale token: fall through and treat as a fresh hello.
    }

    if (msg.roomCode !== undefined) {
      // Join an existing room as a guest (seat null until takeSeat).
      const room = rooms.get(msg.roomCode);
      if (!room || room.closed) {
        sendJson(sock, { t: 'error', code: 'error.roomNotFound' });
        sock.close(4004, 'room not found');
        return;
      }
      if (room.sessions.size >= maxSessionsPerRoom) {
        sendJson(sock, { t: 'error', code: 'error.roomFull' });
        sock.close(4006, 'room full');
        return;
      }
      const session = createSession({
        token: randomUUID(),
        roomId: room.id,
        seat: null,
        nickname: msg.nickname ?? null,
        kind: 'human',
      });
      room.sessions.set(session.token, session);
      sessionsByToken.set(session.token, session);
      db.saveSession(sessionRow(session));
      bindSocket(session, sock, room);
      setBound(session);
      sendWelcome(session, room);
      return;
    }

    // No roomCode: create a room with the creator seated at 0 as host. The
    // optional hello config is applied like a lobby setConfig patch on top of
    // the default ruleset; an invalid patch refuses room creation (the client
    // may re-hello).
    if (rooms.size >= maxRooms) {
      // Global room cap: refuse new-room creation so an unauthenticated client
      // can't spin up unbounded rooms (each persists a Room + Session to disk).
      sendJson(sock, { t: 'error', code: 'error.serverBusy' });
      return;
    }
    let config = defaultConfig();
    if (msg.config !== undefined) {
      const applied = applyConfigPatch(config, msg.config);
      if (!applied.ok) {
        sendJson(sock, { t: 'error', code: applied.code, params: applied.params });
        return;
      }
      config = applied.config;
    }
    const roomId = randomUUID();
    const code = generateRoomCode((c) => rooms.has(c));
    const session = createSession({
      token: randomUUID(),
      roomId,
      seat: 0,
      nickname: msg.nickname ?? null,
      kind: 'human',
    });
    const room = createRoom({
      id: roomId,
      code,
      hostToken: session.token,
      config,
      tableSettings: defaultTableSettings(),
    });
    room.sessions.set(session.token, session);
    sessionsByToken.set(session.token, session);
    rooms.set(code, room);
    roomsById.set(roomId, room);
    db.transaction(() => {
      db.createRoom({
        id: roomId,
        code,
        hostToken: session.token,
        config: room.config,
        tableSettings: room.tableSettings,
      });
      db.saveSession(sessionRow(session));
    });
    bindSocket(session, sock, room);
    setBound(session);
    sendWelcome(session, room);
  }

  function defaultConfig(): RuleConfig {
    // The product plays illisoft rules by default (spec §11); päämuoto stays
    // selectable via the lobby preset. Fresh object so per-room patches never
    // share state.
    return { ...ILLISOFT_RULES };
  }

  /**
   * A fresh room's turn pacing: autoplay on, budget = the server default turnMs
   * (90 s in prod; tests inject sub-second turnMs here). Host-editable from the
   * lobby; the wire form exposes whole seconds.
   */
  function defaultTableSettings(): RoomTableSettings {
    return { autoplay: true, turnTimeoutMs: cfg.turnMs };
  }

  function handleResync(session: Session): void {
    const room = roomsById.get(session.roomId);
    if (!room || room.closed) return;
    if (room.match) {
      const msg: ServerMsg = {
        t: 'update',
        seq: room.seq,
        view: redactViewFor(room.match, session.seat ?? 'spectator'),
        event: null,
        turn: buildTurnInfo(room, session.seat),
        room: roomPublic(room),
      };
      sendTo(session, msg);
    } else {
      sendTo(session, { t: 'room', seq: room.seq, room: roomPublic(room) });
    }
  }

  // ── socket lifecycle ────────────────────────────────────────────────────────

  function onSocketClosed(session: Session, sock: WebSocket): void {
    if (session.socket !== sock) return; // already replaced (last-connect-wins)
    session.socket = null;
    const room = roomsById.get(session.roomId);
    if (!room || room.closed) return;
    if (session.seat === null) {
      // Unseated guest/spectator disconnect: nothing to hold, so drop the dead
      // session instead of letting it linger until idle-close.
      discardDetachedSession(session);
      armIdleTimerIfEmpty(room);
      return;
    }
    broadcastRoom(room); // connected flag changed
    // Mid-turn disconnect: guarantee at least a full turn to reconnect before
    // autoplay (reconnectGraceMs). When the room has autoplay off the present
    // actor had no deadline (unlimited time); arm grace anyway so one dropped
    // player can't freeze the table. A finite deadline further out than grace
    // is kept (don't shorten a live turn).
    if (
      room.status === 'playing' &&
      room.match &&
      session.seat !== null &&
      !session.botControlled &&
      expectedActor(room.match) === session.seat
    ) {
      const grace = reconnectGraceMs(room);
      const minDeadline = Date.now() + grace;
      if (room.turnDeadline === null || room.turnDeadline < minDeadline) {
        room.turnDeadline = minDeadline;
        const seat = session.seat;
        scheduleTurnExpiry(room, grace, () => onTurnExpired(room, seat));
      }
    }
    armIdleTimerIfEmpty(room);
  }

  function handleMessage(sock: WebSocket, raw: unknown, ctx: { session: Session | null }): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      sendJson(sock, { t: 'error', code: 'error.badMessage' });
      return;
    }
    const result = clientMsgSchema.safeParse(parsed);
    if (!result.success) {
      sendJson(sock, { t: 'error', code: 'error.badMessage' });
      return;
    }
    const msg = result.data;

    if (msg.t === 'hello') {
      // Re-hello on a bound socket detaches the previous session first.
      if (ctx.session && ctx.session.socket === sock) {
        const prev = ctx.session;
        ctx.session = null;
        prev.socket = null;
        const prevRoom = roomsById.get(prev.roomId);
        // An unseated guest left behind by the re-hello is garbage — drop it so
        // repeated re-hellos can't accumulate dead sessions in the room.
        discardDetachedSession(prev);
        if (prevRoom && !prevRoom.closed && prev.seat !== null) broadcastRoom(prevRoom);
        if (prevRoom) armIdleTimerIfEmpty(prevRoom);
      }
      handleHello(sock, msg, (s) => {
        ctx.session = s;
      });
      return;
    }

    const session = ctx.session;
    if (!session) {
      sendJson(sock, { t: 'error', code: 'error.helloFirst' });
      return;
    }

    switch (msg.t) {
      case 'action': {
        if (replayCachedResponse(session, msg.actionId)) return;
        const room = roomsById.get(session.roomId);
        if (!room || room.closed) {
          respondError(session, msg.actionId, 'error.roomNotFound');
          return;
        }
        // A connected human who acts reclaims their seat from the fill-in bot.
        reclaimSeatOnAction(room, session);
        submitAction(room, session, msg.actionId, msg.action);
        return;
      }
      case 'lobby': {
        if (replayCachedResponse(session, msg.actionId)) return;
        handleLobby(session, msg.actionId, msg.cmd);
        return;
      }
      case 'resync':
        handleResync(session);
        return;
      case 'ping':
        sendJson(sock, { t: 'pong' });
        return;
    }
  }

  // ── HTTP: healthz + static client (SPA fallback for /r/*) ──────────────────

  function serveStatic(pathname: string, res: http.ServerResponse): void {
    if (!staticDir) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const dir = resolve(staticDir);
    const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = join(dir, safe);
    if (!filePath.startsWith(dir)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (pathname === '/' || pathname === '') filePath = join(dir, 'index.html');
    fs.stat(filePath, (err, st) => {
      if (!err && st.isFile()) {
        streamFile(filePath, res);
        return;
      }
      // SPA fallback: room links (/r/CODE) and the root serve index.html.
      if (pathname === '/' || pathname.startsWith('/r/')) {
        streamFile(join(dir, 'index.html'), res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  }

  function streamFile(filePath: string, res: http.ServerResponse): void {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    });
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // A lone/incomplete percent-escape (e.g. `/%`, `/%zz`, `/foo%`) makes
      // decodeURIComponent throw URIError synchronously here. Left uncaught it
      // takes down the whole process (Node default on uncaughtException), so a
      // single unauthenticated `GET /%` could drop every live room. 400 it.
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    serveStatic(pathname, res);
  });

  // ── WebSocket endpoint at /ws ───────────────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  interface SocketState {
    session: Session | null;
    isAlive: boolean;
  }
  const socketStates = new Map<WebSocket, SocketState>();

  wss.on('connection', (sock: WebSocket) => {
    const ctx: SocketState = { session: null, isAlive: true };
    socketStates.set(sock, ctx);
    sock.on('pong', () => {
      ctx.isAlive = true;
    });
    sock.on('message', (data) => {
      try {
        handleMessage(sock, data, ctx);
      } catch (err) {
        console.error('[server] message handling failed', err);
        sendJson(sock, { t: 'error', code: 'error.internal' });
      }
    });
    sock.on('close', () => {
      socketStates.delete(sock);
      if (ctx.session) onSocketClosed(ctx.session, sock);
    });
    sock.on('error', () => {
      // 'close' follows; never crash on socket errors.
    });
  });

  const heartbeatMs = opts.heartbeatMs === undefined ? 15_000 : opts.heartbeatMs;
  const heartbeat =
    heartbeatMs === null
      ? null
      : setInterval(() => {
          for (const [sock, st] of socketStates) {
            if (!st.isAlive) {
              sock.terminate();
              continue;
            }
            st.isAlive = false;
            try {
              sock.ping();
            } catch {
              sock.terminate();
            }
          }
        }, heartbeatMs);

  // ── boot: crash recovery + event pruning (plan §Persistence) ───────────────

  function recoverActiveMatches(): void {
    for (const rec of db.activeMatches()) {
      if (roomsById.has(rec.roomId)) {
        // A newer active match for this room was already recovered.
        db.abandonMatch(rec.matchId);
        continue;
      }
      let state = initialMatchState(rec.matchConfig, rec.firstDealer);
      try {
        for (const e of rec.events) state = applyEvent(state, e);
      } catch (err) {
        console.error(`[server] recovery replay failed for match ${rec.matchId}`, err);
        db.abandonMatch(rec.matchId);
        continue;
      }
      const room = createRoom({
        id: rec.roomId,
        code: rec.code,
        hostToken: rec.hostToken,
        config: rec.roomConfig,
        // Rooms persisted before the table-settings column recover with the
        // current server default (autoplay on, default budget).
        tableSettings: rec.tableSettings ?? defaultTableSettings(),
      });
      room.status = 'playing';
      room.match = state;
      room.matchId = rec.matchId;
      room.eventSeq = rec.eventSeq;
      room.seq = rec.eventSeq;
      for (const sr of rec.sessions) {
        // All seats start disconnected; the reconnect flow handles the rest.
        const session = createSession(sr);
        room.sessions.set(session.token, session);
        sessionsByToken.set(session.token, session);
      }
      if (state.winnerSide !== null) {
        // Crash happened after the final event but before finalize: finish now.
        db.finishMatch(rec.matchId, state.winnerSide, state.scores);
        room.status = 'finished';
        db.setRoomStatus(room.id, 'finished');
      }
      rooms.set(room.code, room);
      roomsById.set(room.id, room);
      updateTurn(room);
      if (room.status === 'playing') {
        if (state.deal === null) {
          scheduleNextDeal(room, cfg.redealDelayMs, () => authorNextDeal(room));
        } else if (state.deal.phase.name === 'scored') {
          scheduleNextDeal(room, cfg.nextDealDelayMs, () => authorNextDeal(room));
        }
      }
      armIdleTimerIfEmpty(room);
    }
  }

  db.pruneOldEvents(Date.now() - EVENT_RETENTION_MS);
  recoverActiveMatches();

  // ── lifecycle ───────────────────────────────────────────────────────────────

  let boundPort = 0;

  return {
    httpServer,
    wss,
    db,
    rooms,
    port: () => boundPort,
    listen(): Promise<number> {
      return new Promise((resolvePort, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(requestedPort, host, () => {
          const addr = httpServer.address();
          boundPort = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
          resolvePort(boundPort);
        });
      });
    },
    async close(): Promise<void> {
      if (serverClosed) return;
      serverClosed = true;
      if (heartbeat) clearInterval(heartbeat);
      // Simulated-crash semantics: do NOT mark matches abandoned — boot-time
      // recovery replays them (fly deploy must not kill games).
      for (const room of roomsById.values()) {
        room.closed = true;
        clearAllRoomTimers(room);
      }
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => {
        wss.close(() => r());
      });
      await new Promise<void>((r) => {
        httpServer.close(() => r());
        // Resolve even if never listening.
        if (!httpServer.listening) r();
      });
      db.close();
    },
  };
}
