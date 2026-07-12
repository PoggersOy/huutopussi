/**
 * Small shared helpers for the achievement predicates in `catalogue.ts`. Kept
 * generic so the catalogue reads as a list of one-line conditions.
 */
import type { DealResult, GameEvent, Seat, Side } from '@hp/engine';
import { sideOf } from '@hp/engine';
import { eventsByDeal } from './context.js';
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

/**
 * True if, in ANY deal, `seat` took the koinipakka (talon) and kept EVERY talon
 * card — i.e. discarded only cards from its own hand — and still made the
 * contract. 2-3p only; the talon is the last `talonSize` cards of the deck
 * (layout: hands, then dummy in 2p, then talon). Event-level → going-forward.
 */
export function keptWholeTalonAndWon(events: GameEvent[], seat: Seat, talonSize: number): boolean {
  for (const seg of eventsByDeal(events)) {
    const started = seg.find((e) => e.type === 'dealStarted');
    if (!started || started.type !== 'dealStarted') continue;
    const took = seg.some((e) => e.type === 'talonTaken' && e.seat === seat);
    if (!took) continue;
    const discard = seg.find((e) => e.type === 'cardsDiscarded' && e.seat === seat);
    const scored = seg.find((e) => e.type === 'dealScored');
    if (!discard || discard.type !== 'cardsDiscarded') continue;
    if (!scored || scored.type !== 'dealScored') continue;
    const deck = started.deck;
    if (deck.length < talonSize) continue;
    const talon = deck.slice(deck.length - talonSize);
    const keptWhole = discard.cards.every((card) => !talon.includes(card));
    const won = scored.result.made === true && scored.result.declarer === seat;
    if (keptWhole && won) return true;
  }
  return false;
}
