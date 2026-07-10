/**
 * Scoring suite (rules doc §5.6–§5.7, §3, §4, §10): scoreDeal over synthetic
 * completed DealStates with hand-picked captured piles, plus match progression
 * (dealScored deltas, matchEnded at winTarget, both-cross / equal-cross rules,
 * negative score accumulation) driven through validateAction/applyEvent.
 *
 * Pinned ambiguity decisions asserted here (documented in src/config.ts):
 *  - Porvoo applies per SIDE: an opponent side with zero tricks scores
 *    −(final contract); a declarer SIDE with zero tricks scores −2×contract.
 *    A personally trickless declarer whose partner won a trick is NOT Porvoo.
 *  - Both sides ≥ winTarget with EQUAL scores → the match continues.
 */
import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../src/config.js';
import { DEFAULT_RULES, theoreticalMaxPoints, totalDealPoints } from '../src/config.js';
import { makeCard, makeDeck, marriageValue, sumCardPoints } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import { scoreDeal } from '../src/scoring.js';
import type {
  Card,
  DealResult,
  DealState,
  Declaration,
  DeclarationHow,
  GameEvent,
  MatchState,
  Rank,
  Seat,
  Side,
  SideBreakdown,
  Suit,
  TrickPlay,
} from '../src/types.js';
import { isRuleError, SEATS, SUITS, sideOf } from '../src/types.js';
import { validateAction } from '../src/validate.js';

// ── Configs under test ────────────────────────────────────────────────────────

/** Päämuoto: card points A (120), last trick 10 → 130/deal, ♥100 ♦80 ♣60 ♠40. */
const CFG_A = DEFAULT_RULES;
/** Rules doc §3B: A/10=10, K/Q/J=5 (140) + last trick 20 → 160/deal. */
const CFG_B: RuleConfig = { ...DEFAULT_RULES, cardPoints: 'B', lastTrickBonus: 20 };
/** Rules doc §4B bridge order: ♠100 ♥80 ♦60 ♣40. */
const CFG_BRIDGE: RuleConfig = { ...DEFAULT_RULES, trumpValues: 'bridge' };

// ── Card groups (system A points in comments) ────────────────────────────────

const ofRank = (rank: Rank): Card[] => SUITS.map((s) => makeCard(s, rank));
const ACES = ofRank('A'); // A: 44, B: 40
const TENS = ofRank('10'); // A: 40, B: 40
const KINGS = ofRank('K'); // A: 16, B: 20
const QUEENS = ofRank('Q'); // A: 12, B: 20
const JACKS = ofRank('J'); // A:  8, B: 20
const NINES = ofRank('9'); // 0
const EIGHTS = ofRank('8'); // 0
const SEVENS = ofRank('7'); // 0
const SIXES = ofRank('6'); // 0

// ── Builders ─────────────────────────────────────────────────────────────────

function decl(
  seat: Seat,
  suit: Suit,
  points: number,
  how: DeclarationHow = 'own',
  trickIndex = 1,
): Declaration {
  return { suit, seat, side: sideOf(seat), how, trickIndex, points };
}

interface CompletedDealOpts {
  declarer: Seat;
  contract: number;
  /** Winning bid; defaults to the contract (declarer may raise, so bid ≤ contract). */
  bid?: number;
  captured: Partial<Record<Seat, Card[]>>;
  tricksWon: Partial<Record<Seat, number>>;
  lastWinner: Seat;
  declarations?: Declaration[];
  trump?: Suit | null;
}

/**
 * A fully played deal ready for scoreDeal. Self-checks keep the synthetic
 * piles honest: they must partition the 36-card deck, each seat's pile must
 * hold exactly 4 cards per trick won, and trick counts must sum to 9.
 */
function completedDeal(opts: CompletedDealOpts): DealState {
  const captured: Record<Seat, Card[]> = {
    0: [...(opts.captured[0] ?? [])],
    1: [...(opts.captured[1] ?? [])],
    2: [...(opts.captured[2] ?? [])],
    3: [...(opts.captured[3] ?? [])],
  };
  const tricksWon: Record<Seat, number> = {
    0: opts.tricksWon[0] ?? 0,
    1: opts.tricksWon[1] ?? 0,
    2: opts.tricksWon[2] ?? 0,
    3: opts.tricksWon[3] ?? 0,
  };
  const all = SEATS.flatMap((s) => captured[s]);
  if (all.length !== 36 || new Set(all).size !== 36) {
    throw new Error('test bug: captured piles must partition the 36-card deck');
  }
  for (const s of SEATS) {
    if (captured[s].length !== tricksWon[s] * 4) {
      throw new Error(`test bug: seat ${s} pile must hold 4 cards per trick won`);
    }
  }
  if (SEATS.reduce<number>((acc, s) => acc + tricksWon[s], 0) !== 9) {
    throw new Error('test bug: tricksWon must sum to 9');
  }
  if (tricksWon[opts.lastWinner] === 0) {
    throw new Error('test bug: lastWinner must have won a trick');
  }
  return {
    hands: { 0: [], 1: [], 2: [], 3: [] },
    captured,
    tricksWon,
    tricksPlayed: 9,
    trump: opts.trump ?? null,
    declarations: opts.declarations ?? [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false },
    bidLog: [],
    bid: { seat: opts.declarer, amount: opts.bid ?? opts.contract },
    declarer: opts.declarer,
    contract: opts.contract,
    exchange: { given: null, returned: null },
    lastTrick: { plays: [], winner: opts.lastWinner },
    phase: { name: 'lead', leader: opts.lastWinner, canDeclare: false },
  };
}

