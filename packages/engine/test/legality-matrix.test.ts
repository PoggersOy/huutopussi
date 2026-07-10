/**
 * Table-driven case matrix for legalPlays() — the three pakko rules of
 * docs/huutopussin-saannot.md §5.5 (maapakko, ylimenopakko, valttipakko).
 *
 * The matrix spans the FULL cross product of six booleans:
 *
 *   T  trump defined            (deal.trump !== null)
 *   E  led suit IS trump        (suitOf(plays[0]) === trump)
 *   L  holds led suit           (hand has a card of the led suit)
 *   B  can beat current winner  (some card in hand beats the winning card,
 *                                per beats() — i.e. over the WHOLE hand)
 *   X  trick already trumped    (the current winning card is a trump)
 *   H  holds trump              (hand has a card of the trump suit)
 *
 * All 64 combinations are enumerated programmatically. Impossible combinations
 * are skipped with a machine-checked reason (see whyImpossible below); every
 * possible combination must be covered by at least one fixture row, and every
 * fixture row self-verifies that its hand/plays/trump really sit at the claimed
 * coordinates. 17 of the 64 combinations are possible:
 *
 *   - T=no forces E=no, X=no, H=no (no trump exists to be led, played or held),
 *     leaving {L}×{B} minus (L=no, B=yes): void with no trump can never beat.
 *   - E=yes forces X=yes (the winning card of a trump lead is always a trump)
 *     and H=L (holding the led suit IS holding trump), leaving 3 combos.
 *   - E=no, X=no, H=yes forces B=yes (any trump beats a non-trump winner).
 *   - X=yes, H=no forces B=no (only a higher trump beats a trump).
 *   - L=no, H=no forces B=no (an off-suit non-trump card never beats).
 *
 * One pair of distinct situations shares coordinates (T,E=no,L,B,X=no,H all
 * set): "a led-suit card can head" vs "only a held trump would beat". The
 * 6-dimensional matrix cannot separate them, so both appear as rows.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/config.js';
import { beats, makeDeck, suitOf, winningPlay } from '../src/deck.js';
import { legalPlays } from '../src/legality.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import type {
  Card,
  GameEvent,
  MatchState,
  PlayerAction,
  Seat,
  Suit,
  TrickPlay,
} from '../src/types.js';
import { isRuleError } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';

// ── Small helpers ─────────────────────────────────────────────────────────────

function tp(seat: Seat, card: Card): TrickPlay {
  return { seat, card };
}

/** A trick led by seat 0, seats ascending (actor identity is irrelevant here). */
function trick(...cards: Card[]): TrickPlay[] {
  return cards.map((card, i) => tp(i as Seat, card));
}

function sorted(cards: readonly Card[]): Card[] {
  return [...cards].sort();
}

// ── Matrix coordinates ────────────────────────────────────────────────────────

interface Coords {
  trumpDefined: boolean;
  ledIsTrump: boolean;
  holdsLed: boolean;
  canBeat: boolean;
  trickTrumped: boolean;
  holdsTrump: boolean;
}

function keyOf(c: Coords): string {
  const b = (v: boolean) => (v ? '1' : '0');
  return `T${b(c.trumpDefined)} E${b(c.ledIsTrump)} L${b(c.holdsLed)} B${b(c.canBeat)} X${b(
    c.trickTrumped,
  )} H${b(c.holdsTrump)}`;
}

/** Derives the true coordinates of a fixture (self-check against mislabeling). */
function coordsOf(hand: readonly Card[], plays: readonly TrickPlay[], trump: Suit | null): Coords {
  const first = plays[0];
  if (!first) throw new Error('coordsOf: matrix rows must have a non-empty trick');
  const led = suitOf(first.card);
  const winner = winningPlay(plays, trump).card;
  return {
    trumpDefined: trump !== null,
    ledIsTrump: trump !== null && led === trump,
    holdsLed: hand.some((c) => suitOf(c) === led),
    canBeat: hand.some((c) => beats(c, winner, led, trump)),
    trickTrumped: trump !== null && suitOf(winner) === trump,
    holdsTrump: trump !== null && hand.some((c) => suitOf(c) === trump),
  };
}

/**
 * Returns a reason when the coordinate combination cannot occur in any real
 * position, or null when it is realizable. Each rule mirrors a comment in the
 * header block.
 */
