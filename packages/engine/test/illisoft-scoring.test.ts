/**
 * ILLISOFT_RULES scoring & first-trick specification suite
 * (docs/illisoft-saannot-spec.md §5, §7, §8, §9; §11 contract).
 *
 * scoreDeal under ILLISOFT_RULES (cardPoints 'A', lastTrickBonus 20 → 140/deal,
 * opponentRounding 'nearest5', declarerPorvooScope 'side', declarerPorvooBasis
 * 'contract', winCondition 'exceed', winTiebreak 'declarer', firstTrickRules
 * 'aceShow', askLockouts 'illisoft'):
 *  - last-trick bonus 20; every non-declarer side's rawTotal rounded to the
 *    nearest 5 (roundedTotal + scoreDelta);
 *  - a trickless opponent side loses the winning BID, never the raised contract;
 *  - the declarer's Porvoo is judged on the whole SIDE and costs −2×CONTRACT
 *    (a single partner trick cancels it — the opposite of päämuoto seat scope);
 *  - a failed contract still costs −contract; the 2-3p koini discards score to
 *    the declarer only when the side won ≥1 trick;
 *  - a 2p läpäri (all tricks) scores a notional 140 + own marriages, ignoring
 *    the captured piles and NOT double-counting the discards;
 *  - a contract-less deal scores every side its rounded raw with no penalties;
 *  - the match is won by EXCEEDING winTarget (an exact landing does not win),
 *    the declarer's side takes a multi-cross tie, a declarer-less deal falls
 *    back to the higher total, and an exact top tie plays on.
 *
 * First trick 'aceShow': the leader must lead an ace (else a spade, else any);
 * a follower holding the led suit's ace must show it; in 2p the ace may sit in
 * the dead dummy so nobody is forced.
 *
 * Ask lockouts 'illisoft': a half-ask bars BOTH partners from declareOwn and
 * askWhole; a whole-ask bars only the asker's own declareOwn; half-asks repeat.
 */
import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../src/config.js';
import { ILLISOFT_RULES } from '../src/config.js';
import { makeCard, makeDeck, sumCardPoints } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import { scoreDeal } from '../src/scoring.js';
import type {
  Card,
  DealState,
  Declaration,
  DeclarationHow,
  GameEvent,
  MatchState,
  PlayerAction,
  Rank,
  Seat,
  Suit,
  TrickPlay,
} from '../src/types.js';
import { isRuleError, nextSeat, SEATS, SUITS, sideOf, tricksPerDeal } from '../src/types.js';
import { allowedActions, validateAction } from '../src/validate.js';

// ── Configs under test ────────────────────────────────────────────────────────

const CFG_4P = ILLISOFT_RULES; // players 4
const CFG_3P: RuleConfig = { ...ILLISOFT_RULES, players: 3 };
const CFG_2P: RuleConfig = { ...ILLISOFT_RULES, players: 2 };

// ── Card groups (system A points in comments) ────────────────────────────────

const ofRank = (rank: Rank): Card[] => SUITS.map((s) => makeCard(s, rank));
const ACES = ofRank('A'); // 44
const TENS = ofRank('10'); // 40
const KINGS = ofRank('K'); // 16
const QUEENS = ofRank('Q'); // 12
const JACKS = ofRank('J'); // 8
/** The twelve worthless non-spade lows (the four low spades feed the last trick). */
const LOWS_NONSPADE: Card[] = [
  'H9',
  'D9',
  'C9',
  'H8',
  'D8',
  'C8',
  'H7',
  'D7',
  'C7',
  'H6',
  'D6',
  'C6',
];
const LOW_SPADES: [Card, Card, Card, Card] = ['S9', 'S8', 'S7', 'S6'];

// ── Builders ─────────────────────────────────────────────────────────────────

function piles(over: Partial<Record<Seat, Card[]>>): Record<Seat, Card[]> {
  return {
    0: [...(over[0] ?? [])],
    1: [...(over[1] ?? [])],
    2: [...(over[2] ?? [])],
    3: [...(over[3] ?? [])],
  };
}

function wins(over: Partial<Record<Seat, number>>): Record<Seat, number> {
  return { 0: over[0] ?? 0, 1: over[1] ?? 0, 2: over[2] ?? 0, 3: over[3] ?? 0 };
}