/** Every scored deal must conserve card points: sides sum to 120/140 + bonus. */
function expectConservation(
  result: DealResult,
  cfg: RuleConfig,
  declarations: readonly Declaration[],
): void {
  const [a, b] = result.sides;
  expect(a.cardPoints + b.cardPoints).toBe(cfg.cardPoints === 'A' ? 120 : 140);
  expect(a.lastTrickBonus + b.lastTrickBonus).toBe(cfg.lastTrickBonus);
  expect(a.cardPoints + a.lastTrickBonus + b.cardPoints + b.lastTrickBonus).toBe(
    totalDealPoints(cfg),
  );
  const marriages = declarations.reduce((acc, d) => acc + d.points, 0);
  expect(a.rawTotal + b.rawTotal).toBe(totalDealPoints(cfg) + marriages);
  expect(a.tricks + b.tricks).toBe(9);
}

/** Lead-phase state with an open declaration window (for trump-value tests). */
function leadDeclareState(cfg: RuleConfig, leader: Seat, leaderHand: Card[]): MatchState {
  const tricksWon: Record<Seat, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  tricksWon[leader] = 1;
  const deal: DealState = {
    hands: { 0: [], 1: [], 2: [], 3: [], [leader]: [...leaderHand] },
    captured: { 0: [], 1: [], 2: [], 3: [] },
    tricksWon,
    tricksPlayed: 1,
    trump: null,
    declarations: [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false },
    bidLog: [],
    bid: { seat: 2, amount: 55 },
    declarer: 2,
    contract: 60,
    exchange: { given: null, returned: null },
    lastTrick: { plays: [], winner: leader },
    phase: { name: 'lead', leader, canDeclare: true },
  };
  return { ...initialMatchState(cfg, 0), deal };
}

// ── Match-level builder: a deal frozen one card before completion ────────────
//
// First 8 tricks (side 0 = 84 card points, side 1 = 36, no marriages):
//   seat 0: all aces + all tens        (84, 2 tricks)
//   seat 1: all kings, queens, jacks   (36, 3 tricks)
//   seat 2: —                          ( 0, 0 tricks)
//   seat 3: all non-heart 9/8/7/6      ( 0, 3 tricks)
// The 9th trick is the four worthless hearts (H9 H8 H7 H6): whoever wins it
// adds exactly the last-trick bonus. Seat 0 plays the final card.

const NON_HEART_ZEROS: Card[] = [
  'D9',
  'D8',
  'D7',
  'D6',
  'C9',
  'C8',
  'C7',
  'C6',
  'S9',
  'S8',
  'S7',
  'S6',
];

interface NinthTrickOpts {
  config?: RuleConfig;
  scores: [number, number];
  dealer?: Seat;
  dealIndex?: number;
  declarer: Seat;
  bid?: number;
  contract: number;
  /** Which side wins the final trick (and its bonus). */
  lastTrickTo: Side;
}

function ninthTrickState(opts: NinthTrickOpts): {
  state: MatchState;
  lastSeat: Seat;
  lastCard: Card;
} {
  const cfg = opts.config ?? DEFAULT_RULES;
  const plays: TrickPlay[] =
    opts.lastTrickTo === 0
      ? [
          { seat: 1, card: 'H6' },
          { seat: 2, card: 'H7' },
          { seat: 3, card: 'H8' },
        ]
      : [
          { seat: 1, card: 'H9' },
          { seat: 2, card: 'H6' },
          { seat: 3, card: 'H7' },
        ];
  const lastCard: Card = opts.lastTrickTo === 0 ? 'H9' : 'H8';
  const deal: DealState = {
    hands: { 0: [lastCard], 1: [], 2: [], 3: [] },
    captured: {
      0: [...ACES, ...TENS],
      1: [...KINGS, ...QUEENS, ...JACKS],
      2: [],
      3: [...NON_HEART_ZEROS],
    },
    tricksWon: { 0: 2, 1: 3, 2: 0, 3: 3 },
    tricksPlayed: 8,
    trump: null,
    declarations: [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false },
    bidLog: [],
    bid: { seat: opts.declarer, amount: opts.bid ?? opts.contract },
    declarer: opts.declarer,
    contract: opts.contract,
    exchange: { given: null, returned: null },
    // Trick 7 went to seat 1, who therefore leads the final trick.
    lastTrick: {
      plays: [
        { seat: 1, card: 'HK' },
        { seat: 2, card: 'HQ' },
        { seat: 3, card: 'HJ' },
        { seat: 0, card: 'SK' },
      ],
      winner: 1,
    },
    phase: { name: 'follow', leader: 1, plays },
  };
  const state: MatchState = {
    ...initialMatchState(cfg, opts.dealer ?? 0),
    scores: [opts.scores[0], opts.scores[1]],
    dealIndex: opts.dealIndex ?? 0,
    deal,
  };
  return { state, lastSeat: 0, lastCard };
}

