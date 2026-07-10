/**
 * Deal scoring (rules doc §5.6–5.7; illisoft spec §8): per-side card points
 * from captured piles, last-trick bonus, marriage points, plus (2-3p) the
 * declarer's koini discards when the side won at least one trick. The
 * declarer side is clamped to exactly the contract when made (UNROUNDED raw
 * comparison), −contract when failed.
 *
 * Porvoo:
 *  - Opponent side: trickless → scoreDelta = −bid (the winning bid, never the
 *    raised contract — both rulesets agree, architect ruling 2026-07-10).
 *  - Declarer: judged at config.declarerPorvooScope ('seat': the declarer
 *    personally trickless, päämuoto; 'side': the whole side, illisoft) →
 *    −2 × config.declarerPorvooBasis (bid | contract), replacing contract
 *    scoring entirely.
 *
 * Other config gates: opponentRounding rounds non-declarer raw totals to the
 * nearest 5; a contract-less deal (declarer null) scores every side its
 * roundedTotal with no penalties; a 2p läpäri (all tricks) counts the full
 * deck's card points (totalDealPoints) regardless of what the dummy/talon
 * held, with discards inside that notional total.
 */
import type { RuleConfig } from './config.js';
import { totalDealPoints } from './config.js';
import { sumCardPoints } from './deck.js';
import type { DealResult, DealState, Seat, Side, SideBreakdown } from './types.js';
import { sideCount, sideOf, tricksPerDeal } from './types.js';

/** Scores a fully played deal (deal.phase must be at/after the last trick). */
export function scoreDeal(deal: DealState, config: RuleConfig): DealResult {
  const nTricks = tricksPerDeal(config);
  if (deal.tricksPlayed !== nTricks || deal.lastTrick === null) {
    throw new Error('engine bug: scoreDeal on an unfinished deal');
  }
  const players = config.players;
  const declarer = deal.declarer;
  const declarerSide = declarer === null ? null : sideOf(declarer, players);
  const lastTrickSide = sideOf(deal.lastTrick.winner, players);

  const seatsOf = (side: Side): Seat[] =>
    players === 4 ? (side === 0 ? [0, 2] : [1, 3]) : [side as number as Seat];

  const round = (raw: number): number =>
    config.opponentRounding === 'nearest5' ? Math.round(raw / 5) * 5 : raw;

  const breakdown = (side: Side): Omit<SideBreakdown, 'scoreDelta' | 'porvoo'> => {
    let cardPoints = 0;
    let tricks = 0;
    for (const s of seatsOf(side)) {
      cardPoints += sumCardPoints(deal.captured[s], config);
      tricks += deal.tricksWon[s];
    }
    let lastTrickBonus = lastTrickSide === side ? config.lastTrickBonus : 0;
    const marriagePoints = deal.declarations.reduce(
      (acc, d) => (d.side === side ? acc + d.points : acc),
      0,
    );
    let discardPoints =
      side === declarerSide && deal.discarded !== null && tricks >= 1
        ? sumCardPoints(deal.discarded, config)
        : 0;
    // 2p läpäri: every trick won counts the full deck's card points regardless
    // of what the dummy/talon held; discards sit inside that notional total.
    if (players === 2 && tricks === nTricks) {
      cardPoints = totalDealPoints(config) - config.lastTrickBonus;
      lastTrickBonus = config.lastTrickBonus;
      discardPoints = 0;
    }
    const rawTotal = cardPoints + lastTrickBonus + marriagePoints + discardPoints;
    return {
      cardPoints,
      lastTrickBonus,
      marriagePoints,
      discardPoints,
      rawTotal,
      roundedTotal: round(rawTotal),
      tricks,
    };
  };

  const allSides = Array.from({ length: sideCount(config) }, (_, i) => i as Side);

  // Contract-less deal (everyone passed): rounded raw totals, no penalties.
  if (declarer === null) {
    if (deal.bid !== null || deal.contract !== null) {
      throw new Error('engine bug: contract-less deal with a bid/contract');
    }
    const sides = allSides.map((side) => {
      const b = breakdown(side);
      return { ...b, porvoo: false, scoreDelta: b.roundedTotal };
    });
    return { declarer: null, contract: null, bid: null, made: null, sides };
  }

  if (deal.contract === null || deal.bid === null) {
    throw new Error('engine bug: scoreDeal without contract/bid');
  }
  const contract = deal.contract;
  const bid = deal.bid.amount;

  const finish = (b: Omit<SideBreakdown, 'scoreDelta' | 'porvoo'>, side: Side): SideBreakdown => {
    if (side === declarerSide) {
      const porvoo =
        config.declarerPorvooScope === 'seat' ? deal.tricksWon[declarer] === 0 : b.tricks === 0;
      if (porvoo) {
        const basis = config.declarerPorvooBasis === 'bid' ? bid : contract;
        return { ...b, porvoo: true, scoreDelta: -2 * basis };
      }
      return { ...b, porvoo: false, scoreDelta: b.rawTotal >= contract ? contract : -contract };
    }
    const sidePorvoo = b.tricks === 0;
    return { ...b, porvoo: sidePorvoo, scoreDelta: sidePorvoo ? -bid : b.roundedTotal };
  };

  const sides = allSides.map((side) => finish(breakdown(side), side));
  const declarerBreakdown = sides[declarerSide as number];
  if (!declarerBreakdown) throw new Error('engine bug: declarer side missing from breakdowns');
  const made = !declarerBreakdown.porvoo && declarerBreakdown.rawTotal >= contract;
  return { declarer, contract, bid, made, sides };
}