function decl(
  seat: Seat,
  suit: Suit,
  points: number,
  players: 2 | 3 | 4,
  how: DeclarationHow = 'own',
  trickIndex = 2,
): Declaration {
  return { suit, seat, side: sideOf(seat, players), how, trickIndex, points };
}

/** A fully-played DealState ready for scoreDeal, with sensible defaults. */
function baseDeal(config: RuleConfig, over: Partial<DealState>): DealState {
  return {
    hands: { 0: [], 1: [], 2: [], 3: [] },
    captured: { 0: [], 1: [], 2: [], 3: [] },
    tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0 },
    tricksPlayed: tricksPerDeal(config),
    trump: null,
    declarations: [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false },
    askedHalf: { 0: false, 1: false, 2: false, 3: false },
    deniedHalves: [],
    bidLog: [],
    bid: null,
    declarer: null,
    contract: null,
    exchange: { given: null, returned: null },
    talon: null,
    talonTakenBy: null,
    dummyHand: null,
    discarded: null,
    lastTrick: { plays: [], winner: 0 },
    phase: { name: 'lead', leader: 0, canDeclare: false },
    ...over,
  };
}

// ── scoreDeal — 4p ILLISOFT scoring ──────────────────────────────────────────

describe('scoreDeal — ILLISOFT 4p', () => {
  it('awards last-trick bonus 20 (140 card points/deal) and rounds the opponents', () => {
    const deal = baseDeal(CFG_4P, {
      declarer: 0,
      contract: 60,
      bid: { seat: 0, amount: 60 },
      captured: piles({ 0: ACES, 2: TENS, 1: [...KINGS, ...QUEENS], 3: JACKS }),
      tricksWon: wins({ 0: 3, 2: 2, 1: 2, 3: 2 }),
      lastTrick: { plays: [], winner: 0 },
    });
    const result = scoreDeal(deal, CFG_4P);
    // 84 + 36 card points + a single 20-point last trick = 140 per deal.
    expect((result.sides[0]?.cardPoints ?? 0) + (result.sides[1]?.cardPoints ?? 0)).toBe(120);
    expect((result.sides[0]?.lastTrickBonus ?? 0) + (result.sides[1]?.lastTrickBonus ?? 0)).toBe(
      20,
    );
    expect(result).toEqual({
      declarer: 0,
      contract: 60,
      bid: 60,
      made: true,
      sides: [
        {
          cardPoints: 84,
          lastTrickBonus: 20,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 104,
          roundedTotal: 105, // 104 → nearest 5
          tricks: 5,
          porvoo: false,
          scoreDelta: 60, // declarer clamp is untouched by rounding
        },
        {
          cardPoints: 36,
          lastTrickBonus: 0,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 36,
          roundedTotal: 35, // 36 → nearest 5
          tricks: 4,
          porvoo: false,
          scoreDelta: 35, // opponents score their ROUNDED raw
        },
      ],
    });
  });

  it('rounds opponent raw totals up and down to the nearest 5', () => {
    // Opponent raw 28 → 30 (rounds up).
    const up = scoreDeal(
      baseDeal(CFG_4P, {
        declarer: 0,
        contract: 60,
        bid: { seat: 0, amount: 60 },
        captured: piles({ 0: [...ACES, ...TENS], 2: JACKS, 1: KINGS, 3: QUEENS }),
        tricksWon: wins({ 0: 3, 2: 2, 1: 2, 3: 2 }),
        lastTrick: { plays: [], winner: 0 },
      }),
      CFG_4P,
    );
    expect(up.sides[1]?.rawTotal).toBe(28);
    expect(up.sides[1]?.roundedTotal).toBe(30);
    expect(up.sides[1]?.scoreDelta).toBe(30);

    // Opponent raw 12 → 10 (rounds down).
    const down = scoreDeal(
      baseDeal(CFG_4P, {
        declarer: 0,
        contract: 60,
        bid: { seat: 0, amount: 60 },
        captured: piles({ 0: [...ACES, ...TENS], 2: [...KINGS, ...JACKS], 1: QUEENS, 3: [] }),
        tricksWon: wins({ 0: 3, 2: 2, 1: 2, 3: 2 }),
        lastTrick: { plays: [], winner: 0 },
      }),
      CFG_4P,
    );
    expect(down.sides[1]?.rawTotal).toBe(12);
    expect(down.sides[1]?.roundedTotal).toBe(10);
    expect(down.sides[1]?.scoreDelta).toBe(10);
  });

  it('charges a trickless opponent side the winning BID, never the raised contract', () => {
    const deal = baseDeal(CFG_4P, {
      declarer: 2,
      contract: 120,
      bid: { seat: 2, amount: 60 }, // raised 60 → 120
      captured: piles({ 2: makeDeck() }), // side 0 sweeps all nine tricks
      tricksWon: wins({ 2: 9 }),
      lastTrick: { plays: [], winner: 2 },
    });
    const result = scoreDeal(deal, CFG_4P);
    expect(result.made).toBe(true);
    expect(result.sides[0]?.scoreDelta).toBe(120); // declarer clamp
    expect(result.sides[1]).toEqual({
      cardPoints: 0,
      lastTrickBonus: 0,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 0,
      roundedTotal: 0,
      tricks: 0,
      porvoo: true,
      scoreDelta: -60, // −bid, NOT −contract (−120)
    });
  });

  it('Porvoos a trickless declarer SIDE at −2×CONTRACT (side scope, contract basis)', () => {
    const deal = baseDeal(CFG_4P, {
      declarer: 2,
      contract: 120,
      bid: { seat: 2, amount: 60 },
      captured: piles({ 1: makeDeck() }), // side 1 sweeps; declarer side 0 trickless
      tricksWon: wins({ 1: 9 }),
      lastTrick: { plays: [], winner: 1 },
    });
    const result = scoreDeal(deal, CFG_4P);
    expect(result.made).toBe(false);
    expect(result.sides[0]).toEqual({
      cardPoints: 0,
      lastTrickBonus: 0,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 0,
      roundedTotal: 0,
      tricks: 0,
      porvoo: true,
      scoreDelta: -240, // −2 × contract (120), NOT −2 × bid (−120)
    });
    expect(result.sides[1]?.scoreDelta).toBe(140);
  });

  it('a single partner trick cancels the declarer Porvoo (side scope, not seat)', () => {
    // Declarer seat 0 personally won NOTHING; partner seat 2 took the tricks.
    // Under illisoft side scope the declarer side is NOT in Porvoo — the exact
    // opposite of the päämuoto seat-scope ruling.
    const deal = baseDeal(CFG_4P, {
      declarer: 0,
      contract: 60,
      bid: { seat: 0, amount: 60 },
      captured: piles({ 0: [], 2: [...ACES, ...TENS], 1: [...KINGS, ...QUEENS], 3: JACKS }),
      tricksWon: wins({ 0: 0, 2: 5, 1: 2, 3: 2 }),
      lastTrick: { plays: [], winner: 2 },
    });
    const result = scoreDeal(deal, CFG_4P);
    expect(result.sides[0]?.porvoo).toBe(false);
    expect(result.sides[0]?.tricks).toBe(5); // side has tricks; the declarer seat does not
    expect(result.sides[0]?.rawTotal).toBe(104); // 84 + 20 last trick
    expect(result.sides[0]?.scoreDelta).toBe(60); // made → clamp, no Porvoo
    expect(result.made).toBe(true);
  });

  it('costs a failed contract exactly −contract when the side has tricks', () => {
    const deal = baseDeal(CFG_4P, {
      declarer: 0,
      contract: 200,
      bid: { seat: 0, amount: 200 },
      captured: piles({ 0: ACES, 2: TENS, 1: [...KINGS, ...QUEENS], 3: JACKS }),
      tricksWon: wins({ 0: 3, 2: 2, 1: 2, 3: 2 }),
      lastTrick: { plays: [], winner: 0 },
    });
    const result = scoreDeal(deal, CFG_4P);
    expect(result.made).toBe(false);
    expect(result.sides[0]?.porvoo).toBe(false);
    expect(result.sides[0]?.rawTotal).toBe(104); // short of 200
    expect(result.sides[0]?.scoreDelta).toBe(-200); // −contract
    expect(result.sides[1]?.scoreDelta).toBe(35); // opponents unaffected, rounded
  });
});

