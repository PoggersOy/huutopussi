/**
 * legality-oracle.test.ts — fast-check property suite for legalPlays().
 *
 * The oracle in this file is an INDEPENDENT brute-force reimplementation of
 * trick legality, derived only from docs/huutopussin-saannot.md:
 *
 *   §2   Rank order high→low: A, 10, K, Q, J, 9, 8, 7, 6 (the 10 beats the K).
 *   §5.5 The three obligations ("kolme pakkoa"):
 *     1. Maapakko — must play the led suit if possible.
 *     2. Ylimenopakko — must play a card that beats the highest card of the
 *        trick so far, if possible (a partner's card must be beaten too).
 *        Holding the led suit but unable to beat (e.g. the trick was already
 *        trumped) → must still follow suit and may NOT play trump; any card of
 *        the led suit is then legal.
 *     3. Valttipakko — void in the led suit with a trump defined → must play
 *        trump, and per the ylimenopakko must beat the trick's highest trump
 *        if possible (otherwise any trump: forced undertrump).
 *   Void in the led suit and holding no trump (or no trump defined yet) → any
 *   card. The trick is won by the highest trump played, otherwise by the
 *   highest card of the led suit; an off-suit non-trump card never wins.
 *
 * It deliberately shares no code with src/legality.ts (which was not read):
 * rank comparison, winner resolution and the obligation cascade are all
 * re-derived here from the rules text.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Card, Seat, Suit, TrickPlay } from '../src/index.js';
import { legalPlays, RANKS, SUITS } from '../src/index.js';

// ── Independent oracle (rules doc §2 + §5.5 only) ────────────────────────────

/** All 36 cards, built straight from the frozen SUITS × RANKS constants. */
const FULL_DECK: readonly Card[] = SUITS.flatMap((s) => RANKS.map((r): Card => `${s}${r}`));

/** §2: A, 10, K, Q, J, 9, 8, 7, 6 — lower index = stronger card. */
const RANK_HIGH_TO_LOW: readonly string[] = ['A', '10', 'K', 'Q', 'J', '9', '8', '7', '6'];

function suitOfCard(card: Card): Suit {
  return card[0] as Suit;
}

function rankStrength(card: Card): number {
  return RANK_HIGH_TO_LOW.indexOf(card.slice(1));
}

/** True if `a` is a stronger card than `b` of the same suit. */
function strongerSameSuit(a: Card, b: Card): boolean {
  return rankStrength(a) < rankStrength(b);
}

/**
 * §5.5: the card currently winning a non-empty trick — the highest trump if
 * any trump was played, otherwise the highest card of the led suit.
 */
function oracleWinningCard(plays: readonly TrickPlay[], trump: Suit | null): Card {
  const first = plays[0];
  if (!first) throw new Error('oracleWinningCard: empty trick');
  const led = suitOfCard(first.card);
  const cards = plays.map((p) => p.card);
  const trumpsPlayed = trump === null ? [] : cards.filter((c) => suitOfCard(c) === trump);
  const pool = trumpsPlayed.length > 0 ? trumpsPlayed : cards.filter((c) => suitOfCard(c) === led);
  let best = pool[0] as Card; // pool is never empty: the led card itself qualifies
  for (const c of pool) if (strongerSameSuit(c, best)) best = c;
  return best;
}

/** Would `candidate` beat the current winning card (§5.5 "ylittää")? */
function oracleBeatsWinner(candidate: Card, winner: Card, trump: Suit | null): boolean {
  const cs = suitOfCard(candidate);
  const ws = suitOfCard(winner);
  if (trump !== null && cs === trump) {
    return ws === trump ? strongerSameSuit(candidate, winner) : true;
  }
  if (trump !== null && ws === trump) return false; // non-trump never beats a trump
  if (cs !== ws) return false; // off-suit non-trump cards never win
  return strongerSameSuit(candidate, winner);
}

