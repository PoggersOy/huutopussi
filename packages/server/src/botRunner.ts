/**
 * botRunner.ts — bot actor selection + turn computation. Bots consume exactly
 * what a human client sees (redacted PlayerView + hints) and their actions go
 * through the SAME action pipeline as WS messages (server.ts submits them).
 *
 * HeuristicBot is being written in parallel in @hp/bots; until it ships we
 * detect it at runtime and fall back to RandomLegalBot, coding only against
 * the Actor interface.
 */
import { randomInt } from 'node:crypto';
import * as botsPkg from '@hp/bots';
import { type Actor, mulberry32, RandomLegalBot } from '@hp/bots';
import type { MatchState, PlayerAction, Seat } from '@hp/engine';
import { allowedActions, redactViewFor } from '@hp/engine';

function cryptoSeed(): number {
  return randomInt(0, 2 ** 31);
}

/** Prefer HeuristicBot when @hp/bots exports it; RandomLegalBot otherwise. */
export function getBot(): Actor {
  const candidate = (botsPkg as Record<string, unknown>).HeuristicBot;
  if (typeof candidate === 'function') {
    try {
      const Ctor = candidate as new (rng: () => number) => Actor;
      const bot = new Ctor(mulberry32(cryptoSeed()));
      if (typeof bot.onTurn === 'function') return bot;
    } catch {
      // Constructor shape mismatch — fall back below.
    }
  }
  return getFallbackBot();
}

/** Always-available legal-move bot (also the retry path on engine mismatch). */
export function getFallbackBot(): Actor {
  return new RandomLegalBot(mulberry32(cryptoSeed()));
}

/**
 * Computes `actor`'s move for `seat` from the same redacted data a client
 * would receive. Never sees MatchState internals.
 */
export async function computeBotAction(
  state: MatchState,
  seat: Seat,
  actor: Actor,
): Promise<PlayerAction> {
  return await actor.onTurn(redactViewFor(state, seat), allowedActions(state, seat));
}