// ── scoreDeal — 2-3p koini discards & 2p läpäri ──────────────────────────────

describe('scoreDeal — 2-3p koini discards', () => {
  it('scores the declarer discards to the side when it won ≥1 trick', () => {
    // 3p, talonSize 3, 11 tricks; SK sits in the discards (not in any pile).
    const deal = baseDeal(CFG_3P, {
      declarer: 0,
      contract: 60,
      bid: { seat: 0, amount: 60 },
      captured: piles({
        0: [...ACES, ...TENS], // 84
        1: ['HK', 'DK', 'CK', ...QUEENS, ...JACKS], // 12 + 12 + 8 = 32
        2: [],
      }),
      tricksWon: wins({ 0: 5, 1: 4, 2: 2 }),
      discarded: ['SK', 'S9', 'S8'], // SK worth 4
      lastTrick: { plays: [], winner: 0 },
    });
    const result = scoreDeal(deal, CFG_3P);
    expect(result.sides).toHaveLength(3);
    expect(result.sides[0]?.discardPoints).toBe(4);
    expect(result.sides[0]?.rawTotal).toBe(108); // 84 + 20 + 0 + 4
    expect(result.sides[0]?.scoreDelta).toBe(60); // made, clamp
  });

  it('drops the discards when the declarer side is trickless', () => {
    const deal = baseDeal(CFG_3P, {
      declarer: 0,
      contract: 60,
      bid: { seat: 0, amount: 60 },
      captured: piles({ 0: [], 1: [...ACES, ...TENS], 2: [...KINGS, ...QUEENS, ...JACKS] }),
      tricksWon: wins({ 0: 0, 1: 6, 2: 5 }),
      discarded: ['SK', 'S9', 'S8'], // worth 4, but must NOT count
      lastTrick: { plays: [], winner: 1 },
    });
    const result = scoreDeal(deal, CFG_3P);
    expect(result.sides[0]?.discardPoints).toBe(0);
    expect(result.sides[0]?.rawTotal).toBe(0);
    expect(result.sides[0]?.porvoo).toBe(true); // side scope: seat-0 side trickless
    expect(result.sides[0]?.scoreDelta).toBe(-120); // −2 × contract
  });

  it('2p läpäri scores a notional 140 + marriages, ignoring piles and discards', () => {
    // Declarer seat 0 wins every one of the 11 tricks. captured[0] is worth only
    // 112 and the discards carry points, yet the slam counts a flat 120 + 20 and
    // zero discard points.
    const deal = baseDeal(CFG_2P, {
      declarer: 0,
      contract: 200,
      bid: { seat: 0, amount: 200 },
      captured: piles({ 0: [...ACES, ...TENS, ...KINGS, ...QUEENS] }), // 112 real
      tricksWon: wins({ 0: 11, 1: 0 }),
      discarded: ['SJ', 'S9', 'S8'], // worth 2 — must NOT be added on top
      declarations: [decl(0, 'H', 100, 2)],
      trump: 'H',
      lastTrick: { plays: [], winner: 0 },
    });
    expect(sumCardPoints(deal.captured[0], CFG_2P)).toBe(112); // sanity: piles ≠ 120
    const result = scoreDeal(deal, CFG_2P);
    expect(result.sides).toHaveLength(2);
    expect(result.sides[0]).toEqual({
      cardPoints: 120, // notional full deck, overriding the 112 captured
      lastTrickBonus: 20,
      marriagePoints: 100,
      discardPoints: 0, // discards folded into the notional 140, not doubled
      rawTotal: 240, // 120 + 20 + 100
      roundedTotal: 240,
      tricks: 11,
      porvoo: false,
      scoreDelta: 200, // made, clamp
    });
    expect(result.sides[1]?.scoreDelta).toBe(-200); // trickless opponent → −bid
  });
});

