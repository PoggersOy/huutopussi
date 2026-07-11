/**
 * Test plumbing: a scripted WS client that speaks the @hp/protocol contract,
 * plus a deterministic hint-driven auto-player (forced opener bids minimum,
 * everyone else passes, exchanges/discards/plays first legal option, never
 * declares). With `openBid` the driver opens an untouched auction at the hint
 * minimum — under rulesets without a forced opening (illisoft) that guarantees
 * the deal gets a declarer and the exchange/koini phases run.
 */
import { randomUUID } from 'node:crypto';
import type { ActionHint, Card, PlayerAction, PlayerView, Seat } from '@hp/engine';
import {
  type ClientMsg,
  type ConfigPatch,
  type LobbyCmd,
  PROTOCOL_VERSION,
  type ServerMsg,
  type TurnInfo,
} from '@hp/protocol';
import { WebSocket } from 'ws';

type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;
type UpdateMsg = Extract<ServerMsg, { t: 'update' }>;

interface Waiter {
  pred: (msg: ServerMsg) => boolean;
  resolve: (msg: ServerMsg) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TestClient {
  readonly messages: ServerMsg[] = [];
  seat: Seat | null = null;
  token = '';
  roomCode = '';
  seq = 0;
  lastView: PlayerView | null = null;
  lastTurn: TurnInfo | null = null;
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private waiters: Waiter[] = [];
  private closeWaiters: Array<(code: number) => void> = [];
  private readonly listeners: Array<(msg: ServerMsg) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.onMessage(JSON.parse(String(data)) as ServerMsg);
    });
    ws.on('close', (code: number) => {
      this.closeCode = code;
      for (const resolve of this.closeWaiters) resolve(code);
      this.closeWaiters = [];
    });
    ws.on('error', () => {
      // terminated sockets etc. — tests handle outcomes via messages
    });
  }

  /** Resolves with the WS close code (e.g. 4000 for a closed room). */
  waitClose(timeoutMs = 10_000, what = 'socket close'): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  private onMessage(msg: ServerMsg): void {
    this.messages.push(msg);
    if (msg.t === 'welcome') {
      this.token = msg.sessionToken;
      this.seat = msg.seat;
      this.roomCode = msg.room.code;
      this.seq = msg.seq;
      this.lastView = msg.view;
      this.lastTurn = msg.turn;
    } else if (msg.t === 'update') {
      this.seq = Math.max(this.seq, msg.seq);
      this.lastView = msg.view;
      this.lastTurn = msg.turn;
    } else if (msg.t === 'room') {
      this.seq = Math.max(this.seq, msg.seq);
    }
    for (const fn of [...this.listeners]) fn(msg);
    this.waiters = this.waiters.filter((w) => {
      if (!w.pred(msg)) return true;
      w.resolve(msg);
      return false;
    });
  }

  onServerMsg(fn: (msg: ServerMsg) => void): void {
    this.listeners.push(fn);
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  async hello(
    opts: {
      roomCode?: string;
      sessionToken?: string;
      nickname?: string;
      v?: number;
      /** Initial room config (create only): preset + overrides. */
      config?: ConfigPatch;
      /** Opaque app auth token binding the connection to a signed-in account. */
      auth?: string;
      /** Matchmaking intent: server picks/opens a matchmade room for the bucket. */
      matchmaking?: { players: 2 | 3 | 4; ranked: boolean };
    } = {},
  ): Promise<ServerMsg> {
    const reply = this.next((m) => m.t === 'welcome' || m.t === 'error', 10_000, 'welcome');
    this.send({
      t: 'hello',
      v: opts.v ?? PROTOCOL_VERSION,
      ...(opts.roomCode !== undefined ? { roomCode: opts.roomCode } : {}),
      ...(opts.sessionToken !== undefined ? { sessionToken: opts.sessionToken } : {}),
      ...(opts.nickname !== undefined ? { nickname: opts.nickname } : {}),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
      ...(opts.matchmaking !== undefined ? { matchmaking: opts.matchmaking } : {}),
    });
    return reply;
  }

  lobby(cmd: LobbyCmd, actionId: string = randomUUID()): string {
    this.send({ t: 'lobby', actionId, cmd });
    return actionId;
  }

  action(action: PlayerAction, actionId: string = randomUUID()): string {
    this.send({ t: 'action', actionId, knownSeq: this.seq, action });
    return actionId;
  }

  resync(): void {
    this.send({ t: 'resync' });
  }

  next(
    pred: (msg: ServerMsg) => boolean,
    timeoutMs = 10_000,
    what = 'message',
  ): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        pred,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timeout waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  terminate(): void {
    this.ws.terminate();
  }
}

export interface ScriptOpts {
  /**
   * Open an untouched auction at the hint minimum instead of passing. Without
   * a forced opening (illisoft) this guarantees the deal gets a declarer.
   */
  openBid?: boolean;
  /**
   * Send `nextDeal` ("Jatka") when a deal is scored so a solo-vs-bots match —
   * which is player-paced and does NOT auto-advance — plays through to the end.
   * Multi-human matches auto-advance server-side and don't need this.
   */
  advanceDeals?: boolean;
}

