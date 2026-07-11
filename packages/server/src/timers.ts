/**
 * timers.ts — timing policy + timer slot bookkeeping (plan §Reconnection).
 *
 *  - Per-turn deadline: seeds each new room's host-editable turn timeout (90 s
 *    default), capped at wholeAnswerMs (10 s) for the awaitWholeAnswer choice.
 *    On expiry the away seat is marked botControlled and the bot runner acts,
 *    in EVERY phase (bidding/exchange/declarations/play alike) — UNLESS the
 *    room's host has turned autoplay off, in which case a present player has
 *    unlimited time (see server.ts updateTurn / tableSettings).
 *  - Disconnect mid-turn: the deadline is extended so a dropped player has at
 *    least a full turn — max(graceMs, the room's host-editable turn budget) —
 *    to reconnect before autoplay kicks in, even with autoplay off, so one
 *    dropped player can't freeze the table; a disconnect off-turn pauses nothing.
 *  - Reconnect reclaims the seat immediately, re-arming a full fresh turn.
 *  - A room with zero connected humans for idleCloseMs (15 min) is persisted
 *    as abandoned and closed.
 *
 * The actual game consequences live in server.ts; this module owns the
 * numbers and the Room timer slots so they are impossible to leak.
 */
import { randomInt } from 'node:crypto';
import type { Room } from './rooms.js';

export interface TimerConfig {
  /** Default per-turn budget; seeds a new room's (host-editable) turn timeout. */
  turnMs: number;
  /** Hard cap for the awaitWholeAnswer choice (never longer than the budget). */
  wholeAnswerMs: number;
  /**
   * Floor for a disconnected player's reconnect window before autoplay. The
   * effective grace is `max(graceMs, room turn budget)`, so a dropped player
   * always gets at least a full (host-editable) turn to come back.
   */
  graceMs: number;
  /**
   * Pause between dealScored and the server-authored next dealStarted, in a
   * MULTI-HUMAN room. A solo-vs-bots room does not auto-advance at all — the
   * sole human advances with the `nextDeal` command ("Jatka") — so this delay
   * never applies there (see server.ts isSoloVsBots).
   */
  nextDealDelayMs: number;
  /** Pause between a redeal demand and the fresh dealStarted. */
  redealDelayMs: number;
  /** Zero connected humans for this long -> room abandoned + closed. */
  idleCloseMs: number;
  /** Humanizing bot delay range [min, max] ms. */
  botDelayMs: [number, number];
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  turnMs: 90_000,
  wholeAnswerMs: 10_000,
  // Floor only; the effective reconnect grace is at least the room's turn
  // budget (default 90 s == turnMs). See the graceMs field doc above.
  graceMs: 90_000,
  nextDealDelayMs: 20_000,
  redealDelayMs: 5_000,
  idleCloseMs: 15 * 60_000,
  botDelayMs: [500, 1200],
};

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