// ── scoreDeal — contract-less (all-pass) deals ───────────────────────────────

describe('scoreDeal — contract-less deals', () => {
  it('scores every side its rounded raw with NO trickless penalty', () => {
    const deal = baseDeal(CFG_4P, {
      declarer: null,
      contract: null,
      bid: null,
      captured: piles({ 0: ACES, 2: TENS, 1: [...KINGS, ...QUEENS], 3: JACKS }),
      tricksWon: wins({ 0: 3, 2: 1, 1: 3, 3: 2 }),
      lastTrick: { plays: [], winner: 0 }, // side 0 gets the last-trick bonus
    });
    const result = scoreDeal(deal, CFG_4P);
    expect(result.declarer).toBeNull();
    expect(result.contract).toBeNull();
    expect(result.bid).toBeNull();
    expect(result.made).toBeNull();
    expect(result.sides[0]).toEqual({
      cardPoints: 84,
      lastTrickBonus: 20,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 104,
      roundedTotal: 105,
      tricks: 4,
      porvoo: false,
      scoreDelta: 105, // rounded raw, no clamp
    });
    expect(result.sides[1]).toEqual({
      cardPoints: 36,
      lastTrickBonus: 0,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 36,
      roundedTotal: 35,
      tricks: 5,
      porvoo: false,
      scoreDelta: 35,
    });
  });

  it('leaves a trickless side at rounded raw 0 with no Porvoo (no bid to deduct)', () => {
    const deal = baseDeal(CFG_4P, {
      declarer: null,
      contract: null,
      bid: null,
      captured: piles({ 0: makeDeck() }), // side 0 sweeps; side 1 trickless
      tricksWon: wins({ 0: 9 }),
      lastTrick: { plays: [], winner: 0 },
    });
    const result = scoreDeal(deal, CFG_4P);
    expect(result.sides[0]?.scoreDelta).toBe(140); // 120 + 20, rounded to itself
    expect(result.sides[1]).toEqual({
      cardPoints: 0,
      lastTrickBonus: 0,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 0,
      roundedTotal: 0,
      tricks: 0,
      porvoo: false, // NOT true, and no −bid
      scoreDelta: 0,
    });
  });
});