/** Brute-force legal set: apply the §5.5 obligation cascade card by card. */
function oracleLegalPlays(
  hand: readonly Card[],
  plays: readonly TrickPlay[],
  trump: Suit | null,
): Card[] {
  const first = plays[0];
  if (!first) return [...hand]; // leading a trick: any card

  const led = suitOfCard(first.card);
  const winner = oracleWinningCard(plays, trump);

  const ledCards = hand.filter((c) => suitOfCard(c) === led);
  if (ledCards.length > 0) {
    // Maapakko: must follow suit — trumping while holding the led suit is
    // illegal ("ei saa lyödä valttia"). Ylimenopakko: within the led suit,
    // must beat the current winner if any led-suit card can; when none can
    // (e.g. the trick is already trumped), any led-suit card is legal.
    const heading = ledCards.filter((c) => oracleBeatsWinner(c, winner, trump));
    return heading.length > 0 ? heading : ledCards;
  }

  if (trump !== null) {
    const trumpCards = hand.filter((c) => suitOfCard(c) === trump);
    if (trumpCards.length > 0) {
      // Valttipakko: void in the led suit → must trump, and must beat the
      // trick's highest trump if possible; otherwise forced undertrump.
      const overtrumping = trumpCards.filter((c) => oracleBeatsWinner(c, winner, trump));
      return overtrumping.length > 0 ? overtrumping : trumpCards;
    }
  }

  // Void in the led suit with no trump in hand (or no trump defined): free.
  return [...hand];
}

// ── Position generators ──────────────────────────────────────────────────────

interface Position {
  hand: Card[];
  plays: TrickPlay[];
  trump: Suit | null;
}

function toPlays(cards: readonly Card[], leader: Seat): TrickPlay[] {
  return cards.map((card, i) => ({ seat: ((leader + i) % 4) as Seat, card }));
}

const seatArb: fc.Arbitrary<Seat> = fc.constantFrom<Seat>(0, 1, 2, 3);
const trumpArb: fc.Arbitrary<Suit | null> = fc.constantFrom<Suit | null>(null, ...SUITS);
/** A full random permutation of the 36-card deck; slices are disjoint by construction. */
const permArb = fc.shuffledSubarray([...FULL_DECK], { minLength: 36, maxLength: 36 });

/** Uniformly random position: 0–3 trick plays, then a disjoint 1–9 card hand. */
const uniformPositionArb: fc.Arbitrary<Position> = fc
  .record({
    perm: permArb,
    trickSize: fc.integer({ min: 0, max: 3 }),
    handSize: fc.integer({ min: 1, max: 9 }),
    leader: seatArb,
    trump: trumpArb,
  })
  .map(({ perm, trickSize, handSize, leader, trump }) => ({
    plays: toPlays(perm.slice(0, trickSize), leader),
    hand: perm.slice(trickSize, trickSize + handSize),
    trump,
  }));

/**
 * Suit-clustered position: the hand prefers 1–2 chosen suits (topped up with
 * arbitrary cards when those run out). Makes voids, forced follows, forced
 * trumps and forced over/undertrumps far more frequent than uniform sampling.
 */
const biasedPositionArb: fc.Arbitrary<Position> = fc
  .record({
    perm: permArb,
    trickSize: fc.integer({ min: 0, max: 3 }),
    handSize: fc.integer({ min: 1, max: 9 }),
    leader: seatArb,
    trump: trumpArb,
    handSuits: fc.shuffledSubarray([...SUITS], { minLength: 1, maxLength: 2 }),
  })
  .map(({ perm, trickSize, handSize, leader, trump, handSuits }) => {
    const rest = perm.slice(trickSize);
    const preferred = rest.filter((c) => handSuits.includes(suitOfCard(c)));
    const filler = rest.filter((c) => !handSuits.includes(suitOfCard(c)));
    return {
      plays: toPlays(perm.slice(0, trickSize), leader),
      hand: [...preferred, ...filler].slice(0, handSize),
      trump,
    };
  });

function sortedSet(cards: readonly Card[]): Card[] {
  return [...cards].sort();
}

// ── Oracle self-checks (hand-derived from the rules text) ────────────────────
// Guards against the oracle and the engine agreeing on WRONG behavior: every
// expected set below was worked out by hand from §5.5, and both the oracle and
// legalPlays must produce exactly it.

interface HandCase {
  name: string;
  hand: Card[];
  trick: Card[];
  trump: Suit | null;
  expected: Card[];
}

