/**
 * @hp/protocol — the WebSocket wire contract between server and clients.
 * Frozen contract (see CLAUDE.md): server and client are built against this
 * by separate agents; do not change shapes without architect instruction.
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
import type { ActionHint, Card, GameEvent, PlayerView, RuleConfig, Seat } from '@hp/engine';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ── Primitives ───────────────────────────────────────────────────────────────

export const cardSchema = z
  .string()
  .regex(/^[HDCS](A|10|K|Q|J|9|8|7|6)$/) as unknown as z.ZodType<Card>;

export const suitSchema = z.enum(['H', 'D', 'C', 'S']);

export const seatSchema = z.number().int().min(0).max(3) as unknown as z.ZodType<Seat>;

export const nicknameSchema = z.string().trim().min(1).max(20);

/** Room codes are 5 chars, unambiguous alphabet (no 0/O/1/I). */
export const roomCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{5}$/);

// ── Client → server: game actions (mirrors engine PlayerAction) ─────────────

export const playerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bid'), amount: z.number().int().min(0).max(1000) }),
  z.object({ type: z.literal('pass') }),
  z.object({ type: z.literal('demandRedeal') }),
  z.object({ type: z.literal('giveCards'), cards: z.array(cardSchema).min(1).max(6) }),
  z.object({ type: z.literal('setContract'), amount: z.number().int().min(0).max(1000) }),
  z.object({ type: z.literal('returnCards'), cards: z.array(cardSchema).min(1).max(6) }),
  z.object({ type: z.literal('declareOwn'), suit: suitSchema }),
  z.object({ type: z.literal('askWhole') }),
  z.object({ type: z.literal('answerWhole'), suit: suitSchema }),
  z.object({ type: z.literal('askHalf'), suit: suitSchema, rankHeld: z.enum(['K', 'Q']) }),
  z.object({ type: z.literal('playCard'), card: cardSchema }),
]);

// ── Client → server: lobby commands ──────────────────────────────────────────

/** Rule-config fields a room host may override from the lobby (MVP subset). */
export const configPatchSchema = z
  .object({
    cardPoints: z.enum(['A', 'B']),
    lastTrickBonus: z.number().int().min(0).max(50),
    trumpValues: z.enum(['heartsHigh', 'bridge']),
    minBid: z.number().int().min(0).max(200),
    winTarget: z.number().int().min(100).max(2000),
    declareRight: z.enum(['ownLedWonTrick', 'anyWonTrick']),
    showLastTrick: z.boolean(),
  })
  .partial();

export const lobbyCmdSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('takeSeat'), seat: seatSchema }),
  z.object({ type: z.literal('leaveSeat') }),
  z.object({ type: z.literal('setNickname'), nickname: nicknameSchema }),
  z.object({ type: z.literal('addBot'), seat: seatSchema }),
  z.object({ type: z.literal('removeBot'), seat: seatSchema }),
  z.object({ type: z.literal('setConfig'), patch: configPatchSchema }),
  z.object({ type: z.literal('startMatch') }),
  z.object({ type: z.literal('rematch') }),
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

// ── Server → client (trusted; types only) ────────────────────────────────────

export type SeatKind = 'human' | 'bot' | 'empty';

export interface SeatInfo {
  seat: Seat;
  nickname: string | null;
  kind: SeatKind;
  connected: boolean;
  /** True while a disconnected human's seat is being autoplayed by a bot. */
  botControlled: boolean;
}

export interface RoomStatePublic {
  code: string;
  seats: [SeatInfo, SeatInfo, SeatInfo, SeatInfo];
  /** Seat that created the room / holds lobby powers; null if host absent. */
  hostSeat: Seat | null;
  config: RuleConfig;
  status: 'lobby' | 'playing' | 'finished';
}

export interface TurnInfo {
  seat: Seat;
  /** Epoch ms when the turn timer expires and bot autoplay may kick in. */
  deadline: number;
  /** Legal moves — ONLY ever non-null in messages to the acting seat. */
  hints: ActionHint[] | null;
}

export interface MatchSummary {
  finishedAt: number;
  winnerSide: 0 | 1;
  finalScores: [number, number];
  deals: number;
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
