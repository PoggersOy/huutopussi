/**
 * sessions.ts — session objects keyed by uuid token, bound to
 * (roomId, seat, nickname). Humans hold (at most) one live socket
 * (last-connect-wins rebinding happens in server.ts); bot seats are sessions
 * without sockets. Each session carries an LRU of its last processed
 * actionIds so duplicated actions replay the original response verbatim
 * instead of being re-applied.
 */
import type { Actor } from '@hp/bots';
import type { Seat } from '@hp/engine';
import type { WebSocket } from 'ws';

export type SessionKind = 'human' | 'bot';

export interface Session {
  token: string;
  roomId: string;
  /** null = spectator / lobby guest. */
  seat: Seat | null;
  nickname: string | null;
  kind: SessionKind;
  /** Signed-in account behind this session, or null for a guest/bot. */
  userId: string | null;
  /**
   * Cached Elo of the signed-in account for lobby display. Refreshed at
   * sign-in and after each rated match; null for guests/bots.
   */
  rating: number | null;
  /** Cached provisional flag (account still below PROVISIONAL_GAMES). */
  provisional: boolean;
  /** Live socket; null when disconnected (always null for bots). */
  socket: WebSocket | null;
  /** True while a disconnected/afk human's seat is autoplayed by a bot. */
  botControlled: boolean;
  /** Reconnected human waiting for the next turn boundary to reclaim its seat. */
  reclaimPending: boolean;
  /** actionId -> serialized direct response (idempotent replay), LRU-capped. */
  responses: Map<string, string>;
  /** Lazily created bot actor (bot seats and botControlled human seats). */
  bot?: Actor;
}

/** Idempotency LRU size: the last N actionIds per session. */
export const ACTION_LRU_SIZE = 64;

export function createSession(init: {
  token: string;
  roomId: string;
  seat: Seat | null;
  nickname: string | null;
  kind: SessionKind;
  userId?: string | null;
  rating?: number | null;
  provisional?: boolean;
}): Session {
  return {
    token: init.token,
    roomId: init.roomId,
    seat: init.seat,
    nickname: init.nickname,
    kind: init.kind,
    userId: init.userId ?? null,
    rating: init.rating ?? null,
    provisional: init.provisional ?? false,
    socket: null,
    botControlled: false,
    reclaimPending: false,
    responses: new Map(),
  };
}

/** ws readyState OPEN (numeric to avoid importing the class as a value). */
const WS_OPEN = 1;

export function isConnected(session: Session): boolean {
  return session.socket !== null && session.socket.readyState === WS_OPEN;
}

/** Remembers the direct response for `actionId`, evicting the oldest entry. */
export function rememberResponse(session: Session, actionId: string, json: string): void {
  if (session.responses.has(actionId)) session.responses.delete(actionId);
  session.responses.set(actionId, json);
  while (session.responses.size > ACTION_LRU_SIZE) {
    const oldest = session.responses.keys().next().value;
    if (oldest === undefined) break;
    session.responses.delete(oldest);
  }
}

/**
 * If `actionId` was already processed, re-send the original response and
 * report true (the action must NOT be applied again).
 */
export function replayCachedResponse(session: Session, actionId: string): boolean {
  const json = session.responses.get(actionId);
  if (json === undefined) return false;
  // Touch for LRU recency.
  session.responses.delete(actionId);
  session.responses.set(actionId, json);
  if (isConnected(session) && session.socket) session.socket.send(json);
  return true;
}

export function sendRawTo(session: Session, json: string): void {
  if (isConnected(session) && session.socket) session.socket.send(json);
}