// ── Match end — the final card drives dealScored + matchEnded ─────────────────

interface FinalTrickOpts {
  scores: [number, number];
  declarer: Seat | null;
  contract: number | null;
  bid?: number | null;
  captured8: Partial<Record<Seat, Card[]>>;
  tricksWon8: Partial<Record<Seat, number>>;
  /** Wins the last (worthless-spade) trick, so its side takes the +20 bonus. */
  leader: Seat;
  declarations?: Declaration[];
  trump?: Suit | null;
  config?: RuleConfig;
  dealer?: Seat;
}

/**
 * A 4p deal frozen one card before completion: eight tricks are in the piles,
 * the ninth is the four low spades led by `leader` (who therefore wins it).
 * Playing the last card resolves the deal through validateAction.
 */
function finalTrick4p(opts: FinalTrickOpts): { state: MatchState; lastSeat: Seat; lastCard: Card } {
  const config = opts.config ?? CFG_4P;
  const captured = piles(opts.captured8);
  const guard = [...SEATS.flatMap((s) => captured[s]), ...LOW_SPADES].sort();
  const full = makeDeck().sort();
  if (guard.length !== 36 || guard.some((c, i) => c !== full[i])) {
    throw new Error('test bug: captured8 + last trick must partition the 36-card deck');
  }
  const a = opts.leader;
  const b = nextSeat(a, 4);
  const c = nextSeat(b, 4);
  const lastSeat = nextSeat(c, 4);
  const plays: TrickPlay[] = [
    { seat: a, card: LOW_SPADES[0] },
    { seat: b, card: LOW_SPADES[1] },
    { seat: c, card: LOW_SPADES[2] },
  ];
  const declarer = opts.declarer;
  const deal = baseDeal(config, {
    hands: { 0: [], 1: [], 2: [], 3: [], [lastSeat]: [LOW_SPADES[3]] },
    captured,
    tricksWon: wins(opts.tricksWon8),
    tricksPlayed: 8,
    trump: opts.trump ?? null,
    declarations: opts.declarations ?? [],
    bid:
      declarer === null ? null : { seat: declarer, amount: opts.bid ?? (opts.contract as number) },
    declarer,
    contract: opts.contract,
    lastTrick: { plays: [{ seat: a, card: 'HK' }], winner: a },
    phase: { name: 'follow', leader: a, plays },
  });
  const state: MatchState = {
    ...initialMatchState(config, opts.dealer ?? 0),
    scores: [opts.scores[0], opts.scores[1]],
    deal,
  };
  return { state, lastSeat, lastCard: LOW_SPADES[3] };
}

