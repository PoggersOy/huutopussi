/**
 * HeuristicBot — a sensible baseline opponent (plan.md §Bots, rules doc §5).
 * Consumes ONLY PlayerView + ActionHints, never MatchState; deterministic for
 * a given injected PRNG (the stream is drawn from only to break exact ties).
 *
 * A BotDifficulty (easy/medium/hard) tunes ONLY bidding/contract aggression via
 * the SKILL table; card play is identical at every level.
 *
 * Strategy:
 *  - BIDDING: hand strength = marriage values held + 11/ace + 10/ten + long
 *    suit bonus, plus (by skill) a fraction of each lone marriage half the
 *    exchange/partner could complete; keep bidding while that covers the next
 *    amount + the skill's margin; respect forced-opening and bid-ban hints;
 *    redeal-eligible hands (>=3 sixes or nothing above jack) are trash by
 *    definition, so always redeal.
 *  - EXCHANGE give: pass the declarer aces, tens and lone marriage halves
 *    (the declarer may complete them); NEVER break an own complete marriage
 *    unless nothing else is left.
 *  - EXCHANGE contract: 12-card strength minus a safety margin, never below
 *    the winning bid.
 *  - EXCHANGE return: lowest-point junk, keeping complete-marriage halves.
 *  - EXCHANGE discard (2-3p koini): lowest non-point junk from the legal set
 *    (aces/tens are never offered), keeping complete-marriage halves.
 *  - DECLARATIONS: declare ASAP, highest marriage value first; own marriage
 *    beats asking; ask the half when holding exactly one half of a suit;
 *    ask the whole only when holding no useful half at all. Asks are 4p-only
 *    (2-3p hints never offer them; partner logic is gated on config.players).
 *  - PLAY: lead aces (or a high own-side trump to draw trump) early and junk
 *    otherwise; when obliged to head the trick — even over the partner — do
 *    it minimally; smear points when the partner has the trick and we play
 *    last; otherwise dump the lowest-point card. K/Q of undeclared suits we
 *    hold both of are saved for the declaration whenever a choice exists.
 */
import type {
  ActionHint,
  Card,
  DealView,
  PlayerAction,
  PlayerView,
  RuleConfig,
  Seat,
  Suit,
  TrickPlay,
} from '@hp/engine';
import {
  beats,
  cardPoints,
  makeCard,
  marriageValue,
  partnerOf,
  rankIndex,
  rankOf,
  SUITS,
  sideOf,
  suitOf,
  winningPlay,
} from '@hp/engine';
import type { Actor } from './actor.js';
import { type Prng, pick } from './prng.js';

/**
 * Bot skill level, chosen per game (e.g. the Pikapeli "Bottien taso" setting).
 * Only bidding/contract aggression varies — card play is identical across
 * levels, so a weaker bot is a more cautious bidder, not a worse card-player.
 */
export type BotDifficulty = 'easy' | 'medium' | 'hard';

interface SkillProfile {
  /** Bid only while bidding strength covers the next amount plus this margin. */
  bidMargin: number;
  /**
   * Fraction of a lone marriage half's value credited while bidding: optimism
   * that the exchange or a partner ask completes it. 0 = ignore the potential.
   */
  completionCredit: number;
  /**
   * Contract = 12-card strength minus this safety margin (never below the bid).
   * Smaller = a tighter, higher contract that extracts more but risks Porvoo.
   */
  contractMargin: number;
  /**
   * Probability of throwing a random legal card instead of the heuristic pick.
   * This is the reliable *strength* dial (a self-play sweep shows monotonic
   * weakening); bidding aggression is not — in this scoring an over-bold bidder
   * actually loses. So a weaker level plays looser cards, not just times its
   * bids differently. 0 = always the full heuristic (the toughest opponent).
   */
  sloppiness: number;
}

/**
 * Difficulty tracks how hard the bot is to BEAT. The reliable dial is card-play
 * quality (`sloppiness`); brave bidding is shared by medium and hard because,
 * in this scoring, pushing bids further would make a bot weaker, not stronger.
 *
 * easy   — a gentle opponent: times bids cautiously (undervalues completable
 *          marriages, needs a fat cushion, sets a safe low contract) AND plays
 *          loosely (a random legal card over half the time), so a human wins
 *          comfortably.
 * medium — brave, sensible bidding (cuts the "everyone passes" deals) but still
 *          slips on roughly a quarter of its card plays.
 * hard   — the same brave bidding, a slightly tighter contract, and ALWAYS the
 *          full heuristic card play: the toughest opponent the heuristics give.
 */
const SKILL: Record<BotDifficulty, SkillProfile> = {
  easy: { bidMargin: 30, completionCredit: 0, contractMargin: 40, sloppiness: 0.55 },
  medium: { bidMargin: 12, completionCredit: 0.2, contractMargin: 20, sloppiness: 0.25 },
  hard: { bidMargin: 12, completionCredit: 0.2, contractMargin: 18, sloppiness: 0 },
};

