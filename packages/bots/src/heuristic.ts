/**
 * HeuristicBot — the opponent behind every difficulty level (plan.md §Bots,
 * rules doc §5). Consumes ONLY PlayerView + ActionHints, never MatchState;
 * deterministic for a given injected PRNG.
 *
 * Each BotDifficulty is a SkillProfile, and the levels form a strict ladder —
 * each one adds a capability on top of the previous (verified by
 * `pnpm arena`, see src/arena.ts):
 *
 *   easy   — naive point-count bidding with a fat cushion, a safe low
 *            contract, the basic memoryless card play, and a random legal
 *            card over half the time.
 *   medium — CALIBRATED bidding/contract (evaluate.ts: models fitted from
 *            simulated deals, expected-value auction and contract) with a
 *            caution margin, MEMORY-AWARE card play (memory.ts + play.ts:
 *            played cards, voids, masters, safe winners, partner smears),
 *            still slipping on some card plays.
 *   hard   — the same calibrated EV bidding with no caution margin, the
 *            EV-optimal contract, and flawless memory-aware play.
 *   expert — hard's bidding plus determinized Monte Carlo search
 *            (search.ts) for every card play and the contract: it imagines
 *            the hidden hands consistent with everything it has seen, plays
 *            each option out, and picks the best on average.
 *
 * Shared heuristics (all levels):
 *  - redeal-eligible hands are trash by definition → always redeal;
 *  - EXCHANGE give: pass the declarer aces, tens and lone marriage halves,
 *    never breaking an own complete marriage unless nothing else is left;
 *  - EXCHANGE return / 2-3p discard: lowest-point junk, keeping complete
 *    marriage halves;
 *  - DECLARATIONS: declare ASAP, highest marriage first; ask the half when
 *    holding exactly one half; ask the whole only without a useful half;
 *  - K/Q of undeclared suits we hold both of are saved whenever possible.
 */
import type {
  ActionHint,
  Card,
  DealView,
  MatchState,
  PlayerAction,
  PlayerView,
  RuleConfig,
  Seat,
  Suit,
  TrickPlay,
} from '@hp/engine';
import {
  activeSeats,
  beats,
  cardPoints,
  makeCard,
  marriageValue,
  partnerOf,
  rankIndex,
  rankOf,
  redactViewFor,
  SUITS,
  sideOf,
  suitOf,
  winningPlay,
} from '@hp/engine';
import type { Actor } from './actor.js';
import { bestContract, bidValues, estimateForContract } from './evaluate.js';
import { ALL_CARDS, DealMemory, type Knowledge, knowledgeOf } from './memory.js';
import { smartFollow, smartLead } from './play.js';
import { type Prng, pick } from './prng.js';
import { type RolloutPolicy, sampleStates, scoreCandidates, sideRawTotals } from './search.js';

/**
 * Bot skill level, chosen per game (the Pikapeli "Bottien taso" setting).
 * Higher levels are strictly smarter — see the ladder in the header.
 */
export type BotDifficulty = 'easy' | 'medium' | 'hard' | 'expert';

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'medium', 'hard', 'expert'];

export interface SkillProfile {
  /** naive = point-count vs a margin; model = calibrated expected value. */
  bidding: 'naive' | 'model';
  /**
   * naive: bid only while hand strength ≥ next amount + this.
   * model: bid only while (declare value − defend value) ≥ this (points).
   */
  bidMargin: number;
  /** naive only: fraction of a lone marriage half credited while bidding. */
  completionCredit: number;
  /** 4p model bidding: raw-total bonus when the partner has bid (strength signal). */
  partnerBidBonus: number;
  contract: 'naive' | 'model' | 'search';
  /** naive: strength − margin; model: μ is lowered by this before the EV scan. */
  contractMargin: number;
  play: 'basic' | 'smart' | 'search';
  /** Probability of a random legal card instead of the chosen one. */
  sloppiness: number;
  /** Determinizations per search decision (expert). */
  samples: number;
}

