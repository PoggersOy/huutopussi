/**
 * @hp/protocol — the WebSocket wire contract between server and clients.
 * Frozen contract (see CLAUDE.md): server and client are built against this
 * by separate agents; do not change shapes without architect instruction.
 * Extended 2026-07-10 (user-authorized contract change) for the illisoft
 * ruleset (docs/illisoft-saannot-spec.md): 2/3/4-player modes, koinipakka
 * discard, contract-less deals, lobby-configurable rule variants.
 * Extended 2026-07-11 (user-authorized) for Google login + Elo: an optional
 * `hello.auth` token (client→server), optional `SeatInfo.rating`/`provisional`
 * and an optional `update.ratings` post-match payload (server→client). All
 * additive and optional — PROTOCOL_VERSION intentionally NOT bumped so open
 * clients degrade to guest rather than being force-closed.
 * Extended 2026-07-11 (user-authorized) for Matchmaking: an optional
 * `hello.matchmaking` intent + a `fillBotsAndStart` lobby command (client→
 * server), and an optional `RoomStatePublic.matchmaking` marker (server→client).
 * Additive/optional — PROTOCOL_VERSION still NOT bumped.
 *
 * Direction rules:
 *  - Client→server messages are UNTRUSTED: they are parsed with zod
 *    (`clientMsgSchema`) before anything touches them.
 *  - Server→client messages are trusted (typed only, no runtime validation).
 *
 * Sync model (supersedes docs/plan.md "event+gap resync" section — decided
 * during the build): the server sends a full redacted snapshot on EVERY state
 * change (`update` message: seq + PlayerView + the redacted triggering event
 * for animations + turn info). Clients replace state wholesale; there is no
 * client-side event replay and therefore no gap-repair logic. `resync` exists
 * only for wake-from-suspend refreshes.
 *
 * Hidden-information rule: `TurnInfo.hints` (server-computed legal moves)
 * reveal hand structure (voids, marriages). Hints MUST be included only in
 * messages sent to the acting seat itself; every other recipient gets
 * `hints: null`.
 */
import type {
  ActionHint,
  Card,
  GameEvent,
  PlayerAction,
  PlayerView,
  RuleConfig,
  Seat,
  Side,
} from '@hp/engine';
import { z } from 'zod';

export const PROTOCOL_VERSION = 2;

// ── Primitives ───────────────────────────────────────────────────────────────

export const cardSchema = z
  .string()
  .regex(/^[HDCS](A|10|K|Q|J|9|8|7|6)$/) as unknown as z.ZodType<Card>;

export const suitSchema = z.enum(['H', 'D', 'C', 'S']);

/** Seat literals stay 0..3 in every mode; whether a seat is ACTIVE for the room's player count (2/3/4) is enforced server-side. */
export const seatSchema = z.number().int().min(0).max(3) as unknown as z.ZodType<Seat>;

export const nicknameSchema = z.string().trim().min(1).max(20);

/** Room codes are 5 chars, unambiguous alphabet (no 0/O/1/I). */
export const roomCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{5}$/);

// ── Client → server: game actions (mirrors engine PlayerAction) ─────────────

/**
 * Card-array bounds are wire-level sanity caps only; exact counts are enforced
 * by the engine. max(6) covers every configurable size: giveCards/returnCards
 * carry `exchangeCount` cards (patchable 1..6) and discardCards carries
 * `talonSize` cards (3 or 6).
 */
export const playerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bid'), amount: z.number().int().min(0).max(1000) }),
  z.object({ type: z.literal('pass') }),
  z.object({ type: z.literal('demandRedeal') }),
  z.object({ type: z.literal('giveCards'), cards: z.array(cardSchema).min(1).max(6) }),
  /** 2-3p koini: declarer discards exactly config.talonSize cards. */
  z.object({ type: z.literal('discardCards'), cards: z.array(cardSchema).min(1).max(6) }),
  z.object({ type: z.literal('setContract'), amount: z.number().int().min(0).max(1000) }),
  z.object({ type: z.literal('returnCards'), cards: z.array(cardSchema).min(1).max(6) }),
  z.object({ type: z.literal('declareOwn'), suit: suitSchema }),
  z.object({ type: z.literal('askWhole') }),
  z.object({ type: z.literal('answerWhole'), suit: suitSchema }),
  z.object({ type: z.literal('askHalf'), suit: suitSchema, rankHeld: z.enum(['K', 'Q']) }),
  z.object({ type: z.literal('playCard'), card: cardSchema }),
]);