function whyImpossible(c: Coords): string | null {
  if (!c.trumpDefined) {
    if (c.ledIsTrump) return 'no trump defined -> the led suit cannot be trump';
    if (c.trickTrumped) return 'no trump defined -> nobody can have trumped the trick';
    if (c.holdsTrump) return 'no trump defined -> no card in hand can be a trump';
    if (!c.holdsLed && c.canBeat) {
      return 'void in led suit with no trump -> off-suit cards never beat anything';
    }
    return null;
  }
  if (c.ledIsTrump) {
    if (!c.trickTrumped) return 'led suit IS trump -> the winning card is necessarily a trump';
    if (c.holdsLed !== c.holdsTrump) {
      return 'led suit IS trump -> holding the led suit and holding trump coincide';
    }
    if (!c.holdsTrump && c.canBeat) {
      return 'void when trump is led -> holds no trump, and nothing else beats a trump';
    }
    return null;
  }
  if (c.trickTrumped) {
    if (!c.holdsTrump && c.canBeat) {
      return 'trick already trumped -> only a higher trump beats, but hand holds no trump';
    }
    return null;
  }
  if (c.holdsTrump && !c.canBeat) {
    return 'untrumped trick -> any held trump beats the non-trump winner, so canBeat is forced';
  }
  if (!c.holdsTrump && !c.holdsLed && c.canBeat) {
    return 'void in led suit holding no trump -> nothing in hand can beat';
  }
  return null;
}

const ALL_COMBOS: Coords[] = [];
for (const trumpDefined of [false, true]) {
  for (const ledIsTrump of [false, true]) {
    for (const holdsLed of [false, true]) {
      for (const canBeat of [false, true]) {
        for (const trickTrumped of [false, true]) {
          for (const holdsTrump of [false, true]) {
            ALL_COMBOS.push({
              trumpDefined,
              ledIsTrump,
              holdsLed,
              canBeat,
              trickTrumped,
              holdsTrump,
            });
          }
        }
      }
    }
  }
}

// ── Fixture rows ──────────────────────────────────────────────────────────────
// Trump is H wherever defined; the led suit is C except in the trump-led rows.

interface Row {
  name: string;
  hand: Card[];
  plays: TrickPlay[];
  trump: Suit | null;
  expected: Card[];
}

