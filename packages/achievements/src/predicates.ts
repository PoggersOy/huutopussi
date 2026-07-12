/**
 * Small shared helpers for the achievement predicates in `catalogue.ts`. Kept
 * generic so the catalogue reads as a list of one-line conditions.
 */
import type { DealResult, Side } from '@hp/engine';
import { sideOf } from '@hp/engine';
import type { AchievementContext, PredicateResult } from './types.js';

/** A counter achievement: unlocked at `current >= target`, always reports progress. */
export function counter(current: number, target: number): PredicateResult {
  return { unlocked: current >= target, progress: { current: Math.max(0, current), target } };
}

/** A plain (episodic) achievement — no progress bar. */
export function flag(unlocked: boolean): PredicateResult {
  return { unlocked };
}

/** Side that declared this deal's contract, or null for a contract-less deal. */
export function declarerSideOf(deal: DealResult, players: 2 | 3 | 4): Side | null {
  return deal.declarer === null ? null : sideOf(deal.declarer, players);
}

/** True if ANY of this match's deals satisfies `pred`. */
export function someDeal(ctx: AchievementContext, pred: (deal: DealResult) => boolean): boolean {
  return ctx.match.deals.some(pred);
}

/** The highest running score held by any side OTHER than `side` at a snapshot. */
export function maxOtherScore(row: number[], side: Side): number {
  let best = Number.NEGATIVE_INFINITY;
  row.forEach((score, i) => {
    if (i !== side && score > best) best = score;
  });
  return best;
}