type BidHint = Extract<ActionHint, { type: 'bid' }>;
type ContractHint = Extract<ActionHint, { type: 'setContract' }>;
type DeclarationHint = Extract<ActionHint, { type: 'declaration' }>;

function findHint<T extends ActionHint['type']>(
  hints: readonly ActionHint[],
  type: T,
): Extract<ActionHint, { type: T }> | undefined {
  return hints.find((h) => h.type === type) as Extract<ActionHint, { type: T }> | undefined;
}

/** Suits whose complete marriage (K+Q) sits in `hand`. */
function marriageSuits(hand: readonly Card[]): Suit[] {
  return SUITS.filter((s) => hand.includes(makeCard(s, 'K')) && hand.includes(makeCard(s, 'Q')));
}

function holdsExactlyOneHalf(hand: readonly Card[], suit: Suit): boolean {
  const k = hand.includes(makeCard(suit, 'K'));
  const q = hand.includes(makeCard(suit, 'Q'));
  return k !== q;
}

/**
 * Bidding/contract strength estimate: marriages held (their marriage value)
 * + 11 per ace + 10 per ten + a small bonus for the longest suit.
 */
function handStrength(hand: readonly Card[], config: RuleConfig): number {
  let strength = 0;
  for (const suit of marriageSuits(hand)) strength += marriageValue(suit, config);
  const lengths: Record<Suit, number> = { H: 0, D: 0, C: 0, S: 0 };
  for (const card of hand) {
    lengths[suitOf(card)]++;
    const rank = rankOf(card);
    if (rank === 'A') strength += 11;
    else if (rank === '10') strength += 10;
  }
  const longest = Math.max(lengths.H, lengths.D, lengths.C, lengths.S);
  strength += Math.max(0, longest - 3) * 5;
  return strength;
}

/**
 * Bidding strength: the plain `handStrength` plus optimism the auction can
 * afford but a contract can't. A lone marriage half (one of K/Q) is often
 * completed by the exchange or a partner ask, so it is worth a fraction of the
 * marriage while bidding — this keeps bolder bots from folding decent hands
 * into contract-less deals, without inflating the (separately estimated)
 * contract. `credit` is the skill level's `completionCredit` (0 disables it).
 */
function bidStrength(hand: readonly Card[], config: RuleConfig, credit: number): number {
  let strength = handStrength(hand, config);
  if (credit > 0) {
    for (const suit of SUITS) {
      if (holdsExactlyOneHalf(hand, suit)) {
        strength += Math.round(marriageValue(suit, config) * credit);
      }
    }
  }
  return strength;
}

/** K/Q cards of suits not yet declared where the hand holds both halves. */
function reservedCards(hand: readonly Card[], declared: readonly Suit[]): Set<Card> {
  const reserved = new Set<Card>();
  for (const suit of marriageSuits(hand)) {
    if (declared.includes(suit)) continue;
    reserved.add(makeCard(suit, 'K'));
    reserved.add(makeCard(suit, 'Q'));
  }
  return reserved;
}

function declaredSuits(deal: DealView): Suit[] {
  return deal.declarations.map((d) => d.suit);
}

function bestSuit(suits: readonly Suit[], config: RuleConfig): Suit {
  if (suits.length === 0) throw new Error('bestSuit: no suits');
  return suits.reduce((a, b) => (marriageValue(b, config) > marriageValue(a, config) ? b : a));
}

/** Lowest-point card; among equals, the weakest rank (stable across suits). */
function lowestJunk(cards: readonly Card[], config: RuleConfig): Card {
  if (cards.length === 0) throw new Error('lowestJunk: no cards');
  return cards.reduce((a, b) => {
    const pa = cardPoints(a, config);
    const pb = cardPoints(b, config);
    if (pb !== pa) return pb < pa ? b : a;
    return rankIndex(rankOf(b)) > rankIndex(rankOf(a)) ? b : a;
  });
}

/** Highest-point card; among equals, the weakest rank. */
function highestPoints(cards: readonly Card[], config: RuleConfig): Card {
  if (cards.length === 0) throw new Error('highestPoints: no cards');
  return cards.reduce((a, b) => {
    const pa = cardPoints(a, config);
    const pb = cardPoints(b, config);
    if (pb !== pa) return pb > pa ? b : a;
    return rankIndex(rankOf(b)) > rankIndex(rankOf(a)) ? b : a;
  });
}

/** The weakest card of a set (highest rank index). */
function weakest(cards: readonly Card[]): Card {
  if (cards.length === 0) throw new Error('weakest: no cards');
  return cards.reduce((a, b) => (rankIndex(rankOf(b)) > rankIndex(rankOf(a)) ? b : a));
}