function playLast(built: { state: MatchState; lastSeat: Seat; lastCard: Card }): {
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

describe('match end — winCondition exceed', () => {
  // Declarer side 0 makes contract 60 (+60); opponents collect rounded raw 35.
  const madeDeal = (scores: [number, number]): FinalTrickOpts => ({
    scores,
    declarer: 0,
    contract: 60,
    captured8: { 0: ACES, 2: TENS, 1: [...KINGS, ...QUEENS], 3: [...JACKS, ...LOWS_NONSPADE] },
    tricksWon8: { 0: 2, 1: 2, 2: 2, 3: 2 },
    leader: 0,
  });

  it('does NOT win on an exact landing (500 is not > 500)', () => {
    const { events, state } = playLast(finalTrick4p(madeDeal([440, 0])));
    expect(state.scores).toEqual([500, 35]);
    expect(state.winnerSide).toBeNull();
    expect(events.some((e) => e.type === 'matchEnded')).toBe(false);
  });

  it('wins by exceeding winTarget (505 > 500)', () => {
    const { events, state } = playLast(finalTrick4p(madeDeal([445, 0])));
    expect(state.scores).toEqual([505, 35]);
    expect(state.winnerSide).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'matchEnded', winnerSide: 0 });
  });
});

describe('match end — multi-cross tiebreak', () => {
  it('awards the deal to the declarer side even when the opponents score higher', () => {
    // Declarer side 1 makes contract 60 (+60 → 530); opponents raw 84 → 85 → 565.
    const built = finalTrick4p({
      scores: [480, 470],
      declarer: 1,
      contract: 60,
      captured8: { 0: ACES, 2: TENS, 1: [...KINGS, ...QUEENS, ...JACKS], 3: LOWS_NONSPADE },
      tricksWon8: { 0: 2, 1: 2, 2: 2, 3: 2 },
      leader: 1, // side 1 takes the last-trick bonus
      declarations: [decl(1, 'H', 100, 4)],
      trump: 'H',
    });
    const { state } = playLast(built);
    expect(state.scores).toEqual([565, 530]);
    expect(state.winnerSide).toBe(1); // declarer tiebreak beats the higher total
  });

  it('falls back to the higher total when a declarer-less deal is multi-crossed', () => {
    const built = finalTrick4p({
      scores: [430, 480],
      declarer: null,
      contract: null,
      captured8: { 0: ACES, 2: TENS, 1: [...KINGS, ...QUEENS], 3: [...JACKS, ...LOWS_NONSPADE] },
      tricksWon8: { 0: 2, 1: 2, 2: 2, 3: 2 },
      leader: 0, // side 0 takes the bonus → raw 104 → 105
    });
    const { state } = playLast(built);
    expect(state.scores).toEqual([535, 515]);
    expect(state.winnerSide).toBe(0); // no declarer → higher wins
  });

  it('plays on when both sides tie at the exact top', () => {
    const built = finalTrick4p({
      scores: [435, 435],
      declarer: null,
      contract: null,
      // side 0: ACES + three jacks = 50 (+20 bonus → 70); side 1: 40+16+12+2 = 70.
      captured8: {
        0: ACES,
        2: ['HJ', 'DJ', 'CJ'],
        1: [...TENS, ...KINGS],
        3: [...QUEENS, 'SJ', ...LOWS_NONSPADE],
      },
      tricksWon8: { 0: 2, 1: 2, 2: 2, 3: 2 },
      leader: 0,
    });
    const { events, state } = playLast(built);
    expect(state.scores).toEqual([505, 505]);
    expect(state.winnerSide).toBeNull(); // exact top tie → another deal
    expect(events.some((e) => e.type === 'matchEnded')).toBe(false);

    const next = applyEvent(state, nextDealEvent(state, makeDeck()));
    expect(next.dealIndex).toBe(1);
    expect(next.dealer).toBe(1); // dealer rotates
    expect(next.deal?.phase.name).toBe('bidding');
  });
});

// ── First trick — aceShow ────────────────────────────────────────────────────