const ROWS: Row[] = [
  // ── T=no: trump undefined (E, X, H forced no) ──
  {
    name: 'no trump / holds led suit / can head -> only the heading led-suit cards',
    hand: ['CK', 'C8', 'SA'],
    plays: trick('C9', 'CJ'),
    trump: null,
    expected: ['CK'],
  },
  {
    name: 'NAMED must-head applies also when the PARTNER is winning (no trump)',
    // Seats 0,1,2 played -> the actor is seat 3, whose partner seat 1 leads the
    // trick with CQ. legalPlays has no partner exception (§5.5: "myös oman
    // parin kortti on ylitettävä"): only CK may be played.
    hand: ['CK', 'C8', 'S6'],
    plays: [tp(0, 'C6'), tp(1, 'CQ'), tp(2, 'C7')],
    trump: null,
    expected: ['CK'],
  },
  {
    name: 'no trump / holds led suit / cannot head -> every led-suit card',
    hand: ['CK', 'C8', 'SA'],
    plays: trick('CA'),
    trump: null,
    expected: ['CK', 'C8'],
  },
  {
    name: 'NAMED void + no trump defined -> whole hand',
    hand: ['SA', 'H10', 'DK'],
    plays: trick('C9', 'CJ'),
    trump: null,
    expected: ['SA', 'H10', 'DK'],
  },

  // ── E=yes: the led suit IS trump (X forced yes, H === L) ──
  {
    name: 'NAMED led suit == trump -> overtrump-within-follow (only the overtrumps)',
    hand: ['HA', 'H7', 'C6'],
    plays: trick('HK', 'H10'),
    trump: 'H',
    expected: ['HA'],
  },
  {
    name: 'led suit == trump / cannot overtrump -> every trump (undertrump within follow)',
    hand: ['HJ', 'H7', 'C6'],
    plays: trick('HA'),
    trump: 'H',
    expected: ['HJ', 'H7'],
  },
  {
    name: 'led suit == trump / void in trump -> whole hand',
    hand: ['SA', 'D10', 'C6'],
    plays: trick('H9'),
    trump: 'H',
    expected: ['SA', 'D10', 'C6'],
  },

  // ── E=no, L=yes, X=no: following an untrumped non-trump lead ──
  {
    name: 'holds led / no trump in hand / can head -> only the heading led-suit cards',
    hand: ['CK', 'C7', 'S9'],
    plays: trick('C9', 'CQ'),
    trump: 'H',
    expected: ['CK'],
  },
  {
    name: 'NAMED must-head applies also when the PARTNER is winning (trump defined)',
    hand: ['CK', 'C8', 'S6'],
    plays: [tp(0, 'C6'), tp(1, 'CQ'), tp(2, 'C7')],
    trump: 'H',
    expected: ['CK'],
  },
  {
    name: 'holds led / no trump in hand / cannot head -> every led-suit card',
    hand: ['CK', 'C7', 'S9'],
    plays: trick('CA'),
    trump: 'H',
    expected: ['CK', 'C7'],
  },
  {
    name: 'holds led + trump / a led-suit card heads -> heading cards only, trump excluded',
    hand: ['CK', 'C7', 'HA'],
    plays: trick('C9', 'CQ'),
    trump: 'H',
    expected: ['CK'],
  },
  {
    name: 'NAMED holds-led-suit-and-higher-trump -> may NOT trump (all led-suit cards)',
    // Whole-hand canBeat is true only via the trump HA; §5.5 pakko 2: while
    // holding the led suit one must follow it and may not play trump, so the
    // unbeatable CA lead makes every club legal and HA illegal.
    hand: ['CK', 'C7', 'HA'],
    plays: trick('CA'),
    trump: 'H',
    expected: ['CK', 'C7'],
  },

  // ── E=no, L=yes, X=yes: following after somebody trumped ──
  {
    name: 'NAMED trick trumped + holds led suit -> any led-suit card legal, nothing else',
    // Even though HA would overtrump H8, holding the led suit forbids trumping.
    hand: ['CK', 'C7', 'HA'],
    plays: trick('C9', 'H8'),
    trump: 'H',
    expected: ['CK', 'C7'],
  },
  {
    name: 'trick trumped + holds led suit + only a lower trump -> any led-suit card',
    hand: ['CK', 'C7', 'H6'],
    plays: trick('C9', 'H8'),
    trump: 'H',
    expected: ['CK', 'C7'],
  },
  {
    name: 'trick trumped + holds led suit + no trump -> any led-suit card',
    hand: ['CK', 'C7', 'S9'],
    plays: trick('C9', 'H8'),
    trump: 'H',
    expected: ['CK', 'C7'],
  },

  // ── E=no, L=no, H=yes: void in the led suit, must trump ──
  {
    name: 'void + untrumped trick -> must trump; every trump beats, so all trumps legal',
    hand: ['HA', 'H6', 'S9'],
    plays: trick('C9', 'CQ'),
    trump: 'H',
    expected: ['HA', 'H6'],
  },
  {
    name: 'VERIFIED void + trick trumped + overtrumps exist -> ONLY the overtrumps',
    hand: ['HA', 'H6', 'S9'],
    plays: trick('C9', 'H8'),
    trump: 'H',
    expected: ['HA'],
  },
  {
    name: 'void + trick trumped + several overtrumps -> exactly the overtrumps, no undertrump',
    hand: ['HA', 'H10', 'H7', 'S6'],
    plays: trick('C9', 'HK'),
    trump: 'H',
    expected: ['HA', 'H10'],
  },
  {
    name: 'void + trick trumped twice -> must overtrump the highest trump',
    hand: ['HA', 'H9', 'S6'],
    plays: trick('C9', 'H8', 'H10'),
    trump: 'H',
    expected: ['HA'],
  },
  {
    name: 'NAMED void + trick trumped + only lower trumps -> forced undertrump (all trumps)',
    hand: ['H7', 'H6', 'S9'],
    plays: trick('C9', 'H8'),
    trump: 'H',
    expected: ['H7', 'H6'],
  },
  {
    name: 'forced undertrump with three lower trumps -> all three legal',
    hand: ['HQ', 'H9', 'H6', 'S6'],
    plays: trick('CA', 'HK'),
    trump: 'H',
    expected: ['HQ', 'H9', 'H6'],
  },

  // ── E=no, L=no, H=no: void in led suit, void in trump ──
  {
    name: 'void in led + no trump in hand + untrumped trick -> whole hand',
    hand: ['SA', 'S6', 'DQ'],
    plays: trick('C9', 'CQ'),
    trump: 'H',
    expected: ['SA', 'S6', 'DQ'],
  },
  {
    name: 'void in led + no trump in hand + trumped trick -> whole hand',
    hand: ['SA', 'S6', 'DQ'],
    plays: trick('C9', 'H8'),
    trump: 'H',
    expected: ['SA', 'S6', 'DQ'],
  },
];

