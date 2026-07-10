/**
 * localStorage-backed local memory: recently visited rooms (Home screen list)
 * and per-room match summaries received via 'history' server messages
 * (History screen). The server only pushes 'history' when a match finishes,
 * so summaries are persisted locally to survive reloads. All functions are
 * safe under missing/blocked localStorage (private mode) — they degrade to
 * empty results / no-ops.
 */
import type { MatchSummary } from '@hp/protocol';

// ── Recent rooms ─────────────────────────────────────────────────────────────

const RECENT_KEY = 'hp:recentRooms';
export const RECENT_LIMIT = 8;

export interface RecentRoom {
  code: string;
  /** Epoch ms of the latest visit. */
  at: number;
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — the list simply isn't persisted.
  }
}

export function loadRecentRooms(): RecentRoom[] {
  const raw = readJson(RECENT_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is RecentRoom =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as RecentRoom).code === 'string' &&
      typeof (r as RecentRoom).at === 'number',
  );
}

/** Upsert a room to the front of the recents list (newest first, capped). */
export function recordRecentRoom(code: string, now = Date.now()): void {
  const normalized = code.toUpperCase();
  const rest = loadRecentRooms().filter((r) => r.code !== normalized);
  writeJson(RECENT_KEY, [{ code: normalized, at: now }, ...rest].slice(0, RECENT_LIMIT));
}

// ── Match history (from 'history' server messages) ──────────────────────────

const HISTORY_PREFIX = 'hp:history:';

export interface HistoryEntry {
  roomCode: string;
  match: MatchSummary;
}

function isMatchSummary(m: unknown): m is MatchSummary {
  if (typeof m !== 'object' || m === null) return false;
  const s = m as MatchSummary;
  // Variant-ready per the frozen @hp/protocol MatchSummary: 4p has 2 sides
  // (winnerSide 0|1), 2-3p has one side per seat (winnerSide up to 2), so
  // finalScores holds sideCount(config) totals (2 or 3) and winnerSide indexes
  // into it. Hardcoding 2 sides silently dropped every 3-player summary.
  return (
    typeof s.finishedAt === 'number' &&
    Number.isInteger(s.winnerSide) &&
    Array.isArray(s.finalScores) &&
    (s.finalScores.length === 2 || s.finalScores.length === 3) &&
    s.finalScores.every((n) => typeof n === 'number') &&
    s.winnerSide >= 0 &&
    s.winnerSide < s.finalScores.length &&
    typeof s.deals === 'number'
  );
}

/** The server sends the room's FULL summary list each time; replace wholesale. */
export function recordRoomHistory(roomCode: string, matches: MatchSummary[]): void {
  writeJson(HISTORY_PREFIX + roomCode.toUpperCase(), matches);
}

export function loadRoomHistory(roomCode: string): MatchSummary[] {
  const raw = readJson(HISTORY_PREFIX + roomCode.toUpperCase());
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMatchSummary);
}

/** Every stored match across all rooms, newest first. */
export function loadAllHistory(): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(HISTORY_PREFIX)) continue;
      const roomCode = key.slice(HISTORY_PREFIX.length);
      for (const match of loadRoomHistory(roomCode)) entries.push({ roomCode, match });
    }
  } catch {
    return [];
  }
  return entries.sort((a, b) => b.match.finishedAt - a.match.finishedAt);
}