/** A first-trick DealState (tricksPlayed 0, trump null) in lead or follow. */
function firstTrick(
  config: RuleConfig,
  opts: { leader: Seat; hands: Partial<Record<Seat, Card[]>>; led?: Card; dummyHand?: Card[] },
): MatchState {
  const phase: DealState['phase'] =
    opts.led === undefined
      ? { name: 'lead', leader: opts.leader, canDeclare: false }
      : { name: 'follow', leader: opts.leader, plays: [{ seat: opts.leader, card: opts.led }] };
  const deal = baseDeal(config, {
    hands: piles(opts.hands),
    tricksPlayed: 0,
    declarer: opts.leader,
    contract: 60,
    bid: { seat: opts.leader, amount: 60 },
    dummyHand: opts.dummyHand ?? null,
    lastTrick: null,
    phase,
  });
  return { ...initialMatchState(config, 0), deal };
}

function codeOf(state: MatchState, seat: Seat, action: PlayerAction): string | null {
  const r = validateAction(state, seat, action);
  return isRuleError(r) ? r.code : null;
}

function legalPlaysHint(state: MatchState, seat: Seat): Card[] {
  const hint = allowedActions(state, seat).find((h) => h.type === 'playCard');
  return hint && hint.type === 'playCard' ? hint.legal : [];
}

describe('first trick — aceShow lead constraint', () => {
  it('forces an ace lead when the leader holds one', () => {
    const state = firstTrick(CFG_4P, { leader: 0, hands: { 0: ['DA', 'HK', 'SQ', 'C9'] } });
    expect(legalPlaysHint(state, 0)).toEqual(['DA']);
    expect(codeOf(state, 0, { type: 'playCard', card: 'HK' })).toBe('error.mustLeadAce');
    expect(codeOf(state, 0, { type: 'playCard', card: 'SQ' })).toBe('error.mustLeadAce');
    expect(codeOf(state, 0, { type: 'playCard', card: 'DA' })).toBeNull();
  });

  it('forces a spade lead when the leader has no ace but holds a spade', () => {
    const state = firstTrick(CFG_4P, { leader: 0, hands: { 0: ['SK', 'HQ', 'C9', 'D8'] } });
    expect(legalPlaysHint(state, 0)).toEqual(['SK']);
    expect(codeOf(state, 0, { type: 'playCard', card: 'HQ' })).toBe('error.mustLeadSpade');
    expect(codeOf(state, 0, { type: 'playCard', card: 'SK' })).toBeNull();
  });

  it('allows any lead when the leader has neither an ace nor a spade', () => {
    const hand: Card[] = ['HK', 'DQ', 'C9', 'D8'];
    const state = firstTrick(CFG_4P, { leader: 0, hands: { 0: hand } });
    expect(legalPlaysHint(state, 0)).toEqual(hand);
    expect(codeOf(state, 0, { type: 'playCard', card: 'HK' })).toBeNull();
    expect(codeOf(state, 0, { type: 'playCard', card: 'D8' })).toBeNull();
  });
});

describe('first trick — aceShow follower ("ässän pitää näkyä")', () => {
  it('forces the led suit ace out of the follower who holds it', () => {
    const state = firstTrick(CFG_4P, { leader: 0, hands: { 1: ['DA', 'DK', 'D9'] }, led: 'D10' });
    expect(legalPlaysHint(state, 1)).toEqual(['DA']);
    expect(codeOf(state, 1, { type: 'playCard', card: 'DK' })).toBe('error.aceMustShow');
    expect(codeOf(state, 1, { type: 'playCard', card: 'DA' })).toBeNull();
  });

  it('does not force a follower who lacks the led ace (just follow suit)', () => {
    const state = firstTrick(CFG_4P, { leader: 0, hands: { 1: ['DK', 'DQ', 'D9'] }, led: 'D10' });
    expect(legalPlaysHint(state, 1)).toEqual(['DK', 'DQ', 'D9']);
    expect(codeOf(state, 1, { type: 'playCard', card: 'DK' })).toBeNull();
  });

  it('forces nobody in 2p when the led suit ace sits in the dead dummy', () => {
    // Seat 0 leads D10; the DA lives in the dummy hand. Seat 1 (no DA) simply
    // follows suit — the ace-show rule cannot reach a card nobody holds.
    const state = firstTrick(CFG_2P, {
      leader: 0,
      hands: { 1: ['DK', 'HQ', 'S9'] },
      led: 'D10',
      dummyHand: ['DA', 'DQ', 'DJ'],
    });
    expect(legalPlaysHint(state, 1)).toEqual(['DK']); // holds a diamond → must follow
    expect(codeOf(state, 1, { type: 'playCard', card: 'DK' })).toBeNull();
    expect(codeOf(state, 1, { type: 'playCard', card: 'HQ' })).toBe('error.mustFollowSuit');
  });
});

