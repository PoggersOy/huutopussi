/**
 * Deal scoring (rules doc §5.6–5.7): per-side card points from captured piles,
 * last-trick bonus, marriage points. Declarer side is clamped to exactly the
 * contract when made, −contract when failed.
 *
 * Porvoo (architect ruling 2026-07-10, superseding the earlier pin — the rules
 * doc is explicit and wins, see §5.6 + §10 "huudon verran; huutajalle 2 × huuto"):
 *  - Penalties are based on the final BID (huuto), not the possibly-raised
 *    contract (sopimus).
 *  - Opponent side: Porvoo when the SIDE is trickless → scoreDelta = −bid.
 *  - Declarer: Porvoo when the declarer is PERSONALLY trickless ("jos
 *    pelinviejä itse jää ilman tikkejä"), regardless of partner's tricks →
 *    declarer side scores −2×bid, replacing normal contract scoring entirely
 *    (even if the side's raw total would have made the contract).
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
  if (deal.declarer === null || deal.contract === null || deal.bid === null) {
    throw new Error('engine bug: scoreDeal without declarer/contract/bid');
  }
  const { declarer, contract } = deal;
  const bid = deal.bid.amount;
  const declarerSide = sideOf(declarer);
  const lastTrickSide = sideOf(deal.lastTrick.winner);
  const declarerPorvoo = deal.tricksWon[declarer] === 0;

  const breakdown = (side: Side): Omit<SideBreakdown, 'scoreDelta' | 'porvoo'> => {
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
    };
  };

  const finish = (b: Omit<SideBreakdown, 'scoreDelta' | 'porvoo'>, side: Side): SideBreakdown => {
    if (side === declarerSide) {
      if (declarerPorvoo) return { ...b, porvoo: true, scoreDelta: -2 * bid };
      return { ...b, porvoo: false, scoreDelta: b.rawTotal >= contract ? contract : -contract };
    }
    const sidePorvoo = b.tricks === 0;
    return { ...b, porvoo: sidePorvoo, scoreDelta: sidePorvoo ? -bid : b.rawTotal };
  };

  const s0 = finish(breakdown(0), 0);
  const s1 = finish(breakdown(1), 1);
  const declarerBreakdown = declarerSide === 0 ? s0 : s1;
  const made = !declarerPorvoo && declarerBreakdown.rawTotal >= contract;
  return { declarer, contract, made, sides: [s0, s1] };
}