const HAND_CASES: HandCase[] = [
  {
    name: 'empty trick: the whole hand is legal',
    hand: ['HA', 'S6', 'D9'],
    trick: [],
    trump: 'S',
    expected: ['HA', 'S6', 'D9'],
  },
  {
    name: 'must head within the led suit when able',
    hand: ['HA', 'H6', 'SA'],
    trick: ['H10'],
    trump: null,
    expected: ['HA'],
  },
  {
    name: 'cannot head: any led-suit card, still no discarding',
    hand: ['HK', 'H6', 'SA'],
    trick: ['H10'],
    trump: null,
    expected: ['HK', 'H6'],
  },
  {
    name: "partner's winning card must be beaten too",
    hand: ['HA', 'H8'], // seat 2 to act; seat 0 (partner) leads and is winning
    trick: ['HK', 'H6'],
    trump: null,
    expected: ['HA'],
  },
  {
    name: 'trick already trumped while holding led suit: any led-suit card, never trump',
    hand: ['HA', 'HK', 'S8'],
    trick: ['H9', 'SJ'],
    trump: 'S',
    expected: ['HA', 'HK'],
  },
  {
    name: 'may not trump while holding the led suit',
    hand: ['H6', 'SA'],
    trick: ['H10'],
    trump: 'S',
    expected: ['H6'],
  },
  {
    name: 'void in led suit: must trump',
    hand: ['S6', 'D7'],
    trick: ['H9'],
    trump: 'S',
    expected: ['S6'],
  },
  {
    name: 'void and trick trumped: must overtrump when able',
    hand: ['S6', 'SQ', 'D7'],
    trick: ['H9', 'SJ'],
    trump: 'S',
    expected: ['SQ'],
  },
  {
    name: 'void and cannot overtrump: forced undertrump (any trump)',
    hand: ['S6', 'SJ', 'D7'],
    trick: ['H9', 'SQ'],
    trump: 'S',
    expected: ['S6', 'SJ'],
  },
  {
    name: 'void in led suit and in trump: any card',
    hand: ['D7', 'C8'],
    trick: ['H9'],
    trump: 'S',
    expected: ['D7', 'C8'],
  },
  {
    name: 'void in led suit and no trump defined: any card',
    hand: ['S6', 'D7'],
    trick: ['H9'],
    trump: null,
    expected: ['S6', 'D7'],
  },
  {
    name: 'led suit is trump: must head within trump',
    hand: ['SA', 'S6', 'H7'],
    trick: ['S10'],
    trump: 'S',
    expected: ['SA'],
  },
  {
    name: 'led suit is trump, cannot head: any trump, no off-suit card',
    hand: ['S9', 'S6', 'H7'],
    trick: ['S10'],
    trump: 'S',
    expected: ['S9', 'S6'],
  },
  {
    name: 'the 10 outranks the K (only the 10 heads a led K)',
    hand: ['H10', 'HJ'],
    trick: ['HK'],
    trump: null,
    expected: ['H10'],
  },
  {
    name: 'three plays, led suit is trump: head the highest trump',
    hand: ['H8', 'H10'],
    trick: ['H7', 'H9', 'HJ'],
    trump: 'H',
    expected: ['H10'],
  },
  {
    name: 'void, trick trumped mid-way: overtrump options only',
    hand: ['S7', 'SA', 'D6'],
    trick: ['H7', 'S6', 'H10'],
    trump: 'S',
    expected: ['SA', 'S7'],
  },
];

describe('oracle self-checks (hand-computed §5.5 scenarios)', () => {
  for (const { name, hand, trick, trump, expected } of HAND_CASES) {
    it(name, () => {
      const plays = toPlays(trick, 0);
      expect(sortedSet(oracleLegalPlays(hand, plays, trump))).toEqual(sortedSet(expected));
      expect(sortedSet(legalPlays(hand, plays, trump))).toEqual(sortedSet(expected));
    });
  }
});

// ── Generator sanity ─────────────────────────────────────────────────────────

describe('position generators', () => {
  it('produce well-formed positions (disjoint distinct cards, 0-3 plays, 1-9 hand)', () => {
    for (const arb of [uniformPositionArb, biasedPositionArb]) {
      fc.assert(
        fc.property(arb, ({ hand, plays, trump }) => {
          const all = [...hand, ...plays.map((p) => p.card)];
          expect(new Set(all).size).toBe(all.length);
          expect(plays.length).toBeGreaterThanOrEqual(0);
          expect(plays.length).toBeLessThanOrEqual(3);
          expect(hand.length).toBeGreaterThanOrEqual(1);
          expect(hand.length).toBeLessThanOrEqual(9);
          expect(trump === null || SUITS.includes(trump)).toBe(true);
          for (let i = 1; i < plays.length; i++) {
            const prev = plays[i - 1] as TrickPlay;
            expect((plays[i] as TrickPlay).seat).toBe((prev.seat + 1) % 4);
          }
        }),
        { numRuns: 2_000 },
      );
    }
  });
});

