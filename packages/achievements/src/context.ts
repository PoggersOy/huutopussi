/**
 * Pure derivations over a match's per-deal results, plus small event helpers
 * used by the seat-level predicates. Kept out of the predicates themselves so
 * the same running-score / event-segmentation logic has one home.
 */
import type { DealResult, GameEvent, Seat } from '@hp/engine';

/**
 * Cumulative per-side scores after each deal: `running[dealIndex][side]`. Built
 * by accumulating each side's signed `scoreDelta` in deal order — the same
 * numbers that drive the match score, so comeback/lead detection matches what
 * the players saw on the standings overlay.
 */
export function runningScoresFromDeals(deals: DealResult[], nSides: number): number[][] {
  const cumulative = new Array<number>(nSides).fill(0);
  const running: number[][] = [];
  for (const deal of deals) {
    deal.sides.forEach((side, i) => {
      if (i < nSides) cumulative[i] = (cumulative[i] ?? 0) + side.scoreDelta;
    });
    running.push([...cumulative]);
  }
  return running;
}

/**
 * Split a match's event stream into per-deal segments (each starting at a
 * `dealStarted`). Used by seat predicates that must count actions "within one
 * deal" (e.g. changing trump twice). Events before the first deal are dropped.
 */
export function eventsByDeal(events: GameEvent[]): GameEvent[][] {
  const deals: GameEvent[][] = [];
  let current: GameEvent[] | null = null;
  for (const e of events) {
    if (e.type === 'dealStarted') {
      current = [];
      deals.push(current);
    }
    current?.push(e);
  }
  return deals;
}

/** Count of a seat's `trumpSet` declarations across the whole match. */
export function seatTrumpSetCount(events: GameEvent[], seat: Seat): number {
  return events.filter((e) => e.type === 'trumpSet' && e.seat === seat).length;
}