/**
 * Compile-time drift guard: the parsed action type must be mutually
 * assignable with the engine's PlayerAction — a variant missing from either
 * side (or a payload shape mismatch) fails to typecheck.
 */
type _PlayerActionSchemaMatchesEngine = [z.infer<typeof playerActionSchema>, PlayerAction] extends [
  PlayerAction,
  z.infer<typeof playerActionSchema>,
]
  ? true
  : never;
const _playerActionSchemaMatchesEngine: _PlayerActionSchemaMatchesEngine = true;
void _playerActionSchemaMatchesEngine;

// ── Client → server: lobby commands ──────────────────────────────────────────

/**
 * Rule-config fields a room host may override from the lobby (host-only).
 *
 * Application order (server-side): `preset` first — it resets the room config
 * to the named base ruleset (DEFAULT_RULES for 'paamuoto', ILLISOFT_RULES for
 * 'illisoft'; `preset` is NOT itself a RuleConfig field) — then the remaining
 * fields override individual values on top of that base.
 *
 * Every field is zod-bounded, but only per-field: CROSS-FIELD validity
 * (talonSize/openTalon apply to 2-3p only, exchangeCount/contractTiming/
 * askLockouts to 4p only, minBid ≤ maxBid, patches rejected mid-match, etc.)
 * is enforced server-side when the patch is applied.
 */
export const configPatchSchema = z
  .object({
    preset: z.enum(['paamuoto', 'illisoft']),
    players: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    talonSize: z.union([z.literal(3), z.literal(6)]),
    openTalon: z.boolean(),
    cardPoints: z.enum(['A', 'B']),
    lastTrickBonus: z.number().int().min(0).max(50),
    trumpValues: z.enum(['heartsHigh', 'bridge']),
    minBid: z.number().int().min(0).max(200).multipleOf(5),
    maxBid: z.number().int().min(5).max(1000).multipleOf(5).nullable(),
    forcedOpening: z.boolean(),
    allPassOutcome: z.enum(['forceLastSeat', 'contractlessDeal']),
    contractTiming: z.enum(['beforeReturn', 'afterExchange']),
    exchangeCount: z.number().int().min(1).max(6),
    declareRight: z.enum(['ownLedWonTrick', 'anyWonTrick']),
    askLockouts: z.enum(['illisoft', 'basic']),
    bidBanThreshold: z.number().int().min(-2000).max(0).nullable(),
    bidBanReopen: z.boolean(),
    winTarget: z.number().int().min(100).max(2000),
    winCondition: z.enum(['exceed', 'reach']),
    winTiebreak: z.enum(['declarer', 'higher']),
    firstTrickRules: z.enum(['aceShow', 'free']),
    opponentRounding: z.enum(['nearest5', 'none']),
    declarerPorvooBasis: z.enum(['bid', 'contract']),
    declarerPorvooScope: z.enum(['seat', 'side']),
    redealCondition: z.enum(['fourSixes', 'threeSixesOrNoneAboveJack']).nullable(),
    redealWindow: z.enum(['firstBidTurn', 'bidAndExchange']),
    showLastTrick: z.boolean(),
  })
  .partial();

/**
 * Per-room TABLE settings — turn pacing, NOT game rules. Kept deliberately
 * separate from RuleConfig (the engine's frozen, deterministic, timer-free
 * contract): autoplay and the turn timeout are a room/server concern the engine
 * knows nothing about. The host edits them from the lobby (and may change them
 * mid-match) via `setTableSettings`; the resolved values ride on RoomStatePublic.
 */
export interface TableSettings {
  /**
   * When true, a PRESENT player who doesn't act within `turnTimeoutSec` is
   * marked away and a bot plays their turn. When false, present players get
   * unlimited time — but a DISCONNECTED player is still auto-played after a
   * short grace, so one dropped player can't freeze the table.
   */
  autoplay: boolean;
  /** Per-turn think budget in whole seconds, applied while autoplay is on. */
  turnTimeoutSec: number;
}