/** Deterministic legal move from hints (see module doc). */
export function scriptedAction(
  view: PlayerView,
  hints: ActionHint[],
  opts: ScriptOpts = {},
): PlayerAction {
  const hand: readonly Card[] = view.deal?.hand ?? [];
  for (const h of hints) {
    switch (h.type) {
      case 'bid': {
        if (h.forced || !h.canPass) return { type: 'bid', amount: h.min };
        const phase = view.deal?.phase;
        const auctionUntouched = phase?.name === 'bidding' && phase.highBid === null;
        if (opts.openBid === true && auctionUntouched && h.min <= h.max) {
          return { type: 'bid', amount: h.min };
        }
        return { type: 'pass' };
      }
      case 'giveCards':
        return { type: 'giveCards', cards: hand.slice(0, h.count) };
      case 'discardCards':
        // 2-3p koini: legal = hand minus aces and tens.
        return { type: 'discardCards', cards: h.legal.slice(0, h.count) };
      case 'setContract':
        return { type: 'setContract', amount: h.min };
      case 'returnCards':
        return { type: 'returnCards', cards: hand.slice(0, h.count) };
      case 'answerWhole': {
        const suit = h.suits[0];
        if (suit !== undefined) return { type: 'answerWhole', suit };
        break;
      }
      default:
        break;
    }
  }
  for (const h of hints) {
    if (h.type === 'playCard') {
      const card = h.legal[0];
      if (card !== undefined) return { type: 'playCard', card };
    }
  }
  throw new Error(`scriptedAction: no playable option in ${JSON.stringify(hints)}`);
}

/** Auto-plays whenever a received welcome/update says it is our turn. */
export function attachDriver(client: TestClient, opts: ScriptOpts = {}): void {
  let lastActedSeq = -1;
  let lastAdvancedDeal = -1;
  const maybeAct = (view: PlayerView | null, turn: TurnInfo | null, seq: number): void => {
    if (!view || !turn || !turn.hints) return;
    if (client.seat === null || turn.seat !== client.seat) return;
    if (seq <= lastActedSeq) return;
    lastActedSeq = seq;
    client.action(scriptedAction(view, turn.hints, opts));
  };
  // Solo-vs-bots is player-paced: nudge the next deal with `nextDeal` ("Jatka")
  // once per scored deal so an all-bot-partner match still plays to the end.
  const maybeAdvance = (view: PlayerView | null): void => {
    if (!opts.advanceDeals || !view) return;
    if (view.winnerSide !== null || view.deal?.phase.name !== 'scored') return;
    if (view.dealIndex <= lastAdvancedDeal) return;
    lastAdvancedDeal = view.dealIndex;
    client.lobby({ type: 'nextDeal' });
  };
  client.onServerMsg((msg) => {
    if (msg.t !== 'update' && msg.t !== 'welcome') return;
    maybeAct(msg.view, msg.turn, msg.seq);
    maybeAdvance(msg.view);
  });
  // A welcome carrying our pending turn may have arrived before attaching
  // (e.g. reconnect into our own turn after crash recovery) — act on it now.
  maybeAct(client.lastView, client.lastTurn, client.seq);
}

/**
 * Creates a room (optional initial config via hello) and seats `players`
 * scripted humans; returns [host, guest1, ...]. When `config` sets a 2/3-
 * player mode, only that many seats exist and get filled.
 */
export async function seatHumans(
  port: number,
  players: 2 | 3 | 4,
  config?: ConfigPatch,
): Promise<TestClient[]> {
  const host = await TestClient.connect(port);
  const welcome = (await host.hello({
    nickname: 'host',
    ...(config !== undefined ? { config } : {}),
  })) as WelcomeMsg;
  if (welcome.t !== 'welcome') throw new Error('host hello failed');
  if (welcome.room.config.players !== players) {
    throw new Error(`room has ${welcome.room.config.players} seats, wanted ${players}`);
  }
  const clients = [host];
  for (let i = 1; i < players; i++) {
    const seat = i as Seat;
    const c = await TestClient.connect(port);
    const w = await c.hello({ roomCode: host.roomCode, nickname: `p${seat}` });
    if (w.t !== 'welcome') throw new Error(`guest ${seat} hello failed`);
    const confirmed = c.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'human',
      10_000,
      `seat ${seat} taken`,
    );
    c.lobby({ type: 'takeSeat', seat });
    await confirmed;
    c.seat = seat;
    clients.push(c);
  }
  return clients;
}

/** 4 seated scripted humans on the päämuoto ruleset (the original harness). */
export async function seatFourHumans(port: number): Promise<TestClient[]> {
  return seatHumans(port, 4, { preset: 'paamuoto' });
}

/** Resolves when the client sees the deal reach the scored phase. */
export function waitForDealScored(client: TestClient, timeoutMs = 45_000): Promise<UpdateMsg> {
  return client.next(
    (m) => m.t === 'update' && m.view.deal?.phase.name === 'scored',
    timeoutMs,
    'deal scored',
  ) as Promise<UpdateMsg>;
}
