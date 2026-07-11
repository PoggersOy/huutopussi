/**
 * Plain-HTTP probes to the server that live OUTSIDE the WebSocket protocol.
 * The WS connection is a room-bound singleton, so a multi-room status query
 * (used by the History screen's "open games" list) rides a stateless GET
 * instead. Same-origin in prod (the server serves the client); dev proxies
 * `/api` to :8080 via vite.config.ts. Degrades to `[]` on any failure.
 */

export interface OpenRoom {
  code: string;
  status: 'lobby' | 'playing' | 'finished';
  seatsFilled: number;
  seatsTotal: number;
}

export interface MatchmakingBucket {
  players: 2 | 3 | 4;
  ranked: boolean;
  /** Players currently waiting in this bucket's open room. */
  waiting: number;
}

/**
 * How many players are waiting in each matchmaking bucket. Aggregate only (no
 * room codes/nicknames). Returns [] on any failure.
 */
export async function fetchMatchmaking(): Promise<MatchmakingBucket[]> {
  try {
    const res = await fetch('/api/matchmaking');
    if (!res.ok) return [];
    const data = (await res.json()) as { buckets?: unknown };
    if (!Array.isArray(data.buckets)) return [];
    return data.buckets.filter(
      (b): b is MatchmakingBucket =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as MatchmakingBucket).players === 'number' &&
        typeof (b as MatchmakingBucket).ranked === 'boolean' &&
        typeof (b as MatchmakingBucket).waiting === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * Ask the server which of these room codes are still live. Returns only the
 * rooms that currently exist, in the same order the server saw them; unknown or
 * closed rooms are simply absent. Never throws.
 */
export async function fetchOpenRooms(codes: string[]): Promise<OpenRoom[]> {
  if (codes.length === 0) return [];
  try {
    const res = await fetch(`/api/rooms?codes=${encodeURIComponent(codes.join(','))}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { rooms?: unknown };
    if (!Array.isArray(data.rooms)) return [];
    return data.rooms.filter(
      (r): r is OpenRoom =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as OpenRoom).code === 'string' &&
        typeof (r as OpenRoom).seatsFilled === 'number' &&
        typeof (r as OpenRoom).seatsTotal === 'number',
    );
  } catch {
    return [];
  }
}
