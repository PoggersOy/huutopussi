/**
 * rooms.ts — room registry: 5-char crypto-random codes (roomCodeSchema
 * alphabet), seat bookkeeping derived from sessions, RoomStatePublic
 * projection. The live Room object is the server's unit of game state:
 * per-room monotonic seq, the authoritative MatchState and timer handles.
 */
import { randomBytes } from 'node:crypto';
import type { BotDifficulty } from '@hp/bots';
import type { MatchState, RuleConfig, Seat } from '@hp/engine';
import { activeSeats } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, TableSettings } from '@hp/protocol';
import { isConnected, type Session } from './sessions.js';

/**
 * Internal (ms-precision) form of the wire `TableSettings`. Kept in ms so the
 * server default can inherit the exact `TimerConfig.turnMs` (tests inject
 * sub-second budgets there) while the host-facing wire form stays whole
 * seconds. `roomPublic` converts ms → seconds on the way out.
 */
export interface RoomTableSettings {
  autoplay: boolean;
  turnTimeoutMs: number;
}

/** Exactly the roomCodeSchema alphabet /^[A-HJ-NP-Z2-9]{5}$/ (32 chars). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 5-char crypto-random room code; 32 divides 256 so bytes are unbiased. */
export function generateRoomCode(isTaken: (code: string) => boolean): string {
  for (;;) {
    const bytes = randomBytes(5);
    let code = '';
    for (const b of bytes) code += ROOM_CODE_ALPHABET.charAt(b % 32);
    if (!isTaken(code)) return code;
  }
}

export interface RoomTimerSlots {
  turn: NodeJS.Timeout | null;
  bot: NodeJS.Timeout | null;
  nextDeal: NodeJS.Timeout | null;
  idle: NodeJS.Timeout | null;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

/** Matchmaking disposition of a room; null for a private code-room. */
export interface RoomMatchmaking {
  /** Whether this matchmade room counts for Elo (see planMatchRating). */
  ranked: boolean;
}

export interface Room {
  id: string;
  code: string;
  /** Session token of the seat holding lobby powers (usually the creator). */
  hostToken: string | null;
  config: RuleConfig;
  /** Display name of the active config; null = the built-in "Oletus" default. */
  configName: string | null;
  /** Turn pacing (autoplay + timeout); host-editable, independent of config. */
  tableSettings: RoomTableSettings;
  /** Skill level of bots in this room (Pikapeli setting; default medium). */
  botDifficulty: BotDifficulty;
  status: RoomStatus;
  /** Matchmaking marker (bucket disposition); null = private code-room. */
  matchmaking: RoomMatchmaking | null;
  /** Per-room monotonic message sequence (bumped on every broadcast). */
  seq: number;
  /** Authoritative engine state; null while in lobby. */
  match: MatchState | null;
  matchId: string | null;
  /** Count of events persisted for the current match. */
  eventSeq: number;
  /** All sessions in the room (seated humans, bots, spectators/guests). */
  sessions: Map<string, Session>;
  timers: RoomTimerSlots;
  /** Epoch ms deadline of the current turn (TurnInfo.deadline), if any. */
  turnDeadline: number | null;
  /** Seat a bot action is currently scheduled for (guards double-scheduling). */
  botPending: Seat | null;
  closed: boolean;
}

export function createRoom(init: {
  id: string;
  code: string;
  hostToken: string | null;
  config: RuleConfig;
  configName?: string | null;
  tableSettings: RoomTableSettings;
  matchmaking?: RoomMatchmaking | null;
}): Room {
  return {
    id: init.id,
    code: init.code,
    hostToken: init.hostToken,
    config: init.config,
    configName: init.configName ?? null,
    tableSettings: init.tableSettings,
    botDifficulty: 'medium',
    matchmaking: init.matchmaking ?? null,
    status: 'lobby',
    seq: 0,
    match: null,
    matchId: null,
    eventSeq: 0,
    sessions: new Map(),
    timers: { turn: null, bot: null, nextDeal: null, idle: null },
    turnDeadline: null,
    botPending: null,
    closed: false,
  };
}

export function sessionAtSeat(room: Room, seat: Seat): Session | null {
  for (const s of room.sessions.values()) if (s.seat === seat) return s;
  return null;
}

/**
 * The session currently holding lobby powers. If the recorded host is no
 * longer seated while another human is, host transfers to the lowest-seat
 * human. A disconnected recorded host temporarily yields powers to the lowest
 * connected seated human, so one closed browser cannot strand a live lobby;
 * the original host regains them if it reconnects.
 */
export function hostSessionOf(room: Room): Session | null {
  const recorded = room.hostToken !== null ? (room.sessions.get(room.hostToken) ?? null) : null;
  if (recorded && recorded.seat !== null && isConnected(recorded)) return recorded;
  for (const seat of activeSeats(room.config.players)) {
    const s = sessionAtSeat(room, seat);
    if (s && s.kind === 'human' && isConnected(s)) return s;
  }
  // With nobody connected, retain the stable recorded/fallback identity for
  // persistence and for the next reconnect.
  if (recorded && recorded.seat !== null) return recorded;
  for (const seat of activeSeats(room.config.players)) {
    const s = sessionAtSeat(room, seat);
    if (s && s.kind === 'human') return s;
  }
  return null;
}

/** One SeatInfo per ACTIVE seat (length = config.players; 2p dummy is no seat). */
export function roomPublic(room: Room): RoomStatePublic {
  const seats = activeSeats(room.config.players).map((seat): SeatInfo => {
    const s = sessionAtSeat(room, seat);
    if (!s) {
      return {
        seat,
        nickname: null,
        kind: 'empty',
        connected: false,
        botControlled: false,
        rating: null,
        provisional: false,
      };
    }
    return {
      seat,
      nickname: s.nickname,
      kind: s.kind,
      connected: s.kind === 'bot' ? true : isConnected(s),
      botControlled: s.botControlled,
      // Only signed-in humans have a rating; guests/bots show null.
      rating: s.kind === 'human' ? s.rating : null,
      provisional: s.kind === 'human' ? s.provisional : false,
    };
  });
  const host = hostSessionOf(room);
  return {
    code: room.code,
    seats,
    hostSeat: host ? host.seat : null,
    config: room.config,
    configName: room.configName,
    tableSettings: toWireTableSettings(room.tableSettings),
    status: room.status,
    matchmaking: room.matchmaking,
  };
}

/** Internal ms budget → host-facing whole-second wire form. */
export function toWireTableSettings(ts: RoomTableSettings): TableSettings {
  return { autoplay: ts.autoplay, turnTimeoutSec: Math.round(ts.turnTimeoutMs / 1000) };
}

export function anyHumanConnected(room: Room): boolean {
  for (const s of room.sessions.values()) if (isConnected(s)) return true;
  return false;
}

/** Match readiness: every ACTIVE seat (0..players-1) is filled. */
export function allSeatsFilled(room: Room): boolean {
  return activeSeats(room.config.players).every((seat) => sessionAtSeat(room, seat) !== null);
}
