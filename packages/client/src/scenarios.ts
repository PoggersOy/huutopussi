/**
 * Learning scenarios — the content driving the offline tutorial + puzzle modes
 * (localMatch.ts runs them, LearnGuide narrates them). Each is a crafted 36-card
 * deal on the päämuoto ruleset (DEFAULT_RULES) with the human at seat 0 bidding
 * first (dealer = seat 3 → left-of-dealer is seat 0). Opponents are driven by a
 * deterministic teaching actor (localMatch.ts), so every scenario plays out the
 * same way given the same human choices.
 *
 * Decks are seat-major: seat s holds deck[9s .. 9s+8] (4p, 9 tricks). The hands
 * are hand-authored to make one lesson salient; `deckFromHands` just concatenates
 * them. A test (scenarios.test.ts) asserts every deck is a valid 36-card
 * permutation, so a typo here fails CI rather than dealing a broken deal.
 */
import {
  type Card,
  DEFAULT_RULES,
  type DealResult,
  type RuleConfig,
  type Seat,
  type Side,
} from '@hp/engine';
import type { LearnTopic } from './store';

export interface Scenario {
  id: string;
  kind: 'tutorial' | 'puzzle';
  topic: LearnTopic;
  config: RuleConfig;
  /** 36-card permutation, seat-major (see module doc). */
  deck: Card[];
  firstDealer: Seat;
  /** The seat the human plays (always 0 for now). */
  humanSeat: Seat;
  /**
   * Puzzle success test, evaluated when the deal is scored. Omitted for the
   * tutorial (which is "complete" simply by being played to the end).
   */
  goal?: (result: DealResult, humanSide: Side) => boolean;
}

/** Base ruleset for every scenario: päämuoto, human bids first (dealer = 3). */
const TEACH_CONFIG: RuleConfig = DEFAULT_RULES;
const FIRST_DEALER: Seat = 3;
const HUMAN: Seat = 0;

/** Concatenate four 9-card hands into a seat-major deck. */
function deckFromHands(h0: Card[], h1: Card[], h2: Card[], h3: Card[]): Card[] {
  return [...h0, ...h1, ...h2, ...h3];
}

function base(id: string, kind: Scenario['kind'], topic: LearnTopic, deck: Card[]): Scenario {
  return {
    id,
    kind,
    topic,
    config: TEACH_CONFIG,
    deck,
    firstDealer: FIRST_DEALER,
    humanSeat: HUMAN,
  };
}

// ── Tutorial: one guided full deal touching every phase ──────────────────────
// Human (seat 0) gets a strong hand with a heart marriage (K♥+Q♥) and top cards,
// so bidding → declaring the marriage → winning tricks → scoring all come up.
const TUTORIAL = base(
  'tutorial',
  'tutorial',
  'bidding',
  deckFromHands(
    ['HA', 'H10', 'HK', 'HQ', 'SA', 'DA', 'CA', 'S10', 'D10'],
    ['HJ', 'H9', 'SK', 'SQ', 'DK', 'DQ', 'CK', 'CQ', 'C10'],
    ['H8', 'H7', 'SJ', 'S9', 'DJ', 'D9', 'CJ', 'C9', 'D8'],
    ['H6', 'D7', 'D6', 'C8', 'C7', 'C6', 'S8', 'S7', 'S6'],
  ),
);

// ── Puzzle 1: bidding — win the auction with a strong hand ────────────────────
const P_BIDDING: Scenario = {
  ...base(
    'bidding',
    'puzzle',
    'bidding',
    deckFromHands(
      ['HA', 'H10', 'HK', 'HQ', 'SA', 'DA', 'CA', 'S10', 'D10'],
      ['HJ', 'H9', 'SK', 'SQ', 'DK', 'DQ', 'CK', 'CQ', 'C10'],
      ['H8', 'H7', 'SJ', 'S9', 'DJ', 'D9', 'CJ', 'C9', 'D8'],
      ['H6', 'D7', 'D6', 'C8', 'C7', 'C6', 'S8', 'S7', 'S6'],
    ),
  ),
  // Success: the human's side ends up as the declarer.
  goal: (r, side) => declarerSide(r) === side,
};

// ── Puzzle 2: marriage — declare the K♥+Q♥ marriage during play ───────────────
const P_MARRIAGE: Scenario = {
  ...base(
    'marriage',
    'puzzle',
    'marriage',
    deckFromHands(
      ['HK', 'HQ', 'HA', 'H10', 'SA', 'S10', 'DA', 'CA', 'H9'],
      ['SK', 'SQ', 'DK', 'DQ', 'CK', 'CQ', 'C10', 'D10', 'HJ'],
      ['SJ', 'S9', 'DJ', 'D9', 'CJ', 'C9', 'H8', 'H7', 'D8'],
      ['H6', 'D7', 'D6', 'C8', 'C7', 'C6', 'S8', 'S7', 'S6'],
    ),
  ),
  // Success: the human's side booked marriage points (i.e. declared a marriage).
  goal: (r, side) => (r.sides[side]?.marriagePoints ?? 0) > 0,
};

// ── Puzzle 3: tricks — follow suit + head-trick, win the majority ─────────────
const P_TRICK: Scenario = {
  ...base(
    'trick',
    'puzzle',
    'trick',
    deckFromHands(
      ['HA', 'H10', 'HK', 'SA', 'S10', 'DA', 'D10', 'CA', 'C10'],
      ['HQ', 'HJ', 'SK', 'SQ', 'DK', 'DQ', 'CK', 'CQ', 'H9'],
      ['H8', 'H7', 'SJ', 'S9', 'DJ', 'D9', 'CJ', 'C9', 'D8'],
      ['H6', 'D7', 'D6', 'C8', 'C7', 'C6', 'S8', 'S7', 'S6'],
    ),
  ),
  // Success: the human's side takes the majority of the deal's 9 tricks.
  goal: (r, side) => (r.sides[side]?.tricks ?? 0) >= 5,
};

// ── Puzzle 4: endgame — läpäri (sweep every trick) with a monster hand ────────
// Human holds ALL nine hearts; opponents hold whole other suits, so a heart
// lead can never be followed — leading hearts wins every trick. Declaring the
// K♥+Q♥ marriage sets trump to hearts, guaranteeing the sweep whoever leads.
const P_ENDGAME: Scenario = {
  ...base(
    'endgame',
    'puzzle',
    'endgame',
    deckFromHands(
      ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6'],
      ['DA', 'D10', 'DK', 'DQ', 'DJ', 'D9', 'D8', 'D7', 'D6'],
      ['CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6'],
      ['SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7', 'S6'],
    ),
  ),
  // Success: the human's side took every trick of the deal (läpäri).
  goal: (r, side) => {
    const total = r.sides.reduce((a, s) => a + s.tricks, 0);
    return total > 0 && (r.sides[side]?.tricks ?? 0) === total;
  },
};

export const SCENARIOS: readonly Scenario[] = [TUTORIAL, P_BIDDING, P_MARRIAGE, P_TRICK, P_ENDGAME];

export const PUZZLES: readonly Scenario[] = SCENARIOS.filter((s) => s.kind === 'puzzle');

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * Which side the declarer belongs to (null for a contract-less deal). Two
 * breakdowns ⇒ 4p pairs (side = seat % 2); otherwise each seat is its own side.
 */
function declarerSide(r: DealResult): Side | null {
  if (r.declarer === null) return null;
  return (r.sides.length === 2 ? r.declarer % 2 : r.declarer) as Side;
}