const ROWS_BY_KEY = new Map<string, Row[]>();
for (const row of ROWS) {
  const key = keyOf(coordsOf(row.hand, row.plays, row.trump));
  const bucket = ROWS_BY_KEY.get(key) ?? [];
  bucket.push(row);
  ROWS_BY_KEY.set(key, bucket);
}

// ── The matrix ────────────────────────────────────────────────────────────────

describe('legalPlays case matrix: full 2^6 cross product', () => {
  it('classifies exactly 17 of the 64 combinations as possible', () => {
    const possible = ALL_COMBOS.filter((c) => whyImpossible(c) === null);
    expect(possible).toHaveLength(17);
  });

  it.each(ALL_COMBOS.map((c) => [keyOf(c), c] as const))('%s', (key, combo) => {
    const reason = whyImpossible(combo);
    const rows = ROWS_BY_KEY.get(key) ?? [];
    if (reason !== null) {
      // Impossible combination: it must be skipped for a stated reason, and no
      // fixture may accidentally sit at these coordinates.
      expect(reason.length).toBeGreaterThan(0);
      expect(rows, `no fixture may realize the impossible combo ${key}`).toHaveLength(0);
      return;
    }
    // Possible combination: at least one fixture row covers it.
    expect(rows.length, `possible combo ${key} must have a fixture`).toBeGreaterThan(0);
    for (const row of rows) {
      // Self-check: the fixture really sits at the claimed coordinates.
      expect(coordsOf(row.hand, row.plays, row.trump), row.name).toEqual(combo);
      const legal = legalPlays(row.hand, row.plays, row.trump);
      expect(sorted(legal), row.name).toEqual(sorted(row.expected));
      // Global invariants: subset of hand, never empty for a non-empty hand.
      for (const c of legal) expect(row.hand).toContain(c);
      expect(new Set(legal).size).toBe(legal.length);
      expect(legal.length).toBeGreaterThan(0);
    }
  });

  it('does not mutate its inputs', () => {
    const hand: Card[] = ['CK', 'C7', 'HA'];
    const plays = trick('C9', 'H8');
    legalPlays(hand, plays, 'H');
    expect(hand).toEqual(['CK', 'C7', 'HA']);
    expect(plays).toEqual(trick('C9', 'H8'));
  });
});

describe('legalPlays on an empty trick', () => {
  // The lead is unconstrained; the matrix dimensions except T are undefined
  // here (there is no led suit, no winner, nothing trumped), so these two
  // cases live outside the 2^6 table.
  it('NAMED empty trick -> whole hand (trump defined)', () => {
    const hand: Card[] = ['HA', 'H6', 'CQ', 'S7', 'D10'];
    expect(sorted(legalPlays(hand, [], 'H'))).toEqual(sorted(hand));
  });

  it('NAMED empty trick -> whole hand (no trump)', () => {
    const hand: Card[] = ['HA', 'H6', 'CQ', 'S7', 'D10'];
    expect(sorted(legalPlays(hand, [], null))).toEqual(sorted(hand));
  });

  it('returns the empty set only for an empty hand', () => {
    expect(legalPlays([], [], 'H')).toEqual([]);
    expect(legalPlays([], trick('C9'), null)).toEqual([]);
  });
});

// ── Randomized sweep against an independently formulated oracle ───────────────

/**
 * Independent restatement of §5.5: rank every card into an obligation class
 * and allow exactly the cards of the highest non-empty class.
 *   4 follows the led suit and beats the winner   (maapakko + ylimenopakko)
 *   3 follows the led suit                        (maapakko)
 *   2 is a trump and beats the winner             (valttipakko + ylimenopakko)
 *   1 is a trump                                  (valttipakko)
 *   0 anything else
 */