// ── The oracle equivalence properties ────────────────────────────────────────

describe('legalPlays vs independent §5.5 oracle', () => {
  it('matches the oracle exactly on 100k uniform random positions', () => {
    fc.assert(
      fc.property(uniformPositionArb, ({ hand, plays, trump }) => {
        const actual = legalPlays(hand, plays, trump);
        const expected = oracleLegalPlays(hand, plays, trump);
        expect(sortedSet(actual)).toEqual(sortedSet(expected));
      }),
      { numRuns: 100_000 },
    );
  }, 120_000);

  it('matches the oracle exactly on 30k suit-clustered positions (voids & forced plays)', () => {
    fc.assert(
      fc.property(biasedPositionArb, ({ hand, plays, trump }) => {
        const actual = legalPlays(hand, plays, trump);
        const expected = oracleLegalPlays(hand, plays, trump);
        expect(sortedSet(actual)).toEqual(sortedSet(expected));
      }),
      { numRuns: 30_000 },
    );
  }, 120_000);
});

// ── Standalone structural properties ─────────────────────────────────────────

describe('structural properties of legalPlays', () => {
  it('never returns an empty set for a non-empty hand', () => {
    for (const arb of [uniformPositionArb, biasedPositionArb]) {
      fc.assert(
        fc.property(arb, ({ hand, plays, trump }) => {
          expect(legalPlays(hand, plays, trump).length).toBeGreaterThan(0);
        }),
        { numRuns: 10_000 },
      );
    }
  }, 120_000);

  it('returns only cards from the hand, without duplicates', () => {
    for (const arb of [uniformPositionArb, biasedPositionArb]) {
      fc.assert(
        fc.property(arb, ({ hand, plays, trump }) => {
          const legal = legalPlays(hand, plays, trump);
          const handSet = new Set(hand);
          for (const c of legal) expect(handSet.has(c)).toBe(true);
          expect(new Set(legal).size).toBe(legal.length);
        }),
        { numRuns: 10_000 },
      );
    }
  }, 120_000);

  it('monotonicity: adding an off-suit zero-relevance card never removes previously-legal cards', () => {
    // A "zero-relevance" card is absent from hand and trick and belongs to
    // neither the led suit nor the trump suit — it cannot create or tighten
    // any of the three obligations, so the old legal set must survive intact.
    fc.assert(
      fc.property(
        fc.record({
          perm: permArb,
          trickSize: fc.integer({ min: 0, max: 3 }),
          handSize: fc.integer({ min: 1, max: 8 }), // leave room for the extra card
          leader: seatArb,
          trump: trumpArb,
          pick: fc.nat(),
        }),
        ({ perm, trickSize, handSize, leader, trump, pick }) => {
          const plays = toPlays(perm.slice(0, trickSize), leader);
          const hand = perm.slice(trickSize, trickSize + handSize);
          const firstPlay = plays[0];
          const led = firstPlay ? suitOfCard(firstPlay.card) : null;
          const remaining = perm.slice(trickSize + handSize);
          const eligible = remaining.filter(
            (c) => led === null || (suitOfCard(c) !== led && suitOfCard(c) !== trump),
          );
          fc.pre(eligible.length > 0); // provably always true, kept as a guard
          const extra = eligible[pick % eligible.length] as Card;

          const before = legalPlays(hand, plays, trump);
          const after = new Set(legalPlays([...hand, extra], plays, trump));
          for (const c of before) {
            if (!after.has(c)) {
              throw new Error(
                `legal card ${c} disappeared after adding zero-relevance card ${extra} ` +
                  `(trick=[${plays.map((p) => p.card).join(',')}], trump=${trump ?? 'none'})`,
              );
            }
          }
        },
      ),
      { numRuns: 30_000 },
    );
  }, 120_000);
});
