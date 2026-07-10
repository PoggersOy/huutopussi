/**
 * timers.ts — timing policy + timer slot bookkeeping (plan §Reconnection).
 *
 *  - Per-turn deadline: 45 s default, 10 s for awaitWholeAnswer. On expiry the
 *    seat is marked botControlled ("away") and the bot runner acts, in EVERY
 *    phase (bidding/exchange/declarations/play alike).
 *  - Disconnect mid-turn: the deadline is extended to at least now+graceMs
 *    (30 s) before autoplay kicks in; a disconnect off-turn pauses nothing.
 *  - Reconnect reclaims the seat at the next turn boundary.
 *  - A room with zero connected humans for idleCloseMs (15 min) is persisted
 *    as abandoned and closed.
 *
 * The actual game consequences live in server.ts; this module owns the
 * numbers and the Room timer slots so they are impossible to leak.
 */
import { randomInt } from 'node:crypto';
import type { MatchState } from '@hp/engine';
import type { Room } from './rooms.js';

export interface TimerConfig {
  /** Default per-turn deadline. */
  turnMs: number;
  /** Deadline for the awaitWholeAnswer choice. */
  wholeAnswerMs: number;
  /** Minimum time a disconnected player's turn waits before autoplay. */
  graceMs: number;
  /** Pause between dealScored and the server-authored next dealStarted. */
  nextDealDelayMs: number;
  /** Pause between a redeal demand and the fresh dealStarted. */
  redealDelayMs: number;
  /** Zero connected humans for this long -> room abandoned + closed. */
  idleCloseMs: number;
  /** Humanizing bot delay range [min, max] ms. */
  botDelayMs: [number, number];
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  turnMs: 45_000,
  wholeAnswerMs: 10_000,
  graceMs: 30_000,
  nextDealDelayMs: 6_000,
  redealDelayMs: 1_500,
  idleCloseMs: 15 * 60_000,
  botDelayMs: [500, 1500],
};

/** The turn budget for the current phase of `state`. */
export function turnLimitMs(cfg: TimerConfig, state: MatchState): number {
  return state.deal?.phase.name === 'awaitWholeAnswer' ? cfg.wholeAnswerMs : cfg.turnMs;
}

/** Crypto-random humanizing delay within the configured range. */
export function botDelayMs(cfg: TimerConfig): number {
  const [lo, hi] = cfg.botDelayMs;
  return hi > lo ? randomInt(lo, hi + 1) : lo;
}

/** Clears the turn-expiry and pending-bot timers (every turn boundary). */
export function clearTurnTimers(room: Room): void {
  if (room.timers.turn) {
    clearTimeout(room.timers.turn);
    room.timers.turn = null;
  }
  if (room.timers.bot) {
    clearTimeout(room.timers.bot);
    room.timers.bot = null;
  }
  room.botPending = null;
}

export function clearAllRoomTimers(room: Room): void {
  clearTurnTimers(room);
  if (room.timers.nextDeal) {
    clearTimeout(room.timers.nextDeal);
    room.timers.nextDeal = null;
  }
  clearIdleTimer(room);
}

export function scheduleTurnExpiry(room: Room, ms: number, onExpire: () => void): void {
  if (room.timers.turn) clearTimeout(room.timers.turn);
  room.timers.turn = setTimeout(() => {
    room.timers.turn = null;
    onExpire();
  }, ms);
}

export function scheduleNextDeal(room: Room, ms: number, onDeal: () => void): void {
  if (room.timers.nextDeal) return; // already scheduled
  room.timers.nextDeal = setTimeout(() => {
    room.timers.nextDeal = null;
    onDeal();
  }, ms);
}

export function startIdleTimer(room: Room, ms: number, onExpire: () => void): void {
  if (room.timers.idle) return;
  room.timers.idle = setTimeout(() => {
    room.timers.idle = null;
    onExpire();
  }, ms);
}

export function clearIdleTimer(room: Room): void {
  if (room.timers.idle) {
    clearTimeout(room.timers.idle);
    room.timers.idle = null;
  }
}