/** Host-editable table-settings patch (host-only; allowed mid-match). */
export const tableSettingsPatchSchema = z
  .object({
    autoplay: z.boolean(),
    turnTimeoutSec: z.number().int().min(15).max(600),
  })
  .partial();

export const lobbyCmdSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('takeSeat'), seat: seatSchema }),
  z.object({ type: z.literal('leaveSeat') }),
  z.object({ type: z.literal('setNickname'), nickname: nicknameSchema }),
  z.object({ type: z.literal('addBot'), seat: seatSchema }),
  z.object({ type: z.literal('removeBot'), seat: seatSchema }),
  z.object({ type: z.literal('setConfig'), patch: configPatchSchema }),
  // Host-only: change turn pacing (autoplay + timeout); allowed mid-match.
  z.object({ type: z.literal('setTableSettings'), patch: tableSettingsPatchSchema }),
  z.object({ type: z.literal('startMatch') }),
  z.object({ type: z.literal('rematch') }),
  // Host-only: fill empty active seats with bots and start now. Used by the
  // matchmaking waiting view's "Start with bots"; bots make the match unranked.
  z.object({ type: z.literal('fillBotsAndStart') }),
  // Host-only: abort an ongoing match and close the room (all clients dropped).
  z.object({ type: z.literal('stopMatch') }),
]);

// ── Client → server: envelope ────────────────────────────────────────────────

export const clientMsgSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.number().int(),
    /** Omitted roomCode = create a new room. */
    roomCode: roomCodeSchema.optional(),
    sessionToken: z.string().uuid().optional(),
    nickname: nicknameSchema.optional(),
    /**
     * Opaque app auth token (see /auth/google). When present and valid, the
     * server binds this connection to the signed-in account and defaults the
     * nickname to the Google name. A stale/invalid token degrades to guest —
     * it never rejects the join. Optional, so pre-auth clients omit it.
     */
    auth: z.string().optional(),
    /**
     * Matchmaking intent: instead of creating/joining a specific room, ask the
     * server to auto-join an open matchmade room for this bucket (or open one)
     * and auto-start it when full. `ranked` requires a valid `auth` token.
     * Mutually exclusive with roomCode; the code is learned from `welcome`.
     */
    matchmaking: z
      .object({
        players: z.union([z.literal(2), z.literal(3), z.literal(4)]),
        ranked: z.boolean(),
      })
      .optional(),
    /**
     * Initial room config (preset + overrides), applied at creation exactly
     * like a lobby setConfig patch. Only meaningful when creating a room
     * (roomCode omitted); ignored on join/rejoin.
     */
    config: configPatchSchema.optional(),
  }),
  z.object({
    t: z.literal('action'),
    actionId: z.string().uuid(),
    knownSeq: z.number().int().nonnegative(),
    action: playerActionSchema,
  }),
  z.object({
    t: z.literal('lobby'),
    actionId: z.string().uuid(),
    cmd: lobbyCmdSchema,
  }),
  z.object({ t: z.literal('resync') }),
  z.object({ t: z.literal('ping') }),
]);

export type ClientMsg = z.infer<typeof clientMsgSchema>;
export type LobbyCmd = z.infer<typeof lobbyCmdSchema>;
export type ConfigPatch = z.infer<typeof configPatchSchema>;
export type TableSettingsPatch = z.infer<typeof tableSettingsPatchSchema>;

/**
 * Compile-time guard: every tableSettingsPatch field must exist on
 * TableSettings with an assignable type (mirrors the ConfigPatch guard above).
 */
type _TableSettingsPatchSubset = {
  [K in keyof TableSettingsPatch]-?: Exclude<TableSettingsPatch[K], undefined>;
} extends Pick<TableSettings, keyof TableSettingsPatch>
  ? true
  : never;
const _tableSettingsPatchSubset: _TableSettingsPatchSubset = true;
void _tableSettingsPatchSubset;

/**
 * Compile-time drift guard: every configPatchSchema field except `preset`
 * must exist on RuleConfig with an assignable type. Fails to typecheck if
 * the patch schema and the engine contract diverge. (The mapped type strips
 * the `| undefined` that exactOptionalPropertyTypes keeps on partials.)
 */