export class HeuristicBot implements Actor {
  private readonly rng: Prng;
  private readonly skill: SkillProfile;

  constructor(rng: Prng, difficulty: BotDifficulty = 'medium') {
    this.rng = rng;
    this.skill = SKILL[difficulty];
  }

  onTurn(view: PlayerView, hints: ActionHint[]): PlayerAction {
    const deal = view.deal;
    if (!deal) throw new Error('HeuristicBot: no deal in view');
    const config = view.config;
    const hand = deal.hand;

    const bid = findHint(hints, 'bid');
    if (bid) return this.bidAction(bid, hand, config);

    // Exchange-window redeal (redealWindow 'bidAndExchange'): a hand that
    // qualifies is trash by the same argument as in bidding — always redeal.
    if (findHint(hints, 'demandRedeal')) return { type: 'demandRedeal' };

    const give = findHint(hints, 'giveCards');
    if (give) return { type: 'giveCards', cards: giveCards(hand, give.count, config) };

    // 2-3p koini discard: same junk ordering as the 4p return, restricted to
    // the hinted legal set (hand minus aces and tens).
    const discard = findHint(hints, 'discardCards');
    if (discard) {
      return { type: 'discardCards', cards: returnCards(discard.legal, discard.count, config) };
    }

    const contract = findHint(hints, 'setContract');
    if (contract) {
      return {
        type: 'setContract',
        amount: contractAmount(contract, hand, config, this.skill.contractMargin),
      };
    }

    const ret = findHint(hints, 'returnCards');
    if (ret) return { type: 'returnCards', cards: returnCards(hand, ret.count, config) };

    const answer = findHint(hints, 'answerWhole');
    if (answer) return { type: 'answerWhole', suit: bestSuit(answer.suits, config) };

    const declaration = findHint(hints, 'declaration');
    if (declaration) {
      const action = declarationAction(declaration, view, deal, config);
      if (action) return action;
    }

    const play = findHint(hints, 'playCard');
    if (play) return { type: 'playCard', card: this.cardToPlay(play.legal, view, deal, config) };

    throw new Error(`HeuristicBot: no playable hint in ${JSON.stringify(hints)}`);
  }

  private bidAction(hint: BidHint, hand: readonly Card[], config: RuleConfig): PlayerAction {
    // A redeal-eligible hand (>=3 sixes / nothing above jack) is always trash.
    if (hint.canDemandRedeal) return { type: 'demandRedeal' };
    // Forced opening: the hint guarantees `min` is the (only) legal bid.
    if (!hint.canPass) return { type: 'bid', amount: hint.min };
    // Bid ban without forced opening: min > max signals "no legal bid".
    if (hint.min > hint.max) return { type: 'pass' };
    if (bidStrength(hand, config, this.skill.completionCredit) >= hint.min + this.skill.bidMargin) {
      return { type: 'bid', amount: hint.min };
    }
    return { type: 'pass' };
  }

  private cardToPlay(
    legal: readonly Card[],
    view: PlayerView,
    deal: DealView,
    config: RuleConfig,
  ): Card {
    const first = legal[0];
    if (first === undefined) throw new Error('HeuristicBot: empty legal set');
    if (legal.length === 1) return first;
    if (view.viewer === 'spectator') throw new Error('HeuristicBot: spectator has no turn');
    const me = view.viewer;

    // Weaker levels sometimes just play a random legal card — the strength dial.
    if (this.skill.sloppiness > 0 && this.rng() < this.skill.sloppiness) {
      return pick(this.rng, legal);
    }

    // Save undeclared marriage halves we fully hold, whenever a choice exists.
    const reserved = reservedCards(deal.hand, declaredSuits(deal));
    const free = legal.filter((c) => !reserved.has(c));
    const pool = free.length > 0 ? free : [...legal];

    const phase = deal.phase;
    if (phase.name === 'follow' && phase.plays.length > 0) {
      return this.followCard(legal, pool, phase.plays, deal, me, config);
    }
    return this.leadCard(pool, deal, me, config);
  }

  private leadCard(pool: readonly Card[], deal: DealView, me: Seat, config: RuleConfig): Card {
    // Ace leads: an ace led almost always takes 11+ points.
    const aces = pool.filter((c) => rankOf(c) === 'A');
    if (aces.length > 0) return pick(this.rng, aces);
    // Trump-drawing lead when our side owns the trump and we hold its ten.
    const trump = deal.trump;
    if (
      trump !== null &&
      deal.declarations.some((d) => d.suit === trump && d.side === sideOf(me, config.players))
    ) {
      const high = pool.filter(
        (c) => suitOf(c) === trump && rankIndex(rankOf(c)) <= rankIndex('10'),
      );
      if (high.length > 0) return weakest(high);
    }
    return lowestJunk(pool, config);
  }

