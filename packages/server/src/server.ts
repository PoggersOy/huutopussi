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
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import {
  counterProgress,
  earnedTitles,
  effectiveTitleId,
  type StatsContext,
} from '@hp/achievements';
import {
  activeSeats,
  allowedActions,
  applyEvent,
  type Card,
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
  type Side,
  sideCount,
  sideOf,
  validateAction,
} from '@hp/engine';
import {
  type ClientMsg,
  type ConfigPatch,
  clientMsgSchema,
  configPatchSchema,
  type Emote,
  type LobbyCmd,
  type MatchRatingResult,
  PROTOCOL_VERSION,
  type SeatRatingResult,
  type ServerMsg,
  type TurnInfo,
} from '@hp/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { backfillAchievementsOnce, evaluateMatchAchievements } from './achievements.js';
import { AUTH_TOKEN_TTL_MS, createGoogleVerifier, hashToken, mintToken } from './auth.js';
import { computeBotAction, getBot, getFallbackBot } from './botRunner.js';
import {
  Db,
  EVENT_RETENTION_MS,
  INACTIVE_ROOM_RETENTION_MS,
  MAX_RULE_CONFIGS,
  type RatingUpdate,
  type UserRow,
} from './db.js';
import { computeRatingChanges, PROVISIONAL_GAMES, type SideInput } from './elo.js';
import {
  allSeatsFilled,
  anyHumanConnected,
  createRoom,
  generateRoomCode,
  hostSessionOf,
  type MatchRosterEntry,
  ROOM_CODE_ALPHABET,
  type Room,
  type RoomMatchmaking,
  type RoomStatus,
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
  sendRawTo,
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

/** Room-code validator for the /api/rooms probe (single source: the alphabet). */
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{5}$`);

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
  /** Cap on rooms concurrently reserved by one trusted client IP. */
  maxRoomsPerIp?: number;
  /** Global and per-IP live WebSocket caps. */
  maxSockets?: number;
  maxSocketsPerIp?: number;
  /** Time allowed for a new WebSocket to send hello; tests may shorten it. */
  wsHelloTimeoutMs?: number;
  /** Per-socket inbound message flood guard; tests may lower the cap. */
  wsRateLimit?: { windowMs: number; maxMessages: number };
  /**
   * Google OAuth client id for Sign-In. When unset (null), login is disabled
   * and the app runs guest-only — the natural mode for local dev and e2e.
   */
  googleClientId?: string | null;
  /**
   * Rule overrides for matchmade rooms, applied on top of the illisoft default
   * (the per-bucket `players` count is always set separately). Lets an operator
   * tune the matchmaking ruleset (e.g. a shorter winTarget); tests use it to end
   * matches fast. Undefined = pure illisoft.
   */
  matchmakingConfig?: ConfigPatch;
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

/**
 * Result of costing a finished match's ratings: the wire payload, the durable
 * db updates, and the in-memory session-cache refreshes (kept separate so they
 * can be applied at the right moments — writes inside the txn, cache after it).
 */
interface RatingPlan {
  result: MatchRatingResult;
  updates: RatingUpdate[];
  cache: Array<{ session: Session; rating: number; provisional: boolean }>;
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

type ConfigPatchResult =
  | { ok: true; config: RuleConfig }
  | { ok: false; code: string; params: Record<string, string | number> };

/**
 * Applies a host config patch on top of `current`. The client always sends a
 * COMPLETE config (there is no named base ruleset on the wire), but individual
 * fields are still merged so partial patches (e.g. a lone `players` change)
 * work. Cross-field validity that the per-field zod schema cannot see is
 * enforced on the RESULT; an invalid patch is rejected wholesale (the room
 * config is left untouched).
 */
export function applyConfigPatch(current: RuleConfig, patch: ConfigPatch): ConfigPatchResult {
  const bad = (field: string): ConfigPatchResult => ({
    ok: false,
    code: 'error.badConfig',
    params: { field },
  });
  const next: RuleConfig = { ...current };
  const nextMut = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) nextMut[key] = value;
  }
  // Koinipakka options exist only in the 2-3p modes...
  if (next.players === 4) {
    if (patch.talonSize !== undefined) return bad('talonSize');
    if (patch.openTalon !== undefined) return bad('openTalon');
  } else if (patch.exchangeCount !== undefined) {
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
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Epoch-ms of the most recent midnight in `timeZone`, derived from `nowMs`.
 * Reads the wall-clock time-of-day in that zone (via Intl, so DST is handled
 * for free) and subtracts it from `nowMs` — no offset table needed.
 */
function startOfDayMs(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(nowMs));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const msIntoDay =
    ((field('hour') * 60 + field('minute')) * 60 + field('second')) * 1000 + (nowMs % 1000);
  return nowMs - msIntoDay;
}

/**
 * Fixed-window per-key limiter shared by the lightweight HTTP probes. Returns
 * true when `key` has exceeded `max` hits in the current `windowMs`. Expired
 * buckets are evicted lazily (only once the map grows past a threshold) so it
 * can't leak memory under IP churn while staying allocation-free on the hot path.
 */
function fixedWindowLimited(
  buckets: Map<string, { count: number; resetAt: number }>,
  key: string,
  now: number,
  windowMs: number,
  max: number,
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

/**
 * The client-side routes React Router knows how to render (mirror of
 * client/src/App.tsx). A known route falls back to the SPA shell with a 200;
 * an unknown one still serves the shell — so the client shows its NotFound
 * screen — but with a 404 status. If this drifts from App.tsx the only cost is
 * a real route reporting 404 while still rendering; functionality is unaffected.
 */
function isKnownAppRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/history' ||
    pathname === '/saannot' ||
    pathname === '/rules' ||
    pathname === '/privacy' ||
    pathname === '/profile' ||
    pathname === '/opettele' ||
    pathname === '/learn' ||
    pathname.startsWith('/r/') ||
    pathname.startsWith('/opettele/') ||
    pathname.startsWith('/learn/')
  );
}

/**
 * `Cache-Control` for a static asset. Critical for PWA update propagation: if
 * the origin sends no header, the CDN (Cloudflare) invents `max-age=14400`,
 * which pins a *stale service worker* for 4h so new deploys are never even
 * detected. So we send explicit, correct policies:
 *
 *  - `sw.js` / `registerSW.js` / the app shell / the manifest → `no-cache`
 *    (may be stored, but MUST be revalidated before use). These gate every
 *    update, so they must always reflect the latest deploy.
 *  - content-hashed build output (`/assets/*`, `workbox-<hash>.js`) → cache
 *    forever + `immutable`: the filename changes when the bytes change, so a
 *    given URL is safe to keep indefinitely.
 *  - everything else (icons, logo, favicon) → revalidate daily.
 *
 * (Cloudflare must also be told to honour these — Browser Cache TTL "Respect
 * Existing Headers", and a rule to bypass the edge cache for `/sw.js`.)
 */
function cacheControlFor(filePath: string): string {
  const base = basename(filePath);
  if (
    base === 'sw.js' ||
    base === 'registerSW.js' ||
    base === 'index.html' ||
    base.endsWith('.webmanifest')
  ) {
    return 'no-cache';
  }
  if (filePath.includes(`${sep}assets${sep}`) || /^workbox-[\w-]+\.js$/.test(base)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=86400';
}

export function createServer(opts: ServerOpts = {}): HpServer {
  const cfg: TimerConfig = { ...DEFAULT_TIMER_CONFIG, ...opts.timers };
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? 8080;
  const staticDir = opts.staticDir ?? null;
  const maxRooms = opts.maxRooms ?? 1000;
  const maxSessionsPerRoom = opts.maxSessionsPerRoom ?? 64;
  const maxRoomsPerIp = opts.maxRoomsPerIp ?? 20;
  const maxSockets = opts.maxSockets ?? 4096;
  const maxSocketsPerIp = opts.maxSocketsPerIp ?? 128;
  const wsHelloTimeoutMs = opts.wsHelloTimeoutMs ?? 10_000;
  const wsRateLimit = opts.wsRateLimit ?? { windowMs: 10_000, maxMessages: 120 };
  const db = new Db(opts.dbPath ?? './data/hp.db');
  const googleClientId = opts.googleClientId ?? null;
  const verifyGoogle = createGoogleVerifier(googleClientId);
  const matchmakingConfig = opts.matchmakingConfig;

  const rooms = new Map<string, Room>(); // by code
  const roomsById = new Map<string, Room>();
  const sessionsByToken = new Map<string, Session>();
  const roomCreatorIp = new Map<string, string>();
  const liveRoomsByIp = new Map<string, number>();
  const liveSocketsByIp = new Map<string, number>();
  const failedRoomJoinRate = new Map<string, { count: number; resetAt: number }>();
  /**
   * Matchmaking: one currently-accepting matchmade room per bucket. Keyed by
   * `bucketKey(players, ranked)` → room code. A find reuses the mapped room if
   * it is still open/lobby/not-full, else opens a new one; the entry is dropped
   * when its room starts or closes.
   */
  const matchmakingOpen = new Map<string, string>();
  const bucketKey = (players: 2 | 3 | 4, ranked: boolean): string =>
    `${players}:${ranked ? 'r' : 'u'}`;
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

  /** Min gap between a seat's reactions; extra ones are dropped (anti-spam). */
  const EMOTE_COOLDOWN_MS = 1_500;

  /**
   * A player's reaction, echoed to everyone in the room (sender included). No
   * seq bump, no redaction, no idempotency: an emote is ephemeral table flair,
   * not game state — a dropped one is simply not shown.
   */
  function broadcastEmote(room: Room, seat: Seat, emote: Emote): void {
    const json = JSON.stringify({ t: 'emote', seat, emote } satisfies ServerMsg);
    for (const s of room.sessions.values()) {
      if (isConnected(s) && s.socket) s.socket.send(json);
    }
  }

  /** ONE 'update' per recipient, per-seat redaction, hints to actor only. */
  function broadcastUpdate(
    room: Room,
    trigger: GameEvent | null,
    options: {
      includeRoom?: boolean;
      origin?: { token: string; actionId: string };
      ratings?: MatchRatingResult;
    } = {},
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
        ...(options.ratings ? { ratings: options.ratings } : {}),
      };
      const json = JSON.stringify(msg);
      if (isOrigin && options.origin) rememberResponse(s, options.origin.actionId, json);
      if (connected && s.socket) s.socket.send(json);
    }
  }

  function roomHistory(room: Room) {
    room.historyCache ??= db.matchSummaries(room.id);
    return room.historyCache;
  }

  function sendHistory(room: Room): void {
    room.historyCache = null;
    const msg: ServerMsg = { t: 'history', matches: roomHistory(room) };
    const json = JSON.stringify(msg);
    for (const s of room.sessions.values()) sendRawTo(s, json);
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
      s.bot ??= getBot(room.botDifficulty);
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

  /** Drop a matchmade room from the bucket registry if it is the open one. */
  function unregisterMatchmaking(room: Room): void {
    if (room.matchmaking === null) return;
    const key = bucketKey(room.config.players, room.matchmaking.ranked);
    if (matchmakingOpen.get(key) === room.code) matchmakingOpen.delete(key);
  }

  function reserveRoomForIp(roomId: string, ip: string): boolean {
    const count = liveRoomsByIp.get(ip) ?? 0;
    if (count >= maxRoomsPerIp) return false;
    roomCreatorIp.set(roomId, ip);
    liveRoomsByIp.set(ip, count + 1);
    return true;
  }

  function releaseRoomReservation(roomId: string): void {
    const ip = roomCreatorIp.get(roomId);
    if (ip === undefined) return;
    roomCreatorIp.delete(roomId);
    const count = liveRoomsByIp.get(ip) ?? 0;
    if (count <= 1) liveRoomsByIp.delete(ip);
    else liveRoomsByIp.set(ip, count - 1);
  }

  function failedRoomJoinLimited(remoteIp: string, now = Date.now()): boolean {
    return (
      fixedWindowLimited(failedRoomJoinRate, `ip:${remoteIp}`, now, 60_000, 30) ||
      fixedWindowLimited(failedRoomJoinRate, 'global', now, 60_000, 1000)
    );
  }

  /** Zero connected humans for idleCloseMs: persist as abandoned, close. */
  function closeRoom(room: Room): void {
    if (room.closed) return;
    room.closed = true;
    releaseRoomReservation(room.id);
    unregisterMatchmaking(room);
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
    // Closed sessions can never reconnect. Remove their tokens, nicknames and
    // account links immediately instead of retaining that PII until a later
    // maintenance sweep; the small room row remains as an operational tombstone.
    db.deleteSessionsForRoom(room.id);
    rooms.delete(room.code);
    roomsById.delete(room.id);
  }

  // ── game flow ───────────────────────────────────────────────────────────────

  /** Empty (unrated) plan — the common case (guest/bot present, or a tie seat). */
  const UNRATED_PLAN: RatingPlan = {
    result: { rated: false, perSeat: [] },
    updates: [],
    cache: [],
  };

  /**
   * Cost the Elo of a just-finished match. Rated ONLY when every active seat is
   * a distinct signed-in human (no bots, no guests, no account twice); any other
   * shape returns the unrated plan (no rating/streak change). Pure reads +
   * computation — persistence and cache application happen in the caller.
   */
  function planMatchRating(
    room: Room,
    matchId: string,
    finalState: MatchState,
    now: number,
  ): RatingPlan {
    const players = room.config.players;
    if (finalState.winnerSide === null) return UNRATED_PLAN;
    if (!room.ratingEligible) return UNRATED_PLAN;
    const seats = activeSeats(players);

    // Eligibility + gather each seat's account, keyed by seat.
    const userBySeat = new Map<Seat, UserRow>();
    const seenUsers = new Set<string>();
    for (const seat of seats) {
      const participant = room.matchRoster.find((p) => p.seat === seat);
      if (!participant || participant.kind !== 'human' || participant.userId === null) {
        return UNRATED_PLAN;
      }
      if (seenUsers.has(participant.userId)) return UNRATED_PLAN;
      seenUsers.add(participant.userId);
      const u = db.getUserById(participant.userId);
      if (!u) return UNRATED_PLAN;
      userBySeat.set(seat, u);
    }

    // Group seats into their sides (4p pairs; 2-3p one seat per side).
    const n = sideCount(room.config);
    const memberSeatsBySide: Seat[][] = Array.from({ length: n }, () => []);
    for (const seat of seats) {
      const bucket = memberSeatsBySide[sideOf(seat, players)];
      if (bucket) bucket.push(seat);
    }

    const sides: SideInput[] = memberSeatsBySide.map((memberSeats, side) => ({
      members: memberSeats.map((seat) => {
        const u = userBySeat.get(seat);
        if (!u) throw new Error('planMatchRating: missing user for seat');
        return { rating: u.rating, gamesPlayed: u.gamesPlayed, streakBefore: u.winStreak };
      }),
      finalScore: finalState.scores[side] ?? 0,
      isWinner: side === finalState.winnerSide,
    }));

    const changes = computeRatingChanges(sides);
    const updates: RatingUpdate[] = [];
    const perSeat: SeatRatingResult[] = [];
    const cache: RatingPlan['cache'] = [];
    memberSeatsBySide.forEach((memberSeats, side) => {
      const sideChanges = changes[side];
      memberSeats.forEach((seat, k) => {
        const u = userBySeat.get(seat);
        const r = sideChanges?.[k];
        const s = sessionAtSeat(room, seat);
        if (!u || !r) throw new Error('planMatchRating: change/seat mismatch');
        const isWin = side === finalState.winnerSide;
        updates.push({
          matchId,
          userId: u.id,
          seat,
          ratingBefore: u.rating,
          ratingAfter: r.newRating,
          delta: r.delta,
          newStreak: r.newStreak,
          isWin,
          createdAt: now,
        });
        perSeat.push({ seat, userId: u.id, before: u.rating, after: r.newRating, delta: r.delta });
        if (s?.userId === u.id) {
          cache.push({
            session: s,
            rating: r.newRating,
            provisional: u.gamesPlayed + 1 < PROVISIONAL_GAMES,
          });
        }
      });
    });
    return { result: { rated: true, perSeat }, updates, cache };
  }

  /** Applies a rating plan's in-memory session-cache refreshes (post-commit). */
  function applyRatingCache(plan: RatingPlan): void {
    for (const c of plan.cache) {
      c.session.rating = c.rating;
      c.session.provisional = c.provisional;
    }
  }

  /** Distinct signed-in humans captured when the match started. */
  function signedInParticipants(room: Room): Array<{ seat: Seat; userId: string }> {
    const out: Array<{ seat: Seat; userId: string }> = [];
    const counts = new Map<string, number>();
    for (const p of room.matchRoster) {
      if (p.kind === 'human' && p.userId !== null) {
        counts.set(p.userId, (counts.get(p.userId) ?? 0) + 1);
      }
    }
    for (const p of room.matchRoster) {
      if (p.kind === 'human' && p.userId !== null && counts.get(p.userId) === 1) {
        out.push({ seat: p.seat, userId: p.userId });
      }
    }
    return out;
  }

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
    // Cost the Elo BEFORE the transaction (pure reads + math); persist the
    // rating rows INSIDE it so they commit atomically with finishMatch.
    const matchEnding = events.some((e) => e.type === 'matchEnded');
    const finishedAtMs = Date.now();
    const ratingPlan = matchEnding ? planMatchRating(room, matchId, state, finishedAtMs) : null;
    // Seat-indexed roster at match end, for the history deal-browser's labels.
    const finalNames = matchEnding
      ? activeSeats(room.config.players).map((seat) => sessionAtSeat(room, seat)?.nickname ?? null)
      : null;
    // Signed-in humans at match end — the population that accrues achievements
    // (any match type, unlike ratings which only cover all-signed-in matches).
    const participants = matchEnding && state.winnerSide !== null ? signedInParticipants(room) : [];
    db.transaction(() => {
      events.forEach((e, i) => {
        db.appendEvent(matchId, base + i + 1, e);
        if (e.type === 'dealScored') {
          db.recordDealResult(matchId, state.dealIndex, state.dealer, e.result);
        }
        if (e.type === 'matchEnded') {
          db.finishMatch(matchId, e.winnerSide, state.scores, finalNames);
        }
      });
      if (ratingPlan?.result.rated) db.applyRatingResults(ratingPlan.updates);
      // Achievements: after finishMatch + ratings so the stats it reads include
      // this match. Records match_participants and awards newly-earned badges.
      if (matchEnding && state.winnerSide !== null) {
        evaluateMatchAchievements(db, {
          matchId,
          config: state.config,
          winnerSide: state.winnerSide,
          finalScores: state.scores,
          participants,
          ratingUpdates: ratingPlan?.result.rated ? ratingPlan.updates : null,
          now: finishedAtMs,
        });
      }
    });
    room.eventSeq = base + events.length;
    room.match = state;
    // Refresh cached ratings before the broadcast so a bundled roomPublic shows
    // the post-match numbers in the lobby.
    if (ratingPlan) applyRatingCache(ratingPlan);

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
      ...(ratingPlan ? { ratings: ratingPlan.result } : {}),
    });

    if (state.winnerSide !== null) {
      sendHistory(room);
    } else if (state.deal === null) {
      // Redeal demanded: author a fresh deal shortly.
      scheduleNextDeal(room, cfg.redealDelayMs, () => authorNextDeal(room));
    } else if (state.deal.phase.name === 'scored') {
      // Solo-vs-bots is player-paced: the sole human advances with `nextDeal`
      // ("Jatka"), so no timer here. Multi-human games auto-advance so one idle
      // player can't stall the table.
      if (!isSoloVsBots(room)) {
        scheduleNextDeal(room, cfg.nextDealDelayMs, () => authorNextDeal(room));
      }
    }
  }

  /**
   * A solo-vs-bots game: exactly one human occupies an active seat (the rest are
   * bots). These games don't auto-advance between deals — the human drives the
   * pace with the `nextDeal` lobby command.
   */
  function isSoloVsBots(room: Room): boolean {
    let humans = 0;
    for (const seat of activeSeats(room.config.players)) {
      if (sessionAtSeat(room, seat)?.kind === 'human') humans += 1;
    }
    return humans === 1;
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

  /** Start a match. `origin` present for a host-triggered start (idempotent echo);
   *  omitted for a server-initiated start (matchmaking auto-start / auto-fill). */
  function startNewMatch(room: Room, origin?: { token: string; actionId: string }): void {
    const firstDealer = randomInt(room.config.players) as Seat;
    const matchId = randomUUID();
    const roster: MatchRosterEntry[] = activeSeats(room.config.players).map((seat) => {
      const session = sessionAtSeat(room, seat);
      if (!session) throw new Error(`startNewMatch: empty seat ${seat}`);
      return {
        seat,
        kind: session.kind,
        userId: session.kind === 'human' ? session.userId : null,
        participantKey:
          session.kind === 'human'
            ? session.userId === null
              ? `guest:${hashToken(session.token)}`
              : `user:${session.userId}`
            : `bot:${matchId}:${seat}`,
      };
    });
    const signedUsers = roster.flatMap((p) =>
      p.kind === 'human' && p.userId !== null ? [p.userId] : [],
    );
    const ratingEligible =
      room.matchmaking?.ranked !== false &&
      signedUsers.length === roster.length &&
      new Set(signedUsers).size === signedUsers.length;
    room.match = initialMatchState(room.config, firstDealer);
    room.matchId = matchId;
    room.eventSeq = 0;
    room.matchRoster = roster;
    room.ratingEligible = ratingEligible;
    room.status = 'playing';
    // A started matchmade room no longer accepts finders.
    unregisterMatchmaking(room);
    db.transaction(() => {
      db.createMatch({
        id: matchId,
        roomId: room.id,
        config: room.config,
        firstDealer,
        roster,
        ratingEligible,
      });
      db.setRoomStatus(room.id, 'playing');
    });
    try {
      applyAndBroadcast(room, [nextDealEvent(room.match, cryptoShuffle(ALL_CARDS))], origin, true);
    } catch (err) {
      console.error(`[server] failed to start match in room ${room.code}`, err);
      if (origin) {
        respondError(
          room.sessions.get(origin.token) ?? createDetachedSession(),
          origin.actionId,
          'error.internal',
        );
      }
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
  /**
   * Seat a session at `seat`: mutate + persist + broadcast + re-welcome. The
   * seat-taker's own seat rides only on `welcome` (the `room` message carries no
   * viewer identity), so the re-welcome is required or they'd stay `seat: null`
   * client-side. Used by `takeSeat` and the matchmaker (server-driven seating).
   */
  function seatSession(
    room: Room,
    session: Session,
    seat: Seat,
    origin?: { token: string; actionId: string },
  ): void {
    session.seat = seat;
    db.saveSession(sessionRow(session));
    broadcastRoom(room, origin);
    sendWelcome(session, room);
  }

  /** Create + register a bot session at `seat` (no broadcast — caller broadcasts). */
  function addBotToSeat(room: Room, seat: Seat): void {
    const bot = createSession({
      token: randomUUID(),
      roomId: room.id,
      seat,
      nickname: null,
      kind: 'bot',
    });
    room.sessions.set(bot.token, bot);
    sessionsByToken.set(bot.token, bot);
    db.saveSession(sessionRow(bot));
  }

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
        const occupant = sessionAtSeat(room, cmd.seat);
        // Re-taking the seat you already hold is a no-op re-welcome, not a
        // conflict — auto-seating on join means a client may already sit here.
        if (occupant && occupant.token !== session.token) return fail('error.seatTaken');
        seatSession(room, session, cmd.seat, { token: session.token, actionId });
        return true;
      }
      case 'leaveSeat': {
        if (seatsLocked) return fail('error.matchInProgress');
        if (session.seat === null) return fail('error.notSeated');
        session.seat = null;
        db.saveSession(sessionRow(session));
        broadcastRoom(room, { token: session.token, actionId });
        sendWelcome(session, room); // sync the now-null seat to their client
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
        addBotToSeat(room, cmd.seat);
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
        if (cmd.configName !== undefined) room.configName = cmd.configName;
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
      case 'fillBotsAndStart': {
        // Matchmaking "Start with bots" and Pikapeli: fill empty active seats
        // with bots and start now. Atomic (no client addBot×N + startMatch
        // race). Bots present → the match is unrated. `difficulty` (Pikapeli's
        // "Bottien taso") sets every bot's skill for the room; default medium.
        if (!isHost) return fail('error.notHost');
        if (room.status !== 'lobby') return fail('error.matchInProgress');
        room.botDifficulty = cmd.difficulty ?? 'medium';
        for (const seat of activeSeats(room.config.players)) {
          if (!sessionAtSeat(room, seat)) addBotToSeat(room, seat);
        }
        startNewMatch(room, { token: session.token, actionId });
        return true;
      }
      case 'stopMatch': {
        // Host aborts an ongoing match: abandon it and close the room, which
        // drops every client (WS close 4000 → each lands on the "room closed"
        // dead-end and can go Home). closeRoom persists the match as abandoned.
        if (!isHost) return fail('error.notHost');
        if (room.status !== 'playing') return fail('error.noMatch');
        if (room.ratingEligible) return fail('error.ratedCannotStop');
        closeRoom(room);
        return true;
      }
      case 'nextDeal': {
        // Advance a waiting (scored / redeal-pending) match to the next deal
        // now. Any seated player may do it: solo-vs-bots games rely on it (no
        // auto-advance timer), and in a multi-human game it just skips the rest
        // of the countdown. No-op error outside a waiting state.
        if (session.seat === null) return fail('error.notSeated');
        if (room.status !== 'playing') return fail('error.noMatch');
        const state = room.match;
        if (!state || state.winnerSide !== null) return fail('error.noMatch');
        const waiting = state.deal === null || state.deal.phase.name === 'scored';
        if (!waiting) return fail('error.notInPhase');
        if (room.timers.nextDeal) {
          clearTimeout(room.timers.nextDeal);
          room.timers.nextDeal = null;
        }
        try {
          applyAndBroadcast(room, [nextDealEvent(state, cryptoShuffle(ALL_CARDS))], {
            token: session.token,
            actionId,
          });
        } catch (err) {
          console.error(`[server] failed to advance deal in room ${room.code}`, err);
          return fail('error.internal');
        }
        return true;
      }
      case 'reclaimSeat': {
        // The "I'm back" button: a present human takes their seat back from the
        // fill-in bot on demand. Works off-turn (unlike reclaimSeatOnAction),
        // clearing the away flag so the bot won't play the seat's NEXT turn.
        if (session.seat === null) return fail('error.notSeated');
        // Not actually away (already in control, or a genuine bot seat): a
        // harmless success so a double-tap / stale button never errors.
        if (session.kind !== 'human' || !session.botControlled) return true;
        const rearmed = reclaimSeat(room, session);
        if (rearmed) {
          // It's our turn again: push the cleared away-flag AND the fresh
          // deadline so every client's badge + countdown re-syncs (mirrors the
          // reconnect reclaim path).
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
    }
  }

  function sessionRow(s: Session) {
    return {
      token: s.token,
      roomId: s.roomId,
      seat: s.seat,
      nickname: s.nickname,
      kind: s.kind,
      userId: s.userId,
      authTokenHash: s.authTokenHash,
    };
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
    // Bundle the room's finished-match summaries with every welcome. Previously
    // 'history' was pushed ONLY when a match finished mid-connection, so a fresh
    // device (or a reconnect after the fact) never saw a room's past results.
    // Sending the authoritative set on welcome keeps the History screen complete
    // per room, consistent with the full-snapshot-on-welcome model.
    sendTo(session, { t: 'history', matches: roomHistory(room) });
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

  interface AuthBinding {
    user: UserRow;
    tokenHash: string;
  }

  function resolveAuthBinding(token: string | undefined): AuthBinding | null {
    if (token === undefined) return null;
    const tokenHash = hashToken(token);
    const userId = db.resolveAuthToken(tokenHash, Date.now());
    if (userId === null) return null;
    const user = db.getUserById(userId);
    return user === null ? null : { user, tokenHash };
  }

  /** Resolve an app auth token to its account, or null (absent/expired/unknown). */
  function resolveAuth(token: string | undefined): UserRow | null {
    return resolveAuthBinding(token)?.user ?? null;
  }

  /**
   * Bind a resolved account onto a session: id, cached rating/provisional, and a
   * default nickname from the Google name when the client sent none. Reconnect
   * handles a null binding separately by downgrading an existing binding to a
   * guest, so stale or revoked grants cannot preserve account attribution.
   */
  function applyAuthToSession(
    session: Session,
    binding: AuthBinding | null,
    explicitNick: string | undefined,
  ): void {
    if (!binding) return;
    const { user, tokenHash } = binding;
    session.userId = user.id;
    session.authTokenHash = tokenHash;
    session.authCheckedAt = Date.now();
    session.rating = user.rating;
    session.provisional = user.gamesPlayed < PROVISIONAL_GAMES;
    if (explicitNick === undefined && session.nickname === null && user.name) {
      const nick = user.name.trim().slice(0, 20);
      if (nick.length > 0) session.nickname = nick;
    }
  }

  function clearSessionAuth(session: Session): void {
    session.userId = null;
    session.authTokenHash = null;
    session.authCheckedAt = 0;
    session.rating = null;
    session.provisional = false;
  }

  /** Revalidate long-lived WebSocket authentication at most once per minute. */
  function refreshSessionAuth(session: Session, now = Date.now()): void {
    if (session.authTokenHash === null || now - session.authCheckedAt < 60_000) return;
    const userId = db.resolveAuthToken(session.authTokenHash, now);
    session.authCheckedAt = now;
    if (userId === session.userId && userId !== null) return;
    clearSessionAuth(session);
    db.saveSession(sessionRow(session));
    const room = roomsById.get(session.roomId);
    if (room && !room.closed) broadcastRoom(room);
  }

  /**
   * Account erasure already unlinks durable sessions in Db.deleteUserAccount;
   * mirror that change into live room objects before another match can finish.
   * Otherwise a deleted user could still be treated as signed in from the
   * in-memory cache and accrue fresh participant/achievement rows.
   */
  function unlinkLiveUserSessions(userId: string): void {
    const changedRooms = new Set<Room>();
    for (const session of sessionsByToken.values()) {
      if (session.userId !== userId) continue;
      clearSessionAuth(session);
      db.saveSession(sessionRow(session));
      const room = roomsById.get(session.roomId);
      if (room && !room.closed) {
        for (const participant of room.matchRoster) {
          if (participant.userId === userId) participant.userId = null;
        }
        room.ratingEligible = false;
        changedRooms.add(room);
      }
    }
    for (const room of changedRooms) broadcastRoom(room);
  }

  function unlinkLiveAuthGrant(tokenHash: string): void {
    const changedRooms = new Set<Room>();
    for (const session of sessionsByToken.values()) {
      if (session.authTokenHash !== tokenHash) continue;
      clearSessionAuth(session);
      db.saveSession(sessionRow(session));
      const room = roomsById.get(session.roomId);
      if (room && !room.closed) changedRooms.add(room);
    }
    for (const room of changedRooms) broadcastRoom(room);
  }

  /** Lowest unoccupied active seat, or null if the room is full. */
  function firstFreeSeat(room: Room): Seat | null {
    for (const seat of activeSeats(room.config.players)) {
      if (!sessionAtSeat(room, seat)) return seat;
    }
    return null;
  }

  /**
   * Create + register an EMPTY matchmade room for a bucket (no creator seat;
   * host resolves to the first-seated human via hostSessionOf). Returns null if
   * the global room cap is hit.
   */
  function createEmptyMatchmadeRoom(
    config: RuleConfig,
    matchmaking: RoomMatchmaking,
    remoteIp: string,
  ): Room | null {
    if (rooms.size >= maxRooms) return null;
    const roomId = randomUUID();
    if (!reserveRoomForIp(roomId, remoteIp)) return null;
    const code = generateRoomCode((c) => rooms.has(c));
    const room = createRoom({
      id: roomId,
      code,
      hostToken: null,
      config,
      tableSettings: defaultTableSettings(),
      matchmaking,
    });
    rooms.set(code, room);
    roomsById.set(roomId, room);
    db.createRoom({
      id: roomId,
      code,
      hostToken: null,
      config: room.config,
      tableSettings: room.tableSettings,
    });
    return room;
  }

  /**
   * Matchmaking hello: find an open matchmade room for the bucket (or open one),
   * auto-seat this player, and auto-start when the room fills. Ranked buckets
   * require a signed-in account.
   */
  function handleMatchmaking(
    sock: WebSocket,
    msg: Extract<ClientMsg, { t: 'hello' }>,
    mm: { players: 2 | 3 | 4; ranked: boolean },
    auth: AuthBinding | null,
    remoteIp: string,
    setBound: (s: Session) => void,
  ): void {
    if (mm.ranked && auth === null) {
      // Ranked needs a real account; the client also prevents this.
      sendJson(sock, { t: 'error', code: 'error.rankedNeedsLogin' });
      return;
    }

    const key = bucketKey(mm.players, mm.ranked);
    let room: Room | null = null;
    const openCode = matchmakingOpen.get(key);
    if (openCode !== undefined) {
      const candidate = rooms.get(openCode);
      if (
        candidate &&
        !candidate.closed &&
        candidate.status === 'lobby' &&
        candidate.matchmaking !== null &&
        candidate.sessions.size < maxSessionsPerRoom &&
        !allSeatsFilled(candidate)
      ) {
        room = candidate;
      } else {
        matchmakingOpen.delete(key);
      }
    }

    if (room === null) {
      const applied = applyConfigPatch(defaultConfig(), {
        ...matchmakingConfig,
        players: mm.players,
      });
      if (!applied.ok) {
        // Defensive; a bare `players` patch on illisoft is always valid.
        sendJson(sock, { t: 'error', code: applied.code, params: applied.params });
        return;
      }
      room = createEmptyMatchmadeRoom(applied.config, { ranked: mm.ranked }, remoteIp);
      if (room === null) {
        sendJson(sock, { t: 'error', code: 'error.serverBusy' });
        return;
      }
      matchmakingOpen.set(key, room.code);
    }

    if (
      mm.ranked &&
      auth !== null &&
      [...room.sessions.values()].some((s) => s.userId === auth.user.id)
    ) {
      sendJson(sock, { t: 'error', code: 'error.rankedDuplicateAccount' });
      return;
    }

    const seat = firstFreeSeat(room);
    if (seat === null) {
      sendJson(sock, { t: 'error', code: 'error.serverBusy' });
      return;
    }

    const session = createSession({
      token: randomUUID(),
      roomId: room.id,
      seat: null,
      nickname: msg.nickname ?? null,
      kind: 'human',
    });
    applyAuthToSession(session, auth, msg.nickname);
    room.sessions.set(session.token, session);
    sessionsByToken.set(session.token, session);
    bindSocket(session, sock, room);
    setBound(session);
    // Seat them (persists + broadcasts to the room + re-welcomes the joiner).
    seatSession(room, session, seat);
    // The room is all-human (finds only add humans); a full room auto-starts.
    if (allSeatsFilled(room)) startNewMatch(room);
  }

  function handleHello(
    sock: WebSocket,
    msg: Extract<ClientMsg, { t: 'hello' }>,
    remoteIp: string,
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

    // Resolve the (optional) signed-in account once; a bad/expired token is
    // simply treated as a guest — it never rejects the join.
    const auth = resolveAuthBinding(msg.auth);

    // Resume an existing session (reconnect), last-connect-wins.
    if (msg.sessionToken !== undefined) {
      const existing = sessionsByToken.get(msg.sessionToken);
      if (existing && existing.kind === 'human') {
        const room = roomsById.get(existing.roomId);
        if (room && !room.closed && (msg.roomCode === undefined || msg.roomCode === room.code)) {
          const accountChange =
            (existing.userId !== null && auth !== null && auth.user.id !== existing.userId) ||
            (existing.userId === null &&
              auth !== null &&
              (room.status !== 'lobby' || existing.seat !== null));
          if (accountChange) {
            sendJson(sock, { t: 'error', code: 'error.accountLocked' });
            sock.close(1008, 'account locked');
            return;
          }
          if (msg.nickname !== undefined) existing.nickname = msg.nickname;
          if (auth === null) clearSessionAuth(existing);
          else applyAuthToSession(existing, auth, msg.nickname);
          db.saveSession(sessionRow(existing));
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

    // Matchmaking: the server picks/opens a matchmade room for the bucket and
    // auto-seats this player (auto-starting when the room fills).
    if (msg.matchmaking !== undefined) {
      handleMatchmaking(sock, msg, msg.matchmaking, auth, remoteIp, setBound);
      return;
    }

    if (msg.roomCode !== undefined) {
      // Join an existing room. Seats are server-assigned (the client has no seat
      // picker): a joiner is auto-seated at the first free seat while the room is
      // in the lobby; a full or already-playing room takes them as a spectator
      // (seat null).
      const room = rooms.get(msg.roomCode);
      if (!room || room.closed) {
        const limited = failedRoomJoinLimited(remoteIp);
        sendJson(sock, { t: 'error', code: limited ? 'error.serverBusy' : 'error.roomNotFound' });
        sock.close(limited ? 1008 : 4004, limited ? 'join rate exceeded' : 'room not found');
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
      applyAuthToSession(session, auth, msg.nickname);
      room.sessions.set(session.token, session);
      sessionsByToken.set(session.token, session);
      bindSocket(session, sock, room);
      setBound(session);
      const seat = room.status === 'lobby' ? firstFreeSeat(room) : null;
      if (seat !== null) {
        // seatSession persists + broadcasts the new occupant + welcomes the joiner.
        seatSession(room, session, seat);
      } else {
        db.saveSession(sessionRow(session));
        sendWelcome(session, room);
      }
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
    if (!reserveRoomForIp(roomId, remoteIp)) {
      sendJson(sock, { t: 'error', code: 'error.serverBusy' });
      return;
    }
    const code = generateRoomCode((c) => rooms.has(c));
    const session = createSession({
      token: randomUUID(),
      roomId,
      seat: 0,
      nickname: msg.nickname ?? null,
      kind: 'human',
    });
    applyAuthToSession(session, auth, msg.nickname);
    const room = createRoom({
      id: roomId,
      code,
      hostToken: session.token,
      config,
      configName: msg.configName ?? null,
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
    // The built-in "Oletus" configuration. Fresh object so per-room patches
    // never share state.
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
    // Matchmaking is casual: a disconnect from a WAITING (lobby) matchmade room
    // frees the seat immediately (no 15-min hold) and closes an emptied queue at
    // once, so stale waiting rooms don't linger. Once playing, fall through to
    // the normal disconnect/reconnect-grace handling below.
    if (room.matchmaking !== null && room.status === 'lobby') {
      room.sessions.delete(session.token);
      sessionsByToken.delete(session.token);
      db.deleteSession(session.token);
      if ([...room.sessions.values()].some((s) => s.kind === 'human')) broadcastRoom(room);
      else closeRoom(room);
      return;
    }
    if (session.seat === null) {
      // Unseated guest/spectator disconnect: nothing to hold, so drop the dead
      // session instead of letting it linger until idle-close.
      discardDetachedSession(session);
      armIdleTimerIfEmpty(room);
      return;
    }
    // Mid-turn disconnect: guarantee a dropped actor a full turn to reconnect
    // before autoplay (reconnectGraceMs) — but ONLY when nothing is already
    // counting down. With autoplay on the present actor already holds a budget
    // timer that will hand the seat to the fill-in bot; if a grace timer is
    // already pending from an earlier drop, it will too. In both cases the
    // existing timer must be left running: rescheduling on every socket close
    // let a flapping connection perpetually reset the deadline, so the bot never
    // took over and the table froze (see chaos.test.ts). Arming therefore only
    // happens for an autoplay-off room, where a present actor has no deadline at
    // all and one dropped player would otherwise freeze the table.
    if (
      room.status === 'playing' &&
      room.match &&
      session.seat !== null &&
      !session.botControlled &&
      expectedActor(room.match) === session.seat &&
      room.timers.turn === null
    ) {
      const grace = reconnectGraceMs(room);
      room.turnDeadline = Date.now() + grace;
      const seat = session.seat;
      scheduleTurnExpiry(room, grace, () => onTurnExpired(room, seat));
    }
    // A playing-room disconnect changes both the public connected flag and,
    // with autoplay off, possibly the turn deadline. Send one full update so
    // every table receives the new deadline; a room-only frame cannot carry it.
    if (room.match && room.status === 'playing') {
      room.seq += 1;
      broadcastUpdate(room, null, { includeRoom: true });
    } else {
      broadcastRoom(room);
    }
    armIdleTimerIfEmpty(room);
  }

  function handleMessage(sock: WebSocket, raw: unknown, ctx: SocketState): void {
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
        if (prevRoom && !prevRoom.closed && prevRoom.status === 'lobby' && prev.seat !== null) {
          // Auto-seating means a same-socket re-hello usually abandons a SEATED
          // session. In the lobby that session won't be reconnected (the socket
          // is re-identifying here and now), so drop it fully and free its seat —
          // otherwise repeated re-hellos pile up sessions and exhaust seats.
          prevRoom.sessions.delete(prev.token);
          sessionsByToken.delete(prev.token);
          db.deleteSession(prev.token);
          if ([...prevRoom.sessions.values()].some((s) => s.kind === 'human')) {
            broadcastRoom(prevRoom);
            armIdleTimerIfEmpty(prevRoom);
          } else {
            // A deliberate same-socket re-identification cannot reclaim this
            // lobby. Close it now instead of retaining an attacker-created room.
            closeRoom(prevRoom);
          }
        } else {
          // Unseated guest, or a seated player in a live match: an unseated guest
          // left behind by the re-hello is garbage (drop it); a seated player in a
          // running match is kept for reconnect grace.
          discardDetachedSession(prev);
          if (prevRoom && !prevRoom.closed && prev.seat !== null) broadcastRoom(prevRoom);
          if (prevRoom) armIdleTimerIfEmpty(prevRoom);
        }
      }
      handleHello(sock, msg, ctx.remoteIp, (s) => {
        ctx.session = s;
        if (ctx.helloTimer !== null) {
          clearTimeout(ctx.helloTimer);
          ctx.helloTimer = null;
        }
      });
      if (ctx.session === null && sock.readyState < 2) armHelloTimer(sock, ctx);
      return;
    }

    const session = ctx.session;
    if (!session) {
      sendJson(sock, { t: 'error', code: 'error.helloFirst' });
      return;
    }
    refreshSessionAuth(session);

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
      case 'emote': {
        // Seated players only, rate-limited, no state change. Silently dropped
        // when spectating or too soon — reactions are best-effort table flair.
        if (session.seat === null) return;
        const room = roomsById.get(session.roomId);
        if (!room || room.closed) return;
        const now = Date.now();
        if (now - session.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
        session.lastEmoteAt = now;
        broadcastEmote(room, session.seat, msg.emote);
        return;
      }
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
    if (pathname === '/saannot') filePath = join(dir, 'saannot', 'index.html');
    if (pathname === '/opettele') filePath = join(dir, 'opettele', 'index.html');
    fs.stat(filePath, (err, st) => {
      if (!err && st.isFile()) {
        streamFile(filePath, res);
        return;
      }
      const indexHtml = join(dir, 'index.html');
      // SPA fallback: root, room links (/r/CODE) and app screens serve index.html
      // with a 200 — these are real routes the React router renders.
      if (isKnownAppRoute(pathname)) {
        streamFile(indexHtml, res);
        return;
      }
      // Any OTHER extension-less path is an app route that doesn't exist: still
      // serve the SPA shell (so the client renders its localized NotFound
      // screen) but with a 404 status, so crawlers and probes see the truth.
      // Missing paths that look like a file (they have an extension) stay a
      // plain 404 — a bad asset URL should not masquerade as the app.
      if (extname(pathname) === '') {
        streamFile(indexHtml, res, 404);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  }

  function streamFile(filePath: string, res: http.ServerResponse, status = 200): void {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(status, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': cacheControlFor(filePath),
      });
      res.end(data);
    });
  }

  // ── HTTP: auth + profile JSON API ──────────────────────────────────────────

  function sendHttpJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** Baseline browser hardening for every HTTP response (static and JSON). */
  function setHttpSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    // Google Identity Services uses a popup; this preserves opener isolation
    // without breaking that explicitly supported login flow.
    res.setHeader('cross-origin-opener-policy', 'same-origin-allow-popups');
    // Dynamic room/auth responses must never be cached by a browser or proxy.
    // streamFile overrides this with the asset-specific policy below.
    res.setHeader('cache-control', 'no-store');
  }

  /** Read a size-capped JSON request body (POST endpoints only). */
  function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolvePromise(text.length > 0 ? JSON.parse(text) : {});
        } catch {
          reject(new Error('bad json'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Validates a saved-rule-config request body `{ name, config }`. `name` is a
   * trimmed 1-40 char label; `config` is validated per-field via the wire schema
   * and completed onto the "Oletus" base into a full RuleConfig. Player-count
   * mode gating is intentionally skipped — a saved config is player-count-
   * agnostic; the lobby strips the incompatible fields when a room is created.
   * Also enforces the bid-bound relationships the per-field schema can't see.
   * Returns null on any validation failure.
   */
  async function parseRuleConfigBody(
    req: http.IncomingMessage,
  ): Promise<{ name: string; config: RuleConfig } | null> {
    let body: unknown;
    try {
      body = await readJsonBody(req, 8 * 1024);
    } catch {
      return null;
    }
    if (typeof body !== 'object' || body === null) return null;
    const rawName = (body as { name?: unknown }).name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.length < 1 || name.length > 40) return null;
    const parsed = configPatchSchema.safeParse((body as { config?: unknown }).config);
    if (!parsed.success) return null;
    const config: RuleConfig = { ...ILLISOFT_RULES };
    const mut = config as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) mut[k] = v;
    if (config.maxBid !== null && config.minBid > config.maxBid) return null;
    if (config.minBid % config.bidStep !== 0) return null;
    if (config.maxBid !== null && config.maxBid % config.bidStep !== 0) return null;
    return { name, config };
  }

  /** Best-effort client IP (behind Fly's proxy). Used only for rate-limiting. */
  function clientIp(req: http.IncomingMessage): string {
    const fly = req.headers['fly-client-ip'];
    if (typeof fly === 'string' && fly.length > 0) return fly;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]?.trim() ?? 'unknown';
    return req.socket.remoteAddress ?? 'unknown';
  }

  const authRate = new Map<string, { count: number; resetAt: number }>();
  const AUTH_RATE_WINDOW_MS = 60_000;
  const AUTH_RATE_MAX = 30; // per IP per minute across the auth endpoints

  /** Fixed-window per-IP limiter for the auth endpoints; true = over the cap. */
  function authRateLimited(req: http.IncomingMessage, now: number): boolean {
    return fixedWindowLimited(authRate, clientIp(req), now, AUTH_RATE_WINDOW_MS, AUTH_RATE_MAX);
  }

  // Strict per-IP limiter + 1-hour cache for GET /stats. The snapshot only
  // shifts with real activity, so an hourly recompute is plenty; the cache
  // keeps even the allowed hits off the db, and the low ceiling blocks floods
  // (the aggregate is cheap, but nothing should be hammering an admin probe).
  const statsRate = new Map<string, { count: number; resetAt: number }>();
  const STATS_RATE_WINDOW_MS = 60_000;
  const STATS_RATE_MAX = 6; // per IP per minute — far below auth's 30
  const STATS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  let statsCache: { since: number; body: string; computedAt: number } | null = null;
  const roomProbeRate = new Map<string, { count: number; resetAt: number }>();
  const ROOM_PROBE_WINDOW_MS = 60_000;
  const ROOM_PROBE_PER_IP_MAX = 30;
  const ROOM_PROBE_GLOBAL_MAX = 600;

  async function handleRoomProbe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const now = Date.now();
    if (
      fixedWindowLimited(
        roomProbeRate,
        `ip:${clientIp(req)}`,
        now,
        ROOM_PROBE_WINDOW_MS,
        ROOM_PROBE_PER_IP_MAX,
      ) ||
      fixedWindowLimited(roomProbeRate, 'global', now, ROOM_PROBE_WINDOW_MS, ROOM_PROBE_GLOBAL_MAX)
    ) {
      sendHttpJson(res, 429, { error: 'rate_limited' });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, 4 * 1024);
    } catch {
      sendHttpJson(res, 400, { error: 'bad_request' });
      return;
    }
    const requested =
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as { rooms?: unknown }).rooms)
        ? (body as { rooms: unknown[] }).rooms.slice(0, 8)
        : [];
    const seen = new Set<string>();
    const result: Array<{
      code: string;
      status: RoomStatus;
      seatsFilled: number;
      seatsTotal: number;
    }> = [];
    for (const raw of requested) {
      if (typeof raw !== 'object' || raw === null) continue;
      const codeRaw = (raw as { code?: unknown }).code;
      const token = (raw as { sessionToken?: unknown }).sessionToken;
      if (typeof codeRaw !== 'string' || typeof token !== 'string') continue;
      const code = codeRaw.trim().toUpperCase();
      if (seen.has(code) || !ROOM_CODE_RE.test(code)) continue;
      seen.add(code);
      const room = rooms.get(code);
      const session = sessionsByToken.get(token);
      if (!room || room.closed || !session || session.roomId !== room.id) continue;
      const seats = activeSeats(room.config.players);
      result.push({
        code,
        status: room.status,
        seatsFilled: seats.filter((seat) => sessionAtSeat(room, seat) !== null).length,
        seatsTotal: seats.length,
      });
    }
    sendHttpJson(res, 200, { rooms: result });
  }

  function bearerToken(req: http.IncomingMessage): string | null {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return null;
    const m = /^Bearer (.+)$/.exec(h);
    return m ? (m[1] ?? null) : null;
  }

  /** The user's own account view returned by the auth/profile endpoints. */
  function publicUser(u: UserRow) {
    return {
      id: u.id,
      name: u.name,
      picture: u.picture,
      rating: u.rating,
      gamesPlayed: u.gamesPlayed,
      wins: u.wins,
      losses: u.losses,
      winStreak: u.winStreak,
      bestStreak: u.bestStreak,
      provisional: u.gamesPlayed < PROVISIONAL_GAMES,
    };
  }

  /** Lifetime aggregates for counter-achievement progress (casual+rated). */
  function statsContextFor(u: UserRow): StatsContext {
    const agg = db.userMatchStats(u.id);
    return {
      totalGames: agg.totalGames,
      totalWins: agg.totalWins,
      ratedGames: u.gamesPlayed,
      rating: u.rating,
      bestStreak: u.bestStreak,
      lossStreak: db.currentLossStreak(u.id),
      playedPlayerCounts: agg.playedPlayerCounts,
    };
  }

  /** The full /api/profile body: account + rating history + achievements + title. */
  function profilePayload(u: UserRow) {
    const unlocked = db.getUserAchievements(u.id);
    const unlockedSet = new Set(unlocked.map((a) => a.achievementId));
    const provisional = u.gamesPlayed < PROVISIONAL_GAMES;
    return {
      user: publicUser(u),
      ratingEvents: db.getRatingEventsForUser(u.id, 50),
      achievements: {
        unlocked,
        progress: counterProgress(statsContextFor(u)),
      },
      title: {
        selectedId: u.selectedTitle,
        effectiveId: effectiveTitleId(u.selectedTitle, u.rating, provisional, unlockedSet),
      },
    };
  }

  /** Handles /api/auth-config, /auth/*, /api/profile. Always ends the response. */
  async function handleHttpAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const now = Date.now();
    const path = url.pathname;

    // Public: tells the client which Google client id to use (null = no login).
    if (path === '/api/auth-config' && req.method === 'GET') {
      sendHttpJson(res, 200, { googleClientId });
      return;
    }

    if (authRateLimited(req, now)) {
      sendHttpJson(res, 429, { error: 'rate_limited' });
      return;
    }

    if (path === '/auth/google' && req.method === 'POST') {
      if (!verifyGoogle) {
        sendHttpJson(res, 503, { error: 'login_disabled' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 16 * 1024);
      } catch {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const credential =
        typeof body === 'object' && body !== null && 'credential' in body
          ? (body as { credential: unknown }).credential
          : null;
      if (typeof credential !== 'string' || credential.length === 0) {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const identity = await verifyGoogle(credential);
      if (!identity) {
        sendHttpJson(res, 401, { error: 'invalid_credential' });
        return;
      }
      const user = db.upsertUserByGoogleSub({
        id: randomUUID(),
        googleSub: identity.sub,
        name: identity.name,
        picture: identity.picture,
      });
      const rawToken = mintToken();
      // Keep the token table bounded even during a long-running deployment;
      // startup also performs the same maintenance pass.
      db.pruneExpiredTokens(now);
      db.createAuthToken(hashToken(rawToken), user.id, now + AUTH_TOKEN_TTL_MS);
      sendHttpJson(res, 200, { token: rawToken, user: publicUser(user) });
      return;
    }

    if (path === '/auth/me' && req.method === 'GET') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendHttpJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (path === '/auth/logout' && req.method === 'POST') {
      const token = bearerToken(req);
      if (token) {
        const tokenHash = hashToken(token);
        db.deleteAuthToken(tokenHash);
        unlinkLiveAuthGrant(tokenHash);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/api/profile' && req.method === 'GET') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendHttpJson(res, 200, profilePayload(user));
      return;
    }

    // Choose which earned title to display (or null to revert to the derived
    // rating title). Rejects a title the player has not earned.
    if (path === '/api/profile/title' && req.method === 'POST') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 4 * 1024);
      } catch {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw =
        typeof body === 'object' && body !== null && 'titleId' in body
          ? (body as { titleId: unknown }).titleId
          : undefined;
      if (raw !== null && typeof raw !== 'string') {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const titleId: string | null = raw;
      const provisional = user.gamesPlayed < PROVISIONAL_GAMES;
      const unlocked = db.unlockedAchievementIds(user.id);
      if (
        titleId !== null &&
        !earnedTitles(user.rating, provisional, unlocked).some((t) => t.id === titleId)
      ) {
        sendHttpJson(res, 400, { error: 'title_not_earned' });
        return;
      }
      db.setSelectedTitle(user.id, titleId);
      sendHttpJson(res, 200, {
        title: {
          selectedId: titleId,
          effectiveId: effectiveTitleId(titleId, user.rating, provisional, unlocked),
        },
      });
      return;
    }

    // Saved rule configurations (the lobby "Sääntömuoto" dropdown beyond the
    // built-in "Oletus"). Per-account, capped at MAX_RULE_CONFIGS.
    if (path === '/api/profile/configs' && req.method === 'GET') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendHttpJson(res, 200, {
        configs: db.listRuleConfigs(user.id),
        defaultConfigId: user.defaultConfigId,
      });
      return;
    }

    // Star which saved ruleset is auto-selected for new games (null/"" = the
    // built-in "Oletus"). Must precede the generic '/configs/:id' block below,
    // which would otherwise treat "default" as a config id.
    if (path === '/api/profile/configs/default' && req.method === 'PUT') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 4 * 1024);
      } catch {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw =
        typeof body === 'object' && body !== null && 'configId' in body
          ? (body as { configId: unknown }).configId
          : undefined;
      if (raw !== null && raw !== undefined && typeof raw !== 'string') {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const configId: string | null = typeof raw === 'string' && raw !== '' ? raw : null;
      // Only star a ruleset the account actually owns; "Oletus" (null) is always ok.
      if (configId !== null && !db.listRuleConfigs(user.id).some((c) => c.id === configId)) {
        sendHttpJson(res, 404, { error: 'not_found' });
        return;
      }
      db.setDefaultConfigId(user.id, configId);
      sendHttpJson(res, 200, { defaultConfigId: configId });
      return;
    }

    if (path === '/api/profile/configs' && req.method === 'POST') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const parsed = await parseRuleConfigBody(req);
      if (!parsed) {
        sendHttpJson(res, 400, { error: 'bad_request' });
        return;
      }
      const created = db.createRuleConfig(user.id, randomUUID(), parsed.name, parsed.config, now);
      if (!created) {
        sendHttpJson(res, 409, { error: 'limit_reached', limit: MAX_RULE_CONFIGS });
        return;
      }
      sendHttpJson(res, 200, { config: created });
      return;
    }

    if (path.startsWith('/api/profile/configs/')) {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const id = decodeURIComponent(path.slice('/api/profile/configs/'.length));
      if (req.method === 'DELETE') {
        if (!db.deleteRuleConfig(user.id, id)) {
          sendHttpJson(res, 404, { error: 'not_found' });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        const parsed = await parseRuleConfigBody(req);
        if (!parsed) {
          sendHttpJson(res, 400, { error: 'bad_request' });
          return;
        }
        if (!db.updateRuleConfig(user.id, id, parsed.name, parsed.config, now)) {
          sendHttpJson(res, 404, { error: 'not_found' });
          return;
        }
        sendHttpJson(res, 200, { config: { id, name: parsed.name, config: parsed.config } });
        return;
      }
      sendHttpJson(res, 404, { error: 'not_found' });
      return;
    }

    // GDPR art. 20 (portability): the signed-in user downloads everything we
    // hold about them as JSON. Reuses the same shapes the profile screen sees.
    if (path === '/api/account/export' && req.method === 'GET') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendHttpJson(res, 200, {
        exportedAt: now,
        account: publicUser(user),
        ratingEvents: db.getRatingEventsForUser(user.id, 1000),
        achievements: db.getUserAchievements(user.id),
        ruleConfigs: db.listRuleConfigs(user.id),
        defaultConfigId: user.defaultConfigId,
      });
      return;
    }

    // GDPR art. 17 (erasure): the signed-in user deletes their whole account.
    // deleteUserAccount also removes every auth token, so this token dies too.
    if (path === '/auth/account' && req.method === 'DELETE') {
      const user = resolveAuth(bearerToken(req) ?? undefined);
      if (!user) {
        sendHttpJson(res, 401, { error: 'unauthorized' });
        return;
      }
      db.deleteUserAccount(user.id);
      unlinkLiveUserSessions(user.id);
      res.writeHead(204);
      res.end();
      return;
    }

    sendHttpJson(res, 404, { error: 'not_found' });
  }

  // ── HTTP: healthz + static client (SPA fallback for /r/*) ───────────────────

  const httpServer = http.createServer((req, res) => {
    setHttpSecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/rooms') {
      void handleRoomProbe(req, res).catch(() => {
        if (!res.headersSent) sendHttpJson(res, 500, { error: 'internal' });
      });
      return;
    }
    // Auth + profile JSON API (handles its own methods, incl. POST).
    if (
      url.pathname === '/api/auth-config' ||
      url.pathname === '/api/profile' ||
      url.pathname === '/api/profile/title' ||
      url.pathname.startsWith('/api/profile/configs') ||
      url.pathname === '/api/account/export' ||
      url.pathname.startsWith('/auth/')
    ) {
      void handleHttpAuth(req, res, url).catch(() => {
        if (!res.headersSent) sendHttpJson(res, 500, { error: 'internal' });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    // Matchmaking waiting counts per bucket (players × ranked). Aggregate only —
    // no codes/nicknames — so this exposes activity without leaking any room.
    if (url.pathname === '/api/matchmaking') {
      const buckets: Array<{ players: 2 | 3 | 4; ranked: boolean; waiting: number }> = [];
      for (const players of [2, 3, 4] as const) {
        for (const ranked of [false, true] as const) {
          const code = matchmakingOpen.get(bucketKey(players, ranked));
          const room = code !== undefined ? rooms.get(code) : undefined;
          let waiting = 0;
          if (room && !room.closed && room.status === 'lobby') {
            for (const s of room.sessions.values()) if (s.kind === 'human') waiting++;
          }
          buckets.push({ players, ranked, waiting });
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ buckets }));
      return;
    }
    // Admin activity snapshot: games + unique players today, and total sign-ups.
    // Aggregate counts only (no codes/nicknames), so — like /api/matchmaking —
    // it needs no auth. "Today" is a full local day in Europe/Helsinki, the
    // game's home timezone, so the numbers match what an operator there expects.
    // Strictly rate-limited and cached for an hour (see statsCache above).
    if (url.pathname === '/stats') {
      const now = Date.now();
      if (fixedWindowLimited(statsRate, clientIp(req), now, STATS_RATE_WINDOW_MS, STATS_RATE_MAX)) {
        sendHttpJson(res, 429, { error: 'rate_limited' });
        return;
      }
      const timeZone = 'Europe/Helsinki';
      const since = startOfDayMs(now, timeZone);
      // Recompute only when the cache is empty, expired, or the local day has
      // rolled over (so a new day's zeros never linger behind a stale entry).
      if (
        statsCache === null ||
        statsCache.since !== since ||
        now - statsCache.computedAt >= STATS_CACHE_TTL_MS
      ) {
        const payload = { generatedAt: now, timezone: timeZone, since, ...db.adminStats(since) };
        statsCache = { since, body: JSON.stringify(payload), computedAt: now };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(statsCache.body);
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
    if (pathname.includes('\0')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const canonicalRedirect =
      pathname === '/rules' || pathname === '/rules/'
        ? '/saannot'
        : pathname === '/learn' || pathname === '/learn/'
          ? '/opettele'
          : pathname.startsWith('/learn/')
            ? `/opettele/${pathname.slice('/learn/'.length)}`
            : pathname === '/saannot/'
              ? '/saannot'
              : pathname === '/opettele/'
                ? '/opettele'
                : null;
    if (canonicalRedirect !== null) {
      res.writeHead(308, {
        location: `${canonicalRedirect}${url.search}`,
        'cache-control': 'public, max-age=86400',
      });
      res.end();
      return;
    }
    try {
      serveStatic(pathname, res);
    } catch {
      // Filesystem APIs can reject invalid decoded representations
      // synchronously before their callback is registered.
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
      }
    }
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
    remoteIp: string;
    isAlive: boolean;
    helloTimer: NodeJS.Timeout | null;
    rateStartedAt: number;
    rateMessages: number;
  }
  const socketStates = new Map<WebSocket, SocketState>();

  function armHelloTimer(sock: WebSocket, ctx: SocketState): void {
    if (ctx.helloTimer !== null) clearTimeout(ctx.helloTimer);
    ctx.helloTimer = setTimeout(() => {
      ctx.helloTimer = null;
      if (ctx.session === null) sock.close(1008, 'hello timeout');
    }, wsHelloTimeoutMs);
  }

  wss.on('connection', (sock: WebSocket, req: http.IncomingMessage) => {
    const now = Date.now();
    const remoteIp = clientIp(req);
    const ipSockets = liveSocketsByIp.get(remoteIp) ?? 0;
    if (socketStates.size >= maxSockets || ipSockets >= maxSocketsPerIp) {
      // Do not wait for an attacker to acknowledge a close frame: rejected
      // sockets are intentionally outside socketStates and must not accumulate
      // during ws's close-handshake timeout.
      sock.terminate();
      return;
    }
    const ctx: SocketState = {
      session: null,
      remoteIp,
      isAlive: true,
      helloTimer: null,
      rateStartedAt: now,
      rateMessages: 0,
    };
    // An upgraded socket that never identifies itself otherwise lives forever:
    // ws clients auto-pong, so the heartbeat cannot distinguish it from a real
    // player. Bound the unauthenticated resource lifetime.
    armHelloTimer(sock, ctx);
    socketStates.set(sock, ctx);
    liveSocketsByIp.set(remoteIp, ipSockets + 1);
    sock.on('pong', () => {
      ctx.isAlive = true;
    });
    sock.on('message', (data) => {
      const messageNow = Date.now();
      if (messageNow - ctx.rateStartedAt >= wsRateLimit.windowMs) {
        ctx.rateStartedAt = messageNow;
        ctx.rateMessages = 0;
      }
      ctx.rateMessages += 1;
      if (ctx.rateMessages > wsRateLimit.maxMessages) {
        sock.close(1008, 'message rate exceeded');
        return;
      }
      try {
        handleMessage(sock, data, ctx);
      } catch (err) {
        console.error('[server] message handling failed', err);
        sendJson(sock, { t: 'error', code: 'error.internal' });
      }
    });
    sock.on('close', () => {
      if (ctx.helloTimer !== null) clearTimeout(ctx.helloTimer);
      socketStates.delete(sock);
      const remaining = liveSocketsByIp.get(ctx.remoteIp) ?? 0;
      if (remaining <= 1) liveSocketsByIp.delete(ctx.remoteIp);
      else liveSocketsByIp.set(ctx.remoteIp, remaining - 1);
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
      room.matchRoster = rec.roster;
      room.ratingEligible = rec.ratingEligible;
      for (const sr of rec.sessions) {
        // All seats start disconnected; the reconnect flow handles the rest.
        const session = createSession(sr);
        room.sessions.set(session.token, session);
        sessionsByToken.set(session.token, session);
      }
      if (state.winnerSide !== null) {
        // Crash happened after the final event but before finalize: finish now,
        // including the rating (a crash-during-finalize must not silently drop a
        // rated result). Atomic: finishMatch + ratings commit together.
        const finishedAtMs = Date.now();
        const plan = planMatchRating(room, rec.matchId, state, finishedAtMs);
        const finalNames = activeSeats(room.config.players).map(
          (seat) => sessionAtSeat(room, seat)?.nickname ?? null,
        );
        const winnerSide = state.winnerSide as Side;
        const participants = signedInParticipants(room);
        db.transaction(() => {
          db.finishMatch(rec.matchId, winnerSide, state.scores, finalNames);
          if (plan.result.rated) db.applyRatingResults(plan.updates);
          evaluateMatchAchievements(db, {
            matchId: rec.matchId,
            config: state.config,
            winnerSide,
            finalScores: state.scores,
            participants,
            ratingUpdates: plan.result.rated ? plan.updates : null,
            now: finishedAtMs,
          });
        });
        applyRatingCache(plan);
        room.status = 'finished';
        db.setRoomStatus(room.id, 'finished');
      }
      rooms.set(room.code, room);
      roomsById.set(room.id, room);
      updateTurn(room);
      if (room.status === 'playing') {
        if (state.deal === null) {
          scheduleNextDeal(room, cfg.redealDelayMs, () => authorNextDeal(room));
        } else if (state.deal.phase.name === 'scored' && !isSoloVsBots(room)) {
          // Solo-vs-bots waits for the human's `nextDeal` even across a restart.
          scheduleNextDeal(room, cfg.nextDealDelayMs, () => authorNextDeal(room));
        }
      }
      armIdleTimerIfEmpty(room);
    }
  }

  const bootNow = Date.now();
  db.pruneOldEvents(bootNow - EVENT_RETENTION_MS);
  db.pruneExpiredTokens(bootNow);
  db.pruneInactiveRooms(bootNow - INACTIVE_ROOM_RETENTION_MS);
  // One-time achievement backfill from rated history (guarded by a meta marker).
  try {
    backfillAchievementsOnce(db);
  } catch (err) {
    console.error('[achievements] backfill failed (continuing):', err);
  }
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