const SKILL: Record<BotDifficulty | 'rollout', SkillProfile> = {
  easy: {
    bidding: 'naive',
    bidMargin: 30,
    completionCredit: 0,
    partnerBidBonus: 0,
    contract: 'naive',
    contractMargin: 40,
    play: 'basic',
    sloppiness: 0.55,
    samples: 0,
  },
  medium: {
    bidding: 'model',
    bidMargin: 20,
    completionCredit: 0,
    partnerBidBonus: 10,
    contract: 'model',
    contractMargin: 15,
    play: 'smart',
    sloppiness: 0.15,
    samples: 0,
  },
  hard: {
    bidding: 'model',
    bidMargin: 0,
    completionCredit: 0,
    partnerBidBonus: 15,
    contract: 'model',
    contractMargin: 0,
    play: 'smart',
    sloppiness: 0,
    samples: 0,
  },
  expert: {
    bidding: 'model',
    bidMargin: 0,
    completionCredit: 0,
    partnerBidBonus: 15,
    contract: 'search',
    contractMargin: 0,
    play: 'search',
    sloppiness: 0,
    samples: 24,
  },
  /** The policy that plays out the expert's imagined deals. */
  rollout: {
    bidding: 'model',
    bidMargin: 0,
    completionCredit: 0,
    partnerBidBonus: 15,
    contract: 'model',
    contractMargin: 0,
    play: 'smart',
    sloppiness: 0,
    samples: 0,
  },
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
 * Naive strength (easy level): marriages held + 11/ace + 10/ten + a small
 * long-suit bonus. Systematically low — it ignores K/Q/J points, the last
 * trick, the exchange and opponents' points won in tricks.
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

/**
 * Knowledge for a seat in one of the expert's HYPOTHETICAL states: in that
 * imagined world every card captured or on the table has been seen played.
 * Only that public history and the seat's own hand are used — the policy does
 * not peek at the imagined hidden hands.
 */
function rolloutKnowledge(state: MatchState, seat: Seat): Knowledge {
  const deal = state.deal;
  if (!deal) throw new Error('rolloutKnowledge: no deal');
  const played = new Set<Card>();
  for (const s of activeSeats(state.config.players))
    for (const c of deal.captured[s]) played.add(c);
  if (deal.phase.name === 'follow') for (const p of deal.phase.plays) played.add(p.card);
  const empty = (): Record<Seat, Set<Card>> => ({
    0: new Set(),
    1: new Set(),
    2: new Set(),
    3: new Set(),
  });
  const held = empty();
  const excluded = empty();
  const hand = new Set(deal.hands[seat]);
  for (const c of hand) held[seat].add(c);
  for (const c of ALL_CARDS) if (!hand.has(c)) excluded[seat].add(c);
  return { me: seat, played, held, excluded };
}

export class HeuristicBot implements Actor {
  private readonly rng: Prng;
  private readonly skill: SkillProfile;
  private readonly memory = new DealMemory();
  private policyBot: HeuristicBot | null = null;

  /** `tune` overrides profile fields — for the arena's parameter sweeps. */
  constructor(
    rng: Prng,
    difficulty: BotDifficulty | 'rollout' = 'medium',
    tune: Partial<SkillProfile> = {},
  ) {
    this.rng = rng;
    this.skill = { ...(SKILL[difficulty] ?? SKILL.medium), ...tune };
  }

  /**
   * Feed every snapshot this seat receives (not only its own turns) so the
   * memory never misses a card — exactly what a human watching the table
   * sees. Optional: onTurn observes too, and with showLastTrick the memory is
   * complete from turns alone.
   */
  observe(view: PlayerView): void {
    this.memory.observe(view);
  }

  onTurn(view: PlayerView, hints: ActionHint[]): PlayerAction {
    this.memory.observe(view);
    return this.decide(view, hints, null);
  }

  /** The policy used to play out imagined deals (expert search). */
  private rolloutPolicy(): RolloutPolicy {
    this.policyBot ??= new HeuristicBot(this.rng, 'rollout');
    const bot = this.policyBot;
    return (state, seat, hints) =>
      bot.decide(redactViewFor(state, seat), hints, rolloutKnowledge(state, seat));
  }

  /** `know` = injected knowledge (rollouts); null = derive it from memory. */
  private decide(view: PlayerView, hints: ActionHint[], know: Knowledge | null): PlayerAction {
    const deal = view.deal;
    if (!deal) throw new Error('HeuristicBot: no deal in view');
    const config = view.config;
    const hand = deal.hand;

    const bid = findHint(hints, 'bid');
    if (bid) return this.bidAction(bid, view, deal, config);

    if (findHint(hints, 'demandRedeal')) return { type: 'demandRedeal' };

    const give = findHint(hints, 'giveCards');
    if (give) return { type: 'giveCards', cards: giveCards(hand, give.count, config) };

    const discard = findHint(hints, 'discardCards');
    if (discard) {
      const cards = returnCards(discard.legal, discard.count, config);
      if (know === null) this.memory.recordDiscards(cards);
      return { type: 'discardCards', cards };
    }

    const contract = findHint(hints, 'setContract');
    if (contract) {
      return { type: 'setContract', amount: this.contractAction(contract, view, know) };
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
    if (play) return { type: 'playCard', card: this.cardToPlay(play.legal, view, deal, know) };

    throw new Error(`HeuristicBot: no playable hint in ${JSON.stringify(hints)}`);
  }

  // ── Bidding ────────────────────────────────────────────────────────────

  private bidAction(
    hint: BidHint,
    view: PlayerView,
    deal: DealView,
    config: RuleConfig,
  ): PlayerAction {
    const hand = deal.hand;
    if (hint.canDemandRedeal) return { type: 'demandRedeal' };
    if (!hint.canPass) return { type: 'bid', amount: hint.min };
    if (hint.min > hint.max) return { type: 'pass' };

    if (this.skill.bidding === 'model') {
      const decision = this.modelBid(hint, view, deal, config);
      if (decision !== null) return decision ? { type: 'bid', amount: hint.min } : { type: 'pass' };
    }
    if (bidStrength(hand, config, this.skill.completionCredit) >= hint.min + this.skill.bidMargin) {
      return { type: 'bid', amount: hint.min };
    }
    return { type: 'pass' };
  }

  /** true = bid, false = pass, null = no model for this mode (fall back). */
  private modelBid(
    hint: BidHint,
    view: PlayerView,
    deal: DealView,
    config: RuleConfig,
  ): boolean | null {
    let bonus = 0;
    if (config.players === 4 && view.viewer !== 'spectator') {
      const partner = partnerOf(view.viewer);
      if (deal.bidLog.some((e) => e.seat === partner && e.kind === 'bid')) {
        bonus = this.skill.partnerBidBonus;
      }
    }
    const values = bidValues(deal.hand, config, hint.min, bonus);
    if (!values) return null;
    return values.declare - values.pass >= this.skill.bidMargin;
  }

  // ── Contract ───────────────────────────────────────────────────────────

  private contractAction(hint: ContractHint, view: PlayerView, know: Knowledge | null): number {
    const deal = view.deal as DealView;
    const config = view.config;
    const hand = deal.hand;
    if (this.skill.contract === 'search' && know === null && view.viewer !== 'spectator') {
      const amount = this.searchContract(hint, view);
      if (amount !== null) return amount;
    }
    if (this.skill.contract !== 'naive') {
      const est = estimateForContract(hand, config);
      if (est) {
        return bestContract(
          est.mu - this.skill.contractMargin,
          est.sigma,
          hint.min,
          hint.max,
          hint.step,
        ).amount;
      }
    }
    return contractAmount(hint, hand, config, this.skill.contractMargin);
  }

  /** EV-optimal contract over the empirical distribution of rollouts. */
  private searchContract(hint: ContractHint, view: PlayerView): number | null {
    const me = view.viewer as Seat;
    const know = knowledgeOf(view, this.memory);
    const samples = sampleStates(view, know, this.memory, this.rng, this.skill.samples * 2);
    if (samples.length < 8) return null;
    const outcomes = sideRawTotals(
      samples,
      me,
      { type: 'setContract', amount: hint.min },
      this.rolloutPolicy(),
    );
    if (outcomes.length < 8) return null;
    const config = view.config;
    const bid = view.deal?.bid?.amount ?? hint.min;
    const cap = Math.floor(hint.max / hint.step) * hint.step;
    let best = hint.min;
    let bestEv = Number.NEGATIVE_INFINITY;
    for (let c = hint.min; c <= cap; c += hint.step) {
      let ev = 0;
      for (const o of outcomes) {
        if (o.tricks === 0) ev -= 2 * (config.declarerPorvooBasis === 'bid' ? bid : c);
        else ev += o.raw >= c ? c : -c;
      }
      if (ev > bestEv) {
        bestEv = ev;
        best = c;
      }
    }
    return best;
  }

  // ── Card play ──────────────────────────────────────────────────────────

  private cardToPlay(
    legal: readonly Card[],
    view: PlayerView,
    deal: DealView,
    injected: Knowledge | null,
  ): Card {
    const first = legal[0];
    if (first === undefined) throw new Error('HeuristicBot: empty legal set');
    if (legal.length === 1) return first;
    if (view.viewer === 'spectator') throw new Error('HeuristicBot: spectator has no turn');
    const me = view.viewer;
    const config = view.config;

    if (this.skill.sloppiness > 0 && this.rng() < this.skill.sloppiness) {
      return pick(this.rng, legal);
    }

    if (this.skill.play === 'search' && injected === null) {
      const card = this.searchCard(legal, view);
      if (card !== null) return card;
    }

    const reserved = reservedCards(deal.hand, declaredSuits(deal));
    const phase = deal.phase;
    if (this.skill.play !== 'basic') {
      const know = injected ?? knowledgeOf(view, this.memory);
      const ctx = { deal, me, config, know, reserved };
      if (phase.name === 'follow' && phase.plays.length > 0) {
        return smartFollow(ctx, legal, phase.plays);
      }
      return smartLead(ctx, legal);
    }

    const free = legal.filter((c) => !reserved.has(c));
    const pool = free.length > 0 ? free : [...legal];
    if (phase.name === 'follow' && phase.plays.length > 0) {
      return this.basicFollow(legal, pool, phase.plays, deal, me, config);
    }
    return this.basicLead(pool, deal, me, config);
  }

  /** Expert: score every legal card over shared determinizations. */
  private searchCard(legal: readonly Card[], view: PlayerView): Card | null {
    const me = view.viewer as Seat;
    const know = knowledgeOf(view, this.memory);
    const samples = sampleStates(view, know, this.memory, this.rng, this.skill.samples);
    if (samples.length === 0) return null;
    const scored = scoreCandidates(
      samples,
      me,
      legal,
      (card) => ({ type: 'playCard', card }),
      this.rolloutPolicy(),
    );
    const best = scored[0];
    return best && Number.isFinite(best.mean) ? best.candidate : null;
  }

  private basicLead(pool: readonly Card[], deal: DealView, me: Seat, config: RuleConfig): Card {
    const aces = pool.filter((c) => rankOf(c) === 'A');
    if (aces.length > 0) return pick(this.rng, aces);
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

  private basicFollow(
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
    const partnerWinning = config.players === 4 && winning.seat === partnerOf(me);

    if (winners.length === legal.length) {
      const cheap = winners.filter((c) => pool.includes(c));
      return weakest(cheap.length > 0 ? cheap : winners);
    }
    if (winners.length === 0) {
      if (partnerWinning && plays.length === config.players - 1) return highestPoints(pool, config);
      return lowestJunk(pool, config);
    }
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
    else if (rank === 'K' || rank === 'Q') p += 30;
    return p;
  };
  return [...hand].sort((a, b) => priority(b) - priority(a)).slice(0, count);
}

/** Naive contract (easy): bid + a raise from strength trimmed by the margin. */
function contractAmount(
  hint: ContractHint,
  hand: readonly Card[],
  config: RuleConfig,
  margin: number,
): number {
  const estimate = handStrength(hand, config) - margin;
  const steps = Math.max(0, Math.floor((estimate - hint.min) / hint.step));
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