function oracleLegal(hand: readonly Card[], plays: readonly TrickPlay[], trump: Suit | null) {
  const first = plays[0];
  if (!first) return [...hand];
  const led = suitOf(first.card);
  const winner = winningPlay(plays, trump).card;
  const classOf = (c: Card): number => {
    const follows = suitOf(c) === led;
    const isTrump = trump !== null && suitOf(c) === trump;
    const heads = beats(c, winner, led, trump);
    if (follows) return heads ? 4 : 3;
    if (isTrump) return heads ? 2 : 1;
    return 0;
  };
  const best = Math.max(...hand.map(classOf));
  return hand.filter((c) => classOf(c) === best);
}

/** Deterministic PRNG (mulberry32) — no dependencies, reproducible failures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('legalPlays invariants over random positions (seeded)', () => {
  it('subset of hand, never empty, and equal to the independent oracle', () => {
    const rng = mulberry32(0x5eed);
    const trumps: Array<Suit | null> = [null, 'H', 'D', 'C', 'S'];
    for (let i = 0; i < 5000; i++) {
      const deck = makeDeck();
      for (let j = deck.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        const a = deck[j] as Card;
        deck[j] = deck[k] as Card;
        deck[k] = a;
      }
      const trump = trumps[i % trumps.length] as Suit | null;
      const nPlays = i % 4; // 0..3 cards already on the table
      const plays: TrickPlay[] = deck.slice(0, nPlays).map((card, s) => tp(s as Seat, card));
      const handSize = 1 + Math.floor(rng() * 9);
      const hand = deck.slice(nPlays, nPlays + handSize);

      const legal = legalPlays(hand, plays, trump);
      // subset of hand, no duplicates, never empty for a non-empty hand
      for (const c of legal) expect(hand).toContain(c);
      expect(new Set(legal).size).toBe(legal.length);
      expect(legal.length).toBeGreaterThan(0);
      // exact agreement with the independently formulated pakko oracle
      const label = `seed case ${i}: hand=${hand.join(',')} plays=${plays
        .map((p) => p.card)
        .join(',')} trump=${trump}`;
      expect(sorted(legal), label).toEqual(sorted(oracleLegal(hand, plays, trump)));
    }
  });
});

// ── Integration: the same rules through the full public event/action API ─────
//
// A fully scripted deal built exclusively with nextDealEvent + validateAction +
// applyEvent. At every turn we assert that the playCard hint from
// allowedActions is EXACTLY the expected set, and that validateAction accepts
// precisely the hinted cards and rejects every other card in the hand.

const HAND0: Card[] = ['HJ', 'H9', 'D8', 'CA', 'CJ', 'S6', 'S7', 'SJ', 'SQ'];
const HAND1: Card[] = ['HK', 'HQ', 'H6', 'DA', 'D9', 'D10', 'C6', 'CK', 'CQ'];
const HAND2: Card[] = ['HA', 'D6', 'C10', 'C9', 'S9', 'S8', 'SA', 'SK', 'S10'];
const HAND3: Card[] = ['H10', 'H8', 'H7', 'D7', 'DQ', 'DK', 'DJ', 'C8', 'C7'];
const DECK: Card[] = [...HAND0, ...HAND1, ...HAND2, ...HAND3];

interface Ctx {
  state: MatchState;
}

function act(ctx: Ctx, seat: Seat, action: PlayerAction): GameEvent[] {
  const res = validateAction(ctx.state, seat, action);
  if (isRuleError(res)) {
    throw new Error(`unexpected ${res.code} for seat ${seat} ${JSON.stringify(action)}`);
  }
  for (const e of res) ctx.state = applyEvent(ctx.state, e);
  return res;
}

function expectError(ctx: Ctx, seat: Seat, card: Card, code: string): void {
  const res = validateAction(ctx.state, seat, { type: 'playCard', card });
  expect(isRuleError(res), `expected ${code} for seat ${seat} playing ${card}`).toBe(true);
  if (isRuleError(res)) expect(res.code).toBe(code);
}

/**
 * Asserts the playCard hint equals `expected`, that validateAction accepts
 * exactly those cards (and no other card in the hand), and that the hint
 * agrees with a direct legalPlays call on the same position.
 */