  private followCard(
    legal: readonly Card[],
    pool: readonly Card[],
    plays: readonly TrickPlay[],
    deal: DealView,
    me: Seat,
    config: RuleConfig,
  ): Card {
    const firstPlay = plays[0];
    if (firstPlay === undefined) throw new Error('HeuristicBot: follow with empty trick');
    const ledSuit = suitOf(firstPlay.card);
    const winning = winningPlay(plays, deal.trump);
    const winners = legal.filter((c) => beats(c, winning.card, ledSuit, deal.trump));
    // Partnership logic is 4p-only: in 2-3p every other seat is an opponent.
    const partnerWinning = config.players === 4 && winning.seat === partnerOf(me);

    if (winners.length === legal.length) {
      // Obliged to head the trick (also over the partner): do it minimally,
      // sparing reserved marriage halves when possible.
      const cheap = winners.filter((c) => pool.includes(c));
      return weakest(cheap.length > 0 ? cheap : winners);
    }

    if (winners.length === 0) {
      // Cannot win: smear points onto the partner's certain trick, else dump.
      if (partnerWinning && plays.length === config.players - 1) return highestPoints(pool, config);
      return lowestJunk(pool, config);
    }

    // Defensive: engine legality makes winners all-or-nothing, but if a mixed
    // set ever appears, win cheaply against opponents and dump under partner.
    if (!partnerWinning) return weakest(winners);
    const losers = pool.filter((c) => !winners.includes(c));
    return lowestJunk(losers.length > 0 ? losers : pool, config);
  }
}

/** Give the declarer our best cards, never a half of an own complete marriage. */
function giveCards(hand: readonly Card[], count: number, config: RuleConfig): Card[] {
  const protectedHalves = reservedCards(hand, []);
  const priority = (c: Card): number => {
    if (protectedHalves.has(c)) return -1000 + cardPoints(c, config);
    const rank = rankOf(c);
    let p = cardPoints(c, config);
    if (rank === 'A') p += 50;
    else if (rank === '10') p += 40;
    else if (rank === 'K' || rank === 'Q') p += 30; // lone half: declarer may complete it
    return p;
  };
  return [...hand].sort((a, b) => priority(b) - priority(a)).slice(0, count);
}

/** Contract from the 12-card hand: bid + a raise trimmed by the skill margin. */
function contractAmount(
  hint: ContractHint,
  hand: readonly Card[],
  config: RuleConfig,
  margin: number,
): number {
  const estimate = handStrength(hand, config) - margin;
  const steps = Math.max(0, Math.floor((estimate - hint.min) / hint.step));
  // Contracts must be absolute step multiples; floor the cap accordingly.
  const cap = Math.floor(hint.max / hint.step) * hint.step;
  return Math.min(cap, hint.min + steps * hint.step);
}

/**
 * The lowest-point junk, keeping complete-marriage halves — used both for the
 * 4p exchange return (from the hand) and the 2-3p koini discard (from the
 * hinted legal set, which is the hand minus aces and tens).
 */
function returnCards(hand: readonly Card[], count: number, config: RuleConfig): Card[] {
  const protectedHalves = reservedCards(hand, []);
  const keepValue = (c: Card): number => {
    const boost = protectedHalves.has(c) ? 1000 : 0;
    // Points dominate; among zero-point cards prefer returning the weakest.
    return boost + cardPoints(c, config) * 10 + (8 - rankIndex(rankOf(c)));
  };
  return [...hand].sort((a, b) => keepValue(a) - keepValue(b)).slice(0, count);
}

/** Declare the highest-value available option ASAP; null = just play a card. */
function declarationAction(
  hint: DeclarationHint,
  view: PlayerView,
  deal: DealView,
  config: RuleConfig,
): PlayerAction | null {
  if (hint.ownSuits.length > 0) {
    return { type: 'declareOwn', suit: bestSuit(hint.ownSuits, config) };
  }
  // Ask the half when holding exactly one half of an undeclared suit.
  const loneHalves = hint.halfAsks.filter(
    (h) =>
      deal.hand.includes(makeCard(h.suit, h.rankHeld)) && holdsExactlyOneHalf(deal.hand, h.suit),
  );
  const bestHalf = loneHalves.reduce<(typeof loneHalves)[number] | null>(
    (best, h) =>
      best === null || marriageValue(h.suit, config) > marriageValue(best.suit, config) ? h : best,
    null,
  );
  if (bestHalf) return { type: 'askHalf', suit: bestHalf.suit, rankHeld: bestHalf.rankHeld };
  // No usable half of our own: ask the partner for a whole marriage (once).
  if (
    hint.canAskWhole &&
    view.viewer !== 'spectator' &&
    !deal.askedWhole[view.viewer] &&
    deal.declarations.length < SUITS.length
  ) {
    return { type: 'askWhole' };
  }
  return null;
}