type _ConfigPatchIsRuleConfigSubset = {
  [K in keyof Omit<ConfigPatch, 'preset'>]-?: Exclude<ConfigPatch[K], undefined>;
} extends Pick<RuleConfig, keyof Omit<ConfigPatch, 'preset'>>
  ? true
  : never;
const _configPatchIsRuleConfigSubset: _ConfigPatchIsRuleConfigSubset = true;
void _configPatchIsRuleConfigSubset;

// ── Server → client (trusted; types only) ────────────────────────────────────

export type SeatKind = 'human' | 'bot' | 'empty';

export interface SeatInfo {
  seat: Seat;
  nickname: string | null;
  kind: SeatKind;
  connected: boolean;
  /** True while a disconnected human's seat is being autoplayed by a bot. */
  botControlled: boolean;
  /** Elo of the signed-in account in this seat; null for guests/bots. */
  rating?: number | null;
  /** True while that account is still provisional (< PROVISIONAL_GAMES games). */
  provisional?: boolean;
}

export interface RoomStatePublic {
  code: string;
  /** One entry per active seat: length === config.players (2, 3 or 4). */
  seats: SeatInfo[];
  /** Seat that created the room / holds lobby powers; null if host absent. */
  hostSeat: Seat | null;
  config: RuleConfig;
  /** Turn pacing (autoplay + timeout); host-editable, independent of RuleConfig. */
  tableSettings: TableSettings;
  status: 'lobby' | 'playing' | 'finished';
  /**
   * Set for matchmade rooms (null for private code-rooms). The client renders a
   * "searching / waiting" lobby instead of the normal share/config lobby, and
   * `ranked` drives whether the match counts for Elo (see planMatchRating).
   */
  matchmaking?: { ranked: boolean } | null;
}

export interface TurnInfo {
  seat: Seat;
  /**
   * Epoch ms when the turn timer expires and bot autoplay kicks in, or null for
   * NO time limit — the room's host has turned autoplay off, so the present
   * actor has unlimited time. Clients show the countdown only when non-null.
   */
  deadline: number | null;
  /** Legal moves — ONLY ever non-null in messages to the acting seat. */
  hints: ActionHint[] | null;
}

export interface MatchSummary {
  finishedAt: number;
  /** 4p: 0|1 (pairs). 2-3p: side === seat, so 0|1|2. */
  winnerSide: Side;
  /** One total per side: length === sideCount(config) (2 or 3). */
  finalScores: number[];
  deals: number;
}

/** Per-seat rating outcome of a finished match. */
export interface SeatRatingResult {
  seat: Seat;
  userId: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * Rating outcome attached to the `update` that carries the `matchEnded` event.
 * `rated: false` (with an empty `perSeat`) means the match did not count —
 * bots, guests, or the same account in two seats. Only signed-in seats appear.
 */
export interface MatchRatingResult {
  rated: boolean;
  perSeat: SeatRatingResult[];
}

export type ServerMsg =
  | {
      t: 'welcome';
      v: number;
      sessionToken: string;
      room: RoomStatePublic;
      /** null = connected as spectator/lobby guest. */
      seat: Seat | null;
      seq: number;
      /** null while the room is in lobby (no active match). */
      view: PlayerView | null;
      turn: TurnInfo | null;
    }
  /** Lobby/seating/config change (no game-state change). */
  | { t: 'room'; seq: number; room: RoomStatePublic }
  /**
   * Game-state change: full redacted snapshot + the (redacted) triggering
   * event for client-side animation/toasts. Clients replace state wholesale.
   */
  | {
      t: 'update';
      seq: number;
      view: PlayerView;
      event: GameEvent | null;
      turn: TurnInfo | null;
      room?: RoomStatePublic;
      /** Present only on the update carrying a `matchEnded` event. */
      ratings?: MatchRatingResult;
    }
  | {
      t: 'error';
      refActionId?: string;
      /** i18n key, e.g. 'error.mustHeadTrick'. */
      code: string;
      params?: Record<string, string | number>;
    }
  | { t: 'history'; matches: MatchSummary[] }
  | { t: 'pong' };