// ── Ask lockouts — illisoft ──────────────────────────────────────────────────

/** A mid-deal lead state with an open declaration window and preset ask flags. */
function declState(opts: {
  leader: Seat;
  hands: Partial<Record<Seat, Card[]>>;
  askedHalf?: Partial<Record<Seat, boolean>>;
  askedWhole?: Partial<Record<Seat, boolean>>;
  declarations?: Declaration[];
}): MatchState {
  const deal = baseDeal(CFG_4P, {
    hands: piles(opts.hands),
    tricksPlayed: 1,
    tricksWon: wins({ [opts.leader]: 1 }),
    declarer: 0,
    contract: 60,
    bid: { seat: 0, amount: 60 },
    declarations: opts.declarations ?? [],
    askedHalf: {
      0: opts.askedHalf?.[0] ?? false,
      1: opts.askedHalf?.[1] ?? false,
      2: opts.askedHalf?.[2] ?? false,
      3: opts.askedHalf?.[3] ?? false,
    },
    askedWhole: {
      0: opts.askedWhole?.[0] ?? false,
      1: opts.askedWhole?.[1] ?? false,
      2: opts.askedWhole?.[2] ?? false,
      3: opts.askedWhole?.[3] ?? false,
    },
    lastTrick: { plays: [], winner: opts.leader },
    phase: { name: 'lead', leader: opts.leader, canDeclare: true },
  });
  return { ...initialMatchState(CFG_4P, 0), deal };
}

describe('ask lockouts — illisoft half-ask bars both partners', () => {
  it('locks the asker out of declareOwn and askWhole, but half-asks repeat', () => {
    const state = declState({
      leader: 1,
      hands: { 1: ['HK', 'HQ', 'SK', 'CK'], 3: ['DK', 'DQ'] },
      askedHalf: { 1: true },
    });
    expect(codeOf(state, 1, { type: 'declareOwn', suit: 'H' })).toBe('error.declarationLocked');
    expect(codeOf(state, 1, { type: 'askWhole' })).toBe('error.declarationLocked');
    // Half-asks stay open (repeatable), on more than one suit.
    expect(codeOf(state, 1, { type: 'askHalf', suit: 'S', rankHeld: 'K' })).toBeNull();
    expect(codeOf(state, 1, { type: 'askHalf', suit: 'C', rankHeld: 'K' })).toBeNull();
  });

  it("locks the asker's PARTNER out of declareOwn and askWhole too", () => {
    const state = declState({
      leader: 3,
      hands: { 3: ['DK', 'DQ', 'CK'], 1: ['HK', 'HQ'] },
      askedHalf: { 1: true }, // partner (seat 1) asked the half
    });
    expect(codeOf(state, 3, { type: 'declareOwn', suit: 'D' })).toBe('error.declarationLocked');
    expect(codeOf(state, 3, { type: 'askWhole' })).toBe('error.declarationLocked');
    // The partner may still half-ask.
    expect(codeOf(state, 3, { type: 'askHalf', suit: 'C', rankHeld: 'K' })).toBeNull();
  });
});

describe('ask lockouts — illisoft whole-ask bars only the asker', () => {
  it('locks the asker out of declareOwn while whole-asks remain repeatable', () => {
    const state = declState({
      leader: 1,
      hands: { 1: ['HK', 'HQ', 'SK'], 3: ['DK', 'DQ'] },
      askedWhole: { 1: true },
    });
    expect(codeOf(state, 1, { type: 'declareOwn', suit: 'H' })).toBe('error.declarationLocked');
    expect(codeOf(state, 1, { type: 'askWhole' })).toBeNull(); // repeatable
    expect(codeOf(state, 1, { type: 'askHalf', suit: 'S', rankHeld: 'K' })).toBeNull();
  });

  it('leaves the asker PARTNER free to declare from its own hand', () => {
    const state = declState({
      leader: 3,
      hands: { 3: ['DK', 'DQ'], 1: ['HK', 'HQ'] },
      askedWhole: { 1: true }, // seat 1 whole-asked; seat 3 is untouched
    });
    expect(codeOf(state, 3, { type: 'declareOwn', suit: 'D' })).toBeNull();
  });
});