function expectLegalExact(ctx: Ctx, seat: Seat, expected: Card[]): void {
  expect(expectedActor(ctx.state)).toBe(seat);
  const hint = allowedActions(ctx.state, seat).find((h) => h.type === 'playCard');
  if (!hint || hint.type !== 'playCard') throw new Error(`no playCard hint for seat ${seat}`);
  expect(sorted(hint.legal)).toEqual(sorted(expected));

  const deal = ctx.state.deal;
  if (!deal) throw new Error('no deal');
  const plays = deal.phase.name === 'follow' ? deal.phase.plays : [];
  expect(sorted(legalPlays(deal.hands[seat], plays, deal.trump))).toEqual(sorted(expected));

  for (const card of deal.hands[seat]) {
    const res = validateAction(ctx.state, seat, { type: 'playCard', card });
    if (expected.includes(card)) {
      expect(isRuleError(res), `${card} must be accepted for seat ${seat}`).toBe(false);
    } else {
      expect(isRuleError(res), `${card} must be rejected for seat ${seat}`).toBe(true);
    }
  }
}

function playAndExpectWinner(
  ctx: Ctx,
  seat: Seat,
  card: Card,
  won: { winner: Seat; trickIndex: number; canDeclareNext: boolean },
): void {
  const events = act(ctx, seat, { type: 'playCard', card });
  expect(events[1]).toEqual({
    type: 'trickWon',
    seat: won.winner,
    trickIndex: won.trickIndex,
    canDeclareNext: won.canDeclareNext,
  });
}