/** Expected DealResult for the ninthTrickState fixture (independent oracle). */
function ninthTrickResult(declarer: Seat, contract: number, lastTrickTo: Side): DealResult {
  const bonus: [number, number] = lastTrickTo === 0 ? [10, 0] : [0, 10];
  const raw: [number, number] = [84 + bonus[0], 36 + bonus[1]];
  const tricks: [number, number] = lastTrickTo === 0 ? [3, 6] : [2, 7];
  const declarerSide = sideOf(declarer);
  const made = raw[declarerSide] >= contract;
  const side = (s: Side): SideBreakdown => ({
    cardPoints: s === 0 ? 84 : 36,
    lastTrickBonus: bonus[s],
    marriagePoints: 0,
    rawTotal: raw[s],
    tricks: tricks[s],
    porvoo: false,
    scoreDelta: s === declarerSide ? (made ? contract : -contract) : raw[s],
  });
  return { declarer, contract, made, sides: [side(0), side(1)] };
}

function playFinalCard(built: { state: MatchState; lastSeat: Seat; lastCard: Card }): {
  events: GameEvent[];
  state: MatchState;
} {
  const res = validateAction(built.state, built.lastSeat, {
    type: 'playCard',
    card: built.lastCard,
  });
  if (isRuleError(res)) throw new Error(`unexpected RuleError ${res.code}`);
  let state = built.state;
  for (const e of res) state = applyEvent(state, e);
  return { events: res, state };
}

// ── scoreDeal: contract resolution ───────────────────────────────────────────

