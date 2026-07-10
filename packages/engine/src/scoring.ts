/**
 * Deal scoring (rules doc §5.6–5.7): per-side card points from captured piles,
 * last-trick bonus, marriage points. Declarer side is clamped to exactly the
 * contract when made, −contract when failed. Porvoo applies per SIDE (pinned
 * decision, see config.ts): a trickless opponent side scores −contract; a
 * trickless declarer side scores −2×contract.
 */
import type { RuleConfig } from './config.js';
import { sumCardPoints } from './deck.js';
import type { DealResult, DealState, Seat, Side, SideBreakdown } from './types.js';
import { sideOf } from './types.js';

/** Scores a fully played deal (deal.phase must be at/after the last trick). */
export function scoreDeal(deal: DealState, config: RuleConfig): DealResult {
  if (deal.tricksPlayed !== 9 || deal.lastTrick === null) {
    throw new Error('engine bug: scoreDeal on an unfinished deal');
  }
  if (deal.declarer === null || deal.contract === null) {
    throw new Error('engine bug: scoreDeal without declarer/contract');
  }
  const { declarer, contract } = deal;
  const declarerSide = sideOf(declarer);
  const lastTrickSide = sideOf(deal.lastTrick.winner);

  const breakdown = (side: Side): Omit<SideBreakdown, 'scoreDelta'> => {
    const seats: [Seat, Seat] = side === 0 ? [0, 2] : [1, 3];
    const cardPoints =
      sumCardPoints(deal.captured[seats[0]], config) +
      sumCardPoints(deal.captured[seats[1]], config);
    const tricks = deal.tricksWon[seats[0]] + deal.tricksWon[seats[1]];
    const lastTrickBonus = lastTrickSide === side ? config.lastTrickBonus : 0;
    const marriagePoints = deal.declarations.reduce(
      (acc, d) => (d.side === side ? acc + d.points : acc),
      0,
    );
    return {
      cardPoints,
      lastTrickBonus,
      marriagePoints,
      rawTotal: cardPoints + lastTrickBonus + marriagePoints,
      tricks,
      porvoo: tricks === 0,
    };
  };

  const finish = (b: Omit<SideBreakdown, 'scoreDelta'>, side: Side): SideBreakdown => {
    if (side === declarerSide) {
      if (b.porvoo) return { ...b, scoreDelta: -2 * contract };
      return { ...b, scoreDelta: b.rawTotal >= contract ? contract : -contract };
    }
    return { ...b, scoreDelta: b.porvoo ? -contract : b.rawTotal };
  };

  const s0 = finish(breakdown(0), 0);
  const s1 = finish(breakdown(1), 1);
  const declarerBreakdown = declarerSide === 0 ? s0 : s1;
  const made = !declarerBreakdown.porvoo && declarerBreakdown.rawTotal >= contract;
  return { declarer, contract, made, sides: [s0, s1] };
}