describe('integration: pakko rules through validateAction/allowedActions', () => {
  it('uses a valid 36-card deck fixture', () => {
    expect(sorted(DECK)).toEqual(sorted(makeDeck()));
  });

  it('enforces the legality matrix across a scripted deal', () => {
    const ctx: Ctx = { state: initialMatchState(DEFAULT_RULES, 0) };
    ctx.state = applyEvent(ctx.state, nextDealEvent(ctx.state, DECK));

    // Bidding: seat 1 (forced opener) takes it at 50; everyone else passes.
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    expect(ctx.state.deal?.declarer).toBe(1);

    // Exchange: partner 3 gives three cards; declarer returns the very same
    // three, restoring the dealt hands exactly.
    act(ctx, 3, { type: 'giveCards', cards: ['D7', 'C8', 'C7'] });
    act(ctx, 1, { type: 'setContract', amount: 50 });
    act(ctx, 1, { type: 'returnCards', cards: ['D7', 'C8', 'C7'] });
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });

    // ── Trick 0 (no trump yet): NAMED empty trick -> whole hand ──
    expectLegalExact(ctx, 1, [...HAND1]);
    act(ctx, 1, { type: 'playCard', card: 'DA' });
    expectError(ctx, 2, 'S9', 'error.mustFollowSuit');
    expectLegalExact(ctx, 2, ['D6']); // must follow with the only diamond
    act(ctx, 2, { type: 'playCard', card: 'D6' });
    expectLegalExact(ctx, 3, ['D7', 'DQ', 'DK', 'DJ']); // DA is unbeatable -> any diamond
    act(ctx, 3, { type: 'playCard', card: 'D7' });
    expectLegalExact(ctx, 0, ['D8']);
    playAndExpectWinner(ctx, 0, 'D8', { winner: 1, trickIndex: 0, canDeclareNext: true });

    // Seat 1 won its own lead -> declares hearts from hand: trump = H.
    act(ctx, 1, { type: 'declareOwn', suit: 'H' });
    expect(ctx.state.deal?.trump).toBe('H');

    // ── Trick 1: NAMED must-head applies also when the partner is winning ──
    expectLegalExact(ctx, 1, ['HK', 'HQ', 'H6', 'D9', 'D10', 'C6', 'CK', 'CQ']);
    act(ctx, 1, { type: 'playCard', card: 'C6' });
    expectLegalExact(ctx, 2, ['C10', 'C9']); // both head C6
    act(ctx, 2, { type: 'playCard', card: 'C10' });
    expectLegalExact(ctx, 3, ['C8', 'C7']); // cannot head C10 -> any club
    act(ctx, 3, { type: 'playCard', card: 'C8' });
    // Seat 0's PARTNER (seat 2) is winning with C10 — seat 0 must still head it,
    // and may not play the trump HJ while holding clubs.
    expectError(ctx, 0, 'CJ', 'error.mustHeadTrick');
    expectError(ctx, 0, 'HJ', 'error.mustFollowSuit');
    expectLegalExact(ctx, 0, ['CA']);
    playAndExpectWinner(ctx, 0, 'CA', { winner: 0, trickIndex: 1, canDeclareNext: false });

    // ── Trick 2: void -> must trump (all trumps beat an untrumped trick);
    //    then NAMED trick trumped + holds led suit -> led-suit cards only,
    //    even while holding the highest trump (holds-led-suit-and-higher-trump).
    expectLegalExact(ctx, 0, ['HJ', 'H9', 'CJ', 'S6', 'S7', 'SJ', 'SQ']); // whole hand on a lead
    act(ctx, 0, { type: 'playCard', card: 'S6' });
    expectError(ctx, 1, 'D10', 'error.mustTrump');
    expectLegalExact(ctx, 1, ['HK', 'HQ', 'H6']); // void in spades, untrumped -> all trumps
    act(ctx, 1, { type: 'playCard', card: 'H6' });
    expectError(ctx, 2, 'HA', 'error.mustFollowSuit'); // may NOT trump holding the led suit
    expectLegalExact(ctx, 2, ['S9', 'S8', 'SA', 'SK', 'S10']);
    act(ctx, 2, { type: 'playCard', card: 'S9' });
    expectLegalExact(ctx, 3, ['H10', 'H8', 'H7']); // all overtrump H6
    playAndExpectWinner(ctx, 3, 'H8', { winner: 3, trickIndex: 2, canDeclareNext: false });

    // ── Trick 3: VERIFIED only-the-overtrumps when an overtrump exists ──
    expectLegalExact(ctx, 3, ['H10', 'H7', 'DQ', 'DK', 'DJ', 'C7']);
    act(ctx, 3, { type: 'playCard', card: 'DQ' });
    expectLegalExact(ctx, 0, ['HJ', 'H9']); // void in diamonds, untrumped -> all trumps
    act(ctx, 0, { type: 'playCard', card: 'H9' });
    expectLegalExact(ctx, 1, ['D9', 'D10']); // trumped + holds led suit -> any diamond
    act(ctx, 1, { type: 'playCard', card: 'D9' });
    expectError(ctx, 2, 'SA', 'error.mustTrump');
    expectLegalExact(ctx, 2, ['HA']); // HA overtrumps H9 -> the overtrump only
    playAndExpectWinner(ctx, 2, 'HA', { winner: 2, trickIndex: 3, canDeclareNext: false });

    // ── Trick 4: NAMED void + trick trumped + only lower trumps -> forced
    //    undertrump: BOTH lower trumps are legal. ──
    expectLegalExact(ctx, 2, ['C9', 'S8', 'SA', 'SK', 'S10']);
    act(ctx, 2, { type: 'playCard', card: 'S8' });
    expectLegalExact(ctx, 3, ['H10', 'H7']); // untrumped -> all trumps
    act(ctx, 3, { type: 'playCard', card: 'H10' });
    expectError(ctx, 0, 'HJ', 'error.mustFollowSuit');
    expectLegalExact(ctx, 0, ['S7', 'SJ', 'SQ']); // trumped + holds led -> any spade
    act(ctx, 0, { type: 'playCard', card: 'S7' });
    expectError(ctx, 1, 'CK', 'error.mustTrump');
    expectLegalExact(ctx, 1, ['HK', 'HQ']); // no overtrump of H10 -> forced undertrump
    playAndExpectWinner(ctx, 1, 'HQ', { winner: 3, trickIndex: 4, canDeclareNext: false });

    // ── Trick 5: NAMED led suit == trump -> overtrump-within-follow; and a
    //    hand void in a trump lead may play anything. ──
    expectLegalExact(ctx, 3, ['H7', 'DK', 'DJ', 'C7']);
    act(ctx, 3, { type: 'playCard', card: 'H7' });
    expectError(ctx, 0, 'CJ', 'error.mustFollowSuit');
    expectLegalExact(ctx, 0, ['HJ']); // must follow trump and overtrump H7
    act(ctx, 0, { type: 'playCard', card: 'HJ' });
    expectError(ctx, 1, 'D10', 'error.mustFollowSuit');
    expectLegalExact(ctx, 1, ['HK']); // must overtrump HJ within the trump suit
    act(ctx, 1, { type: 'playCard', card: 'HK' });
    expectLegalExact(ctx, 2, ['C9', 'SA', 'SK', 'S10']); // NAMED void in a trump lead -> whole hand
    playAndExpectWinner(ctx, 2, 'C9', { winner: 1, trickIndex: 5, canDeclareNext: false });
  });
});