describe('scoreDeal — contract resolution', () => {
  const clampPiles: Pick<CompletedDealOpts, 'captured' | 'tricksWon'> = {
    captured: {
      0: [...ACES, ...NINES], // 44
      2: [...TENS, ...JACKS, ...EIGHTS], // 48
      1: [...KINGS, ...QUEENS], // 28
      3: [...SEVENS, ...SIXES], // 0
    },
    tricksWon: { 0: 2, 2: 3, 1: 2, 3: 2 },
  };

  it('clamps a made contract to exactly the contract when raw exceeds it', () => {
    const deal = completedDeal({
      declarer: 2,
      contract: 60,
      bid: 55,
      ...clampPiles,
      lastWinner: 2,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result).toEqual({
      declarer: 2,
      contract: 60,
      made: true,
      sides: [
        {
          cardPoints: 92,
          lastTrickBonus: 10,
          marriagePoints: 0,
          rawTotal: 102,
          tricks: 5,
          porvoo: false,
          scoreDelta: 60, // NOT 102: clamped to the contract
        },
        {
          cardPoints: 28,
          lastTrickBonus: 0,
          marriagePoints: 0,
          rawTotal: 28,
          tricks: 4,
          porvoo: false,
          scoreDelta: 28, // opponents keep their raw points as-is
        },
      ],
    });
    expectConservation(result, CFG_A, []);
  });

  it('makes the contract on exactly the contract amount (raw == contract)', () => {
    // Declarer side 1 lands on exactly 70 (60 cards + last trick 10) and wins
    // FEWER tricks (3 v 6) — trick count is irrelevant to making a contract.
    const deal = completedDeal({
      declarer: 1,
      contract: 70,
      captured: {
        1: [...ACES, ...KINGS], // 60
        3: [...SIXES], // 0
        0: [...TENS, ...QUEENS, ...JACKS], // 60
        2: [...NINES, ...EIGHTS, ...SEVENS], // 0
      },
      tricksWon: { 1: 2, 3: 1, 0: 3, 2: 3 },
      lastWinner: 3,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result).toEqual({
      declarer: 1,
      contract: 70,
      made: true,
      sides: [
        {
          cardPoints: 60,
          lastTrickBonus: 0,
          marriagePoints: 0,
          rawTotal: 60,
          tricks: 6,
          porvoo: false,
          scoreDelta: 60,
        },
        {
          cardPoints: 60,
          lastTrickBonus: 10,
          marriagePoints: 0,
          rawTotal: 70,
          tricks: 3,
          porvoo: false,
          scoreDelta: 70,
        },
      ],
    });
    expectConservation(result, CFG_A, []);
  });

  it('costs the declarer side the full contract when it falls short', () => {
    const deal = completedDeal({
      declarer: 2,
      contract: 200,
      ...clampPiles,
      lastWinner: 2,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result.made).toBe(false);
    expect(result.sides[0]).toEqual({
      cardPoints: 92,
      lastTrickBonus: 10,
      marriagePoints: 0,
      rawTotal: 102,
      tricks: 5,
      porvoo: false,
      scoreDelta: -200, // −contract, regardless of how close raw came
    });
    expect(result.sides[1].scoreDelta).toBe(28); // opponents unaffected by the failure
    expectConservation(result, CFG_A, []);
  });

  it('moves the last-trick bonus with the winner of the last trick', () => {
    const toSide0 = scoreDeal(
      completedDeal({ declarer: 2, contract: 60, ...clampPiles, lastWinner: 0 }),
      CFG_A,
    );
    const toSide1 = scoreDeal(
      completedDeal({ declarer: 2, contract: 60, ...clampPiles, lastWinner: 3 }),
      CFG_A,
    );
    expect([toSide0.sides[0].lastTrickBonus, toSide0.sides[1].lastTrickBonus]).toEqual([10, 0]);
    expect([toSide1.sides[0].lastTrickBonus, toSide1.sides[1].lastTrickBonus]).toEqual([0, 10]);
    expect(toSide0.sides[0].rawTotal).toBe(102);
    expect(toSide1.sides[0].rawTotal).toBe(92);
    expect(toSide0.sides[1].rawTotal).toBe(28);
    expect(toSide1.sides[1].rawTotal).toBe(38);
    // Opponent deltas track their raw totals; the made contract stays clamped.
    expect(toSide0.sides[1].scoreDelta).toBe(28);
    expect(toSide1.sides[1].scoreDelta).toBe(38);
    expect(toSide0.sides[0].scoreDelta).toBe(60);
    expect(toSide1.sides[0].scoreDelta).toBe(60);
    expectConservation(toSide0, CFG_A, []);
    expectConservation(toSide1, CFG_A, []);
  });
});

// ── scoreDeal: marriage points ───────────────────────────────────────────────

describe('scoreDeal — marriage points', () => {
  it('credits the marriage to the DECLARING side even when it wins fewer tricks', () => {
    // Side 0 declared hearts (100) but won only 2 of 9 tricks; contract
    // declarer is seat 1 on the OTHER side. The 100 still belongs to side 0.
    const declarations = [decl(0, 'H', 100, 'own', 2)];
    const deal = completedDeal({
      declarer: 1,
      contract: 100,
      bid: 90,
      captured: {
        0: [...KINGS, ...QUEENS], // 28
        2: [], // 0
        1: [...ACES, ...TENS], // 84
        3: [...JACKS, ...NINES, ...EIGHTS, ...SEVENS, ...SIXES], // 8
      },
      tricksWon: { 0: 2, 2: 0, 1: 2, 3: 5 },
      lastWinner: 3,
      declarations,
      trump: 'H',
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result).toEqual({
      declarer: 1,
      contract: 100,
      made: true,
      sides: [
        {
          cardPoints: 28,
          lastTrickBonus: 0,
          marriagePoints: 100,
          rawTotal: 128,
          tricks: 2,
          porvoo: false,
          scoreDelta: 128, // opponents: raw total incl. marriage, unclamped
        },
        {
          cardPoints: 92,
          lastTrickBonus: 10,
          marriagePoints: 0,
          rawTotal: 102,
          tricks: 7,
          porvoo: false,
          scoreDelta: 100, // 102 ≥ 100 → made, clamped
        },
      ],
    });
    expectConservation(result, CFG_A, declarations);
  });

  it('lets marriage points fill the declarer side contract', () => {
    // Cards + bonus alone (66) would fail contract 140; diamonds (80) make it.
    const declarations = [decl(2, 'D', 80, 'own', 1)];
    const deal = completedDeal({
      declarer: 2,
      contract: 140,
      bid: 120,
      captured: {
        2: [...ACES, ...NINES, ...EIGHTS], // 44
        0: [...QUEENS], // 12
        1: [...TENS, ...KINGS, ...JACKS], // 64
        3: [...SEVENS, ...SIXES], // 0
      },
      tricksWon: { 2: 3, 0: 1, 1: 3, 3: 2 },
      lastWinner: 2,
      declarations,
      trump: 'D',
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result.made).toBe(true);
    expect(result.sides[0]).toEqual({
      cardPoints: 56,
      lastTrickBonus: 10,
      marriagePoints: 80,
      rawTotal: 146,
      tricks: 4,
      porvoo: false,
      scoreDelta: 140,
    });
    expect(result.sides[1]).toEqual({
      cardPoints: 64,
      lastTrickBonus: 0,
      marriagePoints: 0,
      rawTotal: 64,
      tricks: 5,
      porvoo: false,
      scoreDelta: 64,
    });
    expectConservation(result, CFG_A, declarations);
  });
});

// ── scoreDeal: Porvoo ────────────────────────────────────────────────────────

describe('scoreDeal — Porvoo (trickless sides)', () => {
  const side0SweepPiles: Pick<CompletedDealOpts, 'captured' | 'tricksWon'> = {
    captured: {
      2: [...ACES, ...TENS, ...KINGS, ...QUEENS, ...JACKS, ...NINES], // 120
      0: [...EIGHTS, ...SEVENS, ...SIXES], // 0
    },
    tricksWon: { 2: 6, 0: 3 },
  };

  it('charges a trickless opponent side the CONTRACT (not the original bid)', () => {
    const deal = completedDeal({
      declarer: 2,
      contract: 60,
      bid: 50, // declarer raised 50 → 60: the penalty follows the contract
      ...side0SweepPiles,
      lastWinner: 0,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result).toEqual({
      declarer: 2,
      contract: 60,
      made: true,
      sides: [
        {
          cardPoints: 120,
          lastTrickBonus: 10,
          marriagePoints: 0,
          rawTotal: 130,
          tricks: 9,
          porvoo: false,
          scoreDelta: 60,
        },
        {
          cardPoints: 0,
          lastTrickBonus: 0,
          marriagePoints: 0,
          rawTotal: 0,
          tricks: 0,
          porvoo: true,
          scoreDelta: -60,
        },
      ],
    });
    expectConservation(result, CFG_A, []);
  });

  it('can send BOTH sides negative: declarer fails while opponents are in Porvoo', () => {
    const deal = completedDeal({
      declarer: 2,
      contract: 300, // raw 130 < 300 → declarer side fails despite the sweep
      ...side0SweepPiles,
      lastWinner: 2,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result.made).toBe(false);
    expect(result.sides[0].scoreDelta).toBe(-300);
    expect(result.sides[1].porvoo).toBe(true);
    expect(result.sides[1].scoreDelta).toBe(-300);
    expectConservation(result, CFG_A, []);
  });

  it('charges a trickless declarer SIDE twice the contract (replacing −contract)', () => {
    const deal = completedDeal({
      declarer: 2,
      contract: 60,
      bid: 50,
      captured: {
        1: [...ACES, ...TENS, ...KINGS, ...QUEENS, ...JACKS, ...NINES], // 120
        3: [...EIGHTS, ...SEVENS, ...SIXES], // 0
      },
      tricksWon: { 1: 6, 3: 3 },
      lastWinner: 1,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result).toEqual({
      declarer: 2,
      contract: 60,
      made: false,
      sides: [
        {
          cardPoints: 0,
          lastTrickBonus: 0,
          marriagePoints: 0,
          rawTotal: 0,
          tricks: 0,
          porvoo: true,
          scoreDelta: -120, // −2 × contract, not −contract
        },
        {
          cardPoints: 120,
          lastTrickBonus: 10,
          marriagePoints: 0,
          rawTotal: 130,
          tricks: 9,
          porvoo: false,
          scoreDelta: 130,
        },
      ],
    });
    expectConservation(result, CFG_A, []);
  });

  it('is per SIDE: a personally trickless declarer whose partner won is not Porvoo', () => {
    // Pinned decision (config.ts): Porvoo applies to the side. Declarer seat 0
    // won nothing but partner seat 2 took 2 tricks → normal −contract, not −2×.
    const deal = completedDeal({
      declarer: 0,
      contract: 60,
      captured: {
        0: [],
        2: [...SEVENS, ...SIXES], // 0 points, 2 tricks
        1: [...ACES, ...TENS, ...KINGS, ...QUEENS, ...JACKS], // 120
        3: [...NINES, ...EIGHTS], // 0
      },
      tricksWon: { 0: 0, 2: 2, 1: 5, 3: 2 },
      lastWinner: 1,
    });
    const result = scoreDeal(deal, CFG_A);
    expect(result.sides[0]).toEqual({
      cardPoints: 0,
      lastTrickBonus: 0,
      marriagePoints: 0,
      rawTotal: 0,
      tricks: 2,
      porvoo: false,
      scoreDelta: -60, // NOT −120
    });
    expect(result.sides[1].scoreDelta).toBe(130);
    expectConservation(result, CFG_A, []);
  });
});

// ── scoreDeal: config B point table (140 + 20) ───────────────────────────────

describe('scoreDeal — point system B (A/10=10, K/Q/J=5, last trick 20)', () => {
  it('totals 140 card points + 20 bonus and scores with B values', () => {
    expect(totalDealPoints(CFG_B)).toBe(160);
    const deal = completedDeal({
      declarer: 0,
      contract: 110,
      bid: 100,
      captured: {
        0: [...ACES, ...TENS, ...KINGS], // B: 40+40+20 = 100
        2: [...SIXES], // 0
        1: [...QUEENS, ...JACKS], // B: 20+20 = 40 (would be 20 under A — the discriminator)
        3: [...NINES, ...EIGHTS, ...SEVENS], // 0
      },
      tricksWon: { 0: 3, 2: 1, 1: 2, 3: 3 },
      lastWinner: 0,
    });
    const result = scoreDeal(deal, CFG_B);
    expect(result).toEqual({
      declarer: 0,
      contract: 110,
      made: true,
      sides: [
        {
          cardPoints: 100,
          lastTrickBonus: 20,
          marriagePoints: 0,
          rawTotal: 120,
          tricks: 4,
          porvoo: false,
          scoreDelta: 110,
        },
        {
          cardPoints: 40, // queens+jacks are 5 each under B (20 under A)
          lastTrickBonus: 0,
          marriagePoints: 0,
          rawTotal: 40,
          tricks: 5,
          porvoo: false,
          scoreDelta: 40,
        },
      ],
    });
    expectConservation(result, CFG_B, []);
  });

  it('same piles under system A score differently (discriminates the tables)', () => {
    const piles: Pick<CompletedDealOpts, 'captured' | 'tricksWon'> = {
      captured: {
        0: [...ACES, ...TENS, ...KINGS],
        2: [...SIXES],
        1: [...QUEENS, ...JACKS],
        3: [...NINES, ...EIGHTS, ...SEVENS],
      },
      tricksWon: { 0: 3, 2: 1, 1: 2, 3: 3 },
    };
    const a = scoreDeal(
      completedDeal({ declarer: 0, contract: 110, ...piles, lastWinner: 0 }),
      CFG_A,
    );
    expect(a.sides[0].cardPoints).toBe(100); // 44+40+16
    expect(a.sides[1].cardPoints).toBe(20); // 12+8
    expect(a.sides[0].rawTotal).toBe(110); // bonus 10 under A
    expect(a.made).toBe(true); // exactly on the contract
    expectConservation(a, CFG_A, []);
  });
});

// ── Trump value tables feeding scoring ───────────────────────────────────────

describe('trump value tables', () => {
  it('declareOwn awards bridge marriage values (♠100 ♥80 ♦60 ♣40)', () => {
    const expected: Record<Suit, number> = { S: 100, H: 80, D: 60, C: 40 };
    for (const suit of SUITS) {
      const state = leadDeclareState(CFG_BRIDGE, 1, [makeCard(suit, 'K'), makeCard(suit, 'Q')]);
      const res = validateAction(state, 1, { type: 'declareOwn', suit });
      expect(isRuleError(res)).toBe(false);
      if (!isRuleError(res)) {
        expect(res).toEqual([
          { type: 'declaredOwn', seat: 1, suit },
          { type: 'trumpSet', suit, seat: 1, side: 1, how: 'own', points: expected[suit] },
        ]);
        const next = res.reduce(applyEvent, state);
        expect(next.deal?.declarations).toEqual([decl(1, suit, expected[suit], 'own', 1)]);
      }
    }
  });

  it('declareOwn awards heartsHigh marriage values (♥100 ♦80 ♣60 ♠40)', () => {
    const expected: Record<Suit, number> = { H: 100, D: 80, C: 60, S: 40 };
    for (const suit of SUITS) {
      const state = leadDeclareState(CFG_A, 3, [makeCard(suit, 'K'), makeCard(suit, 'Q')]);
      const res = validateAction(state, 3, { type: 'declareOwn', suit });
      expect(isRuleError(res)).toBe(false);
      if (!isRuleError(res)) {
        expect(res[1]).toEqual({
          type: 'trumpSet',
          suit,
          seat: 3,
          side: 1,
          how: 'own',
          points: expected[suit],
        });
      }
    }
  });

  it('scores bridge-valued marriages into the declaring sides', () => {
    // Side 0 declared spades (100 under bridge, would be 40 heartsHigh);
    // side 1 declared clubs (40 under bridge, would be 60 heartsHigh).
    const declarations = [decl(2, 'S', 100, 'own', 1), decl(1, 'C', 40, 'halfAsk', 3)];
    const deal = completedDeal({
      declarer: 2,
      contract: 160,
      bid: 150,
      captured: {
        0: [...ACES, ...NINES], // 44
        2: [...TENS, ...JACKS, ...EIGHTS], // 48
        1: [...KINGS, ...QUEENS], // 28
        3: [...SEVENS, ...SIXES], // 0
      },
      tricksWon: { 0: 2, 2: 3, 1: 2, 3: 2 },
      lastWinner: 2,
      declarations,
      trump: 'C',
    });
    const result = scoreDeal(deal, CFG_BRIDGE);
    expect(result).toEqual({
      declarer: 2,
      contract: 160,
      made: true,
      sides: [
        {
          cardPoints: 92,
          lastTrickBonus: 10,
          marriagePoints: 100,
          rawTotal: 202,
          tricks: 5,
          porvoo: false,
          scoreDelta: 160,
        },
        {
          cardPoints: 28,
          lastTrickBonus: 0,
          marriagePoints: 40,
          rawTotal: 68,
          tricks: 4,
          porvoo: false,
          scoreDelta: 68,
        },
      ],
    });
    expectConservation(result, CFG_BRIDGE, declarations);
  });

  it('theoreticalMaxPoints adds all four marriage values to the deal total', () => {
    expect(theoreticalMaxPoints(CFG_A)).toBe(410); // 130 + 280
    expect(theoreticalMaxPoints(CFG_B)).toBe(440); // 160 + 280
    expect(theoreticalMaxPoints(CFG_BRIDGE)).toBe(410); // same suit-value sum
  });
});

// ── Randomized conservation & delta-law oracle ───────────────────────────────

describe('scoreDeal — randomized conservation oracle', () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function randomInt(rnd: () => number, n: number): number {
    return Math.floor(rnd() * n);
  }

  /** Independent re-derivation of §5.6 for cross-checking scoreDeal. */
  function oracle(deal: DealState, cfg: RuleConfig): DealResult {
    if (deal.declarer === null || deal.contract === null || deal.lastTrick === null) {
      throw new Error('test bug: oracle needs a finished deal');
    }
    const { declarer, contract } = deal;
    const lastSide = sideOf(deal.lastTrick.winner);
    const sides = ([0, 1] as const).map((side): SideBreakdown => {
      const seats: [Seat, Seat] = side === 0 ? [0, 2] : [1, 3];
      const cardPoints =
        sumCardPoints(deal.captured[seats[0]], cfg) + sumCardPoints(deal.captured[seats[1]], cfg);
      const lastTrickBonus = lastSide === side ? cfg.lastTrickBonus : 0;
      const marriagePoints = deal.declarations
        .filter((d) => d.side === side)
        .reduce((acc, d) => acc + d.points, 0);
      const rawTotal = cardPoints + lastTrickBonus + marriagePoints;
      const tricks = deal.tricksWon[seats[0]] + deal.tricksWon[seats[1]];
      const porvoo = tricks === 0;
      let scoreDelta: number;
      if (side === sideOf(declarer)) {
        scoreDelta = porvoo ? -2 * contract : rawTotal >= contract ? contract : -contract;
      } else {
        scoreDelta = porvoo ? -contract : rawTotal;
      }
      return { cardPoints, lastTrickBonus, marriagePoints, rawTotal, tricks, porvoo, scoreDelta };
    }) as [SideBreakdown, SideBreakdown];
    const db = sides[sideOf(declarer)];
    return { declarer, contract, made: !db.porvoo && db.rawTotal >= contract, sides };
  }

  it('conserves points and follows the §5.6 delta laws on 120 random deals', () => {
    const rnd = lcg(0xc0ffee);
    for (const cfg of [CFG_A, CFG_B, CFG_BRIDGE]) {
      for (let i = 0; i < 40; i++) {
        const deck = makeDeck();
        for (let k = deck.length - 1; k > 0; k--) {
          const j = randomInt(rnd, k + 1);
          const a = deck[k] as Card;
          deck[k] = deck[j] as Card;
          deck[j] = a;
        }
        const winners: Seat[] = [];
        for (let t = 0; t < 9; t++) winners.push(randomInt(rnd, 4) as Seat);
        const tricksWon: Partial<Record<Seat, number>> = {};
        for (const w of winners) tricksWon[w] = (tricksWon[w] ?? 0) + 1;
        const captured: Partial<Record<Seat, Card[]>> = {};
        let cursor = 0;
        for (const s of SEATS) {
          const n = (tricksWon[s] ?? 0) * 4;
          captured[s] = deck.slice(cursor, cursor + n);
          cursor += n;
        }
        const lastWinner = winners[8] as Seat;
        const declarer = randomInt(rnd, 4) as Seat;
        const contract = 50 + 5 * randomInt(rnd, 31);
        const seatsWithTricks = SEATS.filter((s) => (tricksWon[s] ?? 0) > 0);
        const declarations: Declaration[] = [];
        const shuffledSuits = [...SUITS].sort(() => rnd() - 0.5);
        for (let d = 0; d < randomInt(rnd, 3); d++) {
          const suit = shuffledSuits[d] as Suit;
          const seat = seatsWithTricks[randomInt(rnd, seatsWithTricks.length)] as Seat;
          declarations.push(decl(seat, suit, marriageValue(suit, cfg), 'own', 1 + d));
        }
        const deal = completedDeal({
          declarer,
          contract,
          captured,
          tricksWon,
          lastWinner,
          declarations,
          trump:
            declarations.length > 0 ? (declarations[declarations.length - 1]?.suit ?? null) : null,
        });
        const result = scoreDeal(deal, cfg);
        expect(result).toEqual(oracle(deal, cfg));
        expectConservation(result, cfg, declarations);
      }
    }
  });
});

// ── scoreDeal guards ─────────────────────────────────────────────────────────

describe('scoreDeal — guards', () => {
  const finished = completedDeal({
    declarer: 2,
    contract: 60,
    captured: {
      2: [...ACES, ...TENS, ...KINGS, ...QUEENS, ...JACKS, ...NINES],
      0: [...EIGHTS, ...SEVENS, ...SIXES],
    },
    tricksWon: { 2: 6, 0: 3 },
    lastWinner: 2,
  });

  it('rejects an unfinished deal', () => {
    expect(() => scoreDeal({ ...finished, tricksPlayed: 8 }, CFG_A)).toThrow(/engine bug/);
    expect(() => scoreDeal({ ...finished, lastTrick: null }, CFG_A)).toThrow(/engine bug/);
  });

  it('rejects a deal without a declarer or contract', () => {
    expect(() => scoreDeal({ ...finished, declarer: null }, CFG_A)).toThrow(/engine bug/);
    expect(() => scoreDeal({ ...finished, contract: null }, CFG_A)).toThrow(/engine bug/);
  });

  it('applyEvent(dealScored) asserts a completed deal', () => {
    const result = scoreDeal(finished, CFG_A);
    const state: MatchState = {
      ...initialMatchState(CFG_A, 0),
      deal: { ...finished, tricksPlayed: 8 },
    };
    expect(() => applyEvent(state, { type: 'dealScored', result })).toThrow(/engine bug/);
  });
});

// ── Match progression ────────────────────────────────────────────────────────

describe('match progression — dealScored deltas', () => {
  const piles: Pick<CompletedDealOpts, 'captured' | 'tricksWon'> = {
    captured: {
      0: [...ACES, ...NINES], // 44
      2: [...TENS, ...JACKS, ...EIGHTS], // 48
      1: [...KINGS, ...QUEENS], // 28
      3: [...SEVENS, ...SIXES], // 0
    },
    tricksWon: { 0: 2, 2: 3, 1: 2, 3: 2 },
  };

  it('adds each side scoreDelta to the match score and freezes the deal', () => {
    const deal = completedDeal({ declarer: 2, contract: 60, ...piles, lastWinner: 2 });
    const state: MatchState = { ...initialMatchState(CFG_A, 0), scores: [100, 50], deal };
    const result = scoreDeal(deal, CFG_A); // deltas: +60 / +28
    const before = JSON.stringify(state);
    const next = applyEvent(state, { type: 'dealScored', result });
    expect(next.scores).toEqual([160, 78]);
    expect(next.deal?.phase).toEqual({ name: 'scored', result });
    expect(next.winnerSide).toBeNull();
    expect(JSON.stringify(state)).toBe(before); // reducer purity
    // Next deal rotates the dealer and increments dealIndex.
    const e = nextDealEvent(next, makeDeck());
    expect(e).toEqual({ type: 'dealStarted', dealIndex: 1, dealer: 1, deck: makeDeck() });
  });

  it('applies negative deltas straight through zero', () => {
    const deal = completedDeal({ declarer: 2, contract: 200, ...piles, lastWinner: 2 });
    const state: MatchState = { ...initialMatchState(CFG_A, 0), scores: [10, 20], deal };
    const result = scoreDeal(deal, CFG_A); // deltas: −200 / +28
    const next = applyEvent(state, { type: 'dealScored', result });
    expect(next.scores).toEqual([-190, 48]);
    expect(next.winnerSide).toBeNull();
  });
});

describe('match progression — matchEnded rules', () => {
  it('ends the match when a side reaches exactly winTarget (≥, not >)', () => {
    // [440, 100] + (contract 60 made, opponents raw 36) → [500, 136].
    const built = ninthTrickState({
      scores: [440, 100],
      declarer: 2,
      bid: 55,
      contract: 60,
      lastTrickTo: 0,
    });
    const { events, state } = playFinalCard(built);
    const result = ninthTrickResult(2, 60, 0);
    expect(result.sides[0].scoreDelta).toBe(60);
    expect(result.sides[1].scoreDelta).toBe(36);
    expect(events).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'H9' },
      { type: 'trickWon', seat: 0, trickIndex: 8, canDeclareNext: false },
      { type: 'dealScored', result },
      { type: 'matchEnded', winnerSide: 0 },
    ]);
    expect(state.scores).toEqual([500, 136]);
    expect(state.winnerSide).toBe(0);
    expect(state.deal?.phase).toEqual({ name: 'scored', result });

    // The match is over: no actions, no next deal, no second matchEnded.
    const after = validateAction(state, 1, { type: 'pass' });
    expect(isRuleError(after) && after.code).toBe('error.notInPhase');
    expect(() => nextDealEvent(state, makeDeck())).toThrow(/match end/);
    expect(() => applyEvent(state, { type: 'matchEnded', winnerSide: 1 })).toThrow(/already ended/);
  });

  it('awards the match to the HIGHER side when both cross winTarget in one deal', () => {
    // [445, 490] → [505, 526]: side 0 made its contract yet side 1 wins.
    const built = ninthTrickState({
      scores: [445, 490],
      declarer: 2,
      contract: 60,
      lastTrickTo: 0,
    });
    const { events, state } = playFinalCard(built);
    expect(events[3]).toEqual({ type: 'matchEnded', winnerSide: 1 });
    expect(state.scores).toEqual([505, 526]);
    expect(state.winnerSide).toBe(1);
  });

  it('plays another deal when both sides land on EQUAL scores ≥ winTarget', () => {
    // [440, 464] → [500, 500]: no matchEnded, the match continues.
    const built = ninthTrickState({
      scores: [440, 464],
      declarer: 2,
      contract: 60,
      lastTrickTo: 0,
    });
    const { events, state } = playFinalCard(built);
    expect(events).toHaveLength(3); // cardPlayed, trickWon, dealScored — no matchEnded
    expect(events.some((e) => e.type === 'matchEnded')).toBe(false);
    expect(state.scores).toEqual([500, 500]);
    expect(state.winnerSide).toBeNull();

    // Play continues: the next deal is dealable and opens a fresh bidding phase.
    const e = nextDealEvent(state, makeDeck());
    expect(e).toEqual({ type: 'dealStarted', dealIndex: 1, dealer: 1, deck: makeDeck() });
    const next = applyEvent(state, e);
    expect(next.deal?.phase).toEqual({
      name: 'bidding',
      turn: 2,
      highBid: null,
      passed: [],
      firstTurnTaken: [],
    });
  });

  it('can end the match on the opponents raw points while the declarer fails', () => {
    // [420, 300]: declarer side 1 fails 200 (−200), side 0 collects raw 94.
    const built = ninthTrickState({
      scores: [420, 300],
      declarer: 1,
      contract: 200,
      lastTrickTo: 0,
    });
    const { events, state } = playFinalCard(built);
    const result = ninthTrickResult(1, 200, 0);
    expect(result.made).toBe(false);
    expect(result.sides[1].scoreDelta).toBe(-200);
    expect(events[2]).toEqual({ type: 'dealScored', result });
    expect(events[3]).toEqual({ type: 'matchEnded', winnerSide: 0 });
    expect(state.scores).toEqual([514, 100]);
    expect(state.winnerSide).toBe(0);
  });

  it('accumulates negative scores across deals without ending the match', () => {
    // Deal 1: [-100, -300], declarer side 1 fails 200 → [-6, -500].
    const deal1 = playFinalCard(
      ninthTrickState({ scores: [-100, -300], declarer: 1, contract: 200, lastTrickTo: 0 }),
    );
    expect(deal1.events.some((e) => e.type === 'matchEnded')).toBe(false);
    expect(deal1.state.scores).toEqual([-6, -500]);
    expect(deal1.state.winnerSide).toBeNull();

    // Deal 2 from those scores: side 1 fails 50 more → [88, -550]. Still going.
    const deal2 = playFinalCard(
      ninthTrickState({
        scores: [-6, -500],
        dealer: 1,
        dealIndex: 1,
        declarer: 1,
        contract: 50,
        lastTrickTo: 0,
      }),
    );
    expect(deal2.events.some((e) => e.type === 'matchEnded')).toBe(false);
    expect(deal2.state.scores).toEqual([88, -550]);
    expect(deal2.state.winnerSide).toBeNull();
    expect(nextDealEvent(deal2.state, makeDeck())).toEqual({
      type: 'dealStarted',
      dealIndex: 2,
      dealer: 2,
      deck: makeDeck(),
    });
  });

  it('lets the last-trick bonus decide whether the match ends', () => {
    // Same deal, only the final trick winner differs: side 1 raw 46 vs 36.
    const winBonus = playFinalCard(
      ninthTrickState({ scores: [0, 460], declarer: 2, contract: 60, lastTrickTo: 1 }),
    );
    expect(winBonus.state.scores).toEqual([60, 506]); // 460 + 36 + 10 → matchEnded
    expect(winBonus.state.winnerSide).toBe(1);
    expect(winBonus.events.some((e) => e.type === 'matchEnded')).toBe(true);

    const noBonus = playFinalCard(
      ninthTrickState({ scores: [0, 460], declarer: 2, contract: 60, lastTrickTo: 0 }),
    );
    expect(noBonus.state.scores).toEqual([60, 496]); // 460 + 36 → short of 500
    expect(noBonus.state.winnerSide).toBeNull();
    expect(noBonus.events.some((e) => e.type === 'matchEnded')).toBe(false);
  });
});
