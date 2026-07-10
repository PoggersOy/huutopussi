/**
 * Illisoft bidding specification suite (docs/illisoft-saannot-spec.md §2, §3,
 * §4, §8, §10; ILLISOFT_RULES).
 *
 * Covers: minBid 60 / step 5 / maxBid 420 with instant auction end at 420,
 * the negative-score bid ban (banned seats skipped entirely in round 1),
 * bidBanReopen (all eligible pass without a bid → biddingReopened for the
 * banned seats clockwise from left of dealer → they bid; all pass again →
 * allPassed), all-banned meaning a normal round 1, pass permanence across the
 * reopen, the contract-less deal after allPassed (lead = left of dealer, no
 * exchange, declarer/bid/contract all null), the fourSixes redeal condition
 * (own hand in 2-3p — dummy/talon cards count only once actually in hand;
 * pair-combined hands in 4p) in both the bidding and exchange windows
 * (redealWindow 'bidAndExchange'), and the 4p contractTiming 'afterExchange'
 * phase order give → return → contract (korotus, "Ohi" = contract stays at
 * the winning bid). Ends with a hint ⇄ validateAction consistency probe.
 */
import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../src/config.js';
import { DEFAULT_RULES, ILLISOFT_RULES } from '../src/config.js';
import { makeDeck } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import type { ActionHint, Card, GameEvent, MatchState, PlayerAction, Seat } from '../src/types.js';
import { isRuleError, SEATS } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';

const RULES_3P: RuleConfig = { ...ILLISOFT_RULES, players: 3 };
const RULES_2P: RuleConfig = { ...ILLISOFT_RULES, players: 2 };

// ── Deck fixtures ────────────────────────────────────────────────────────────

/** 4p, dealer 0. Pair 1+3 holds all four sixes SPLIT 2+2 (H6 D6 | C6 S6):
 *  both seats 1 and 3 are fourSixes-eligible; pair 0+2 holds zero sixes. */
const SP0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'CA'];
const SP1: Card[] = ['H6', 'D6', 'DA', 'D10', 'DK', 'DQ', 'DJ', 'D9', 'D8'];
const SP2: Card[] = ['C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'D7', 'SA'];
const SP3: Card[] = ['C6', 'S6', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7'];
const FOUR_SIXES_SPLIT_DECK: Card[] = [...SP0, ...SP1, ...SP2, ...SP3];

/** 4p: seat 1 holds ALL FOUR sixes; its partner seat 3 holds none (but is
 *  still eligible — the pair's combined hands count). */
const OH0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'CA'];
const OH1: Card[] = ['H6', 'D6', 'C6', 'S6', 'DA', 'D10', 'DK', 'DQ', 'DJ'];
const OH2: Card[] = ['D9', 'D8', 'D7', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8'];
const OH3: Card[] = ['C7', 'SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7'];
const FOUR_SIXES_ONE_HAND_DECK: Card[] = [...OH0, ...OH1, ...OH2, ...OH3];

/** 4p: seat 1 holds THREE sixes, its partner none (pair total 3 → NOT
 *  fourSixes-eligible; would qualify under päämuoto's threeSixes rule).
 *  The fourth six sits with the other pair (seat 0). */
const TH0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'S6'];
const TH1: Card[] = ['H6', 'D6', 'C6', 'DA', 'D10', 'DK', 'DQ', 'DJ', 'D9'];
const TH2: Card[] = ['D8', 'D7', 'CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8'];
const TH3: Card[] = ['C7', 'SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7'];
const THREE_SIXES_4P_DECK: Card[] = [...TH0, ...TH1, ...TH2, ...TH3];

/** 3p (11-card hands, 3-card talon): seat 1 holds three sixes and the talon
 *  holds the fourth (S6) — eligible only AFTER taking the talon. */
const TL0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'DA', 'D10', 'DK'];
const TL1: Card[] = ['H6', 'D6', 'C6', 'DQ', 'DJ', 'D9', 'D8', 'D7', 'CA', 'C10', 'CK'];
const TL2: Card[] = ['CQ', 'CJ', 'C9', 'C8', 'C7', 'SA', 'S10', 'SK', 'SQ', 'SJ', 'S9'];
const TL_TALON: Card[] = ['S6', 'S8', 'S7'];
const TALON_SIX_3P_DECK: Card[] = [...TL0, ...TL1, ...TL2, ...TL_TALON];

/** 2p (11-card hands, dummy, 3-card talon): seat 1 holds three sixes and the
 *  DUMMY holds the fourth (S6) — never eligible (dummy cards do not count). */
const DM0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'DA', 'D10', 'DK'];
const DM1: Card[] = ['H6', 'D6', 'C6', 'DQ', 'DJ', 'D9', 'D8', 'D7', 'CA', 'C10', 'CK'];
const DM_DUMMY: Card[] = ['S6', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'SA', 'S10', 'SK', 'SQ', 'SJ'];
const DM_TALON: Card[] = ['S9', 'S8', 'S7'];
const DUMMY_SIX_2P_DECK: Card[] = [...DM0, ...DM1, ...DM_DUMMY, ...DM_TALON];

// ── Harness ──────────────────────────────────────────────────────────────────

interface Ctx {
  state: MatchState;
  log: GameEvent[];
}

/** Fresh match dealt straight into the bidding phase. */
function freshBidding(
  opts: { scores?: number[]; deck?: Card[]; config?: RuleConfig; dealer?: Seat } = {},
): Ctx {
  const config = opts.config ?? ILLISOFT_RULES;
  const base = initialMatchState(config, opts.dealer ?? 0);
  const ctx: Ctx = { state: { ...base, scores: opts.scores ?? base.scores }, log: [] };
  const e = nextDealEvent(ctx.state, opts.deck ?? makeDeck());
  ctx.state = applyEvent(ctx.state, e);
  ctx.log.push(e);
  return ctx;
}

/** Applies a valid action, asserting purity, and returns the emitted events. */
function act(ctx: Ctx, seat: Seat, action: PlayerAction): GameEvent[] {
  const before = JSON.stringify(ctx.state);
  const res = validateAction(ctx.state, seat, action);
  if (isRuleError(res)) {
    throw new Error(`unexpected RuleError ${res.code} for seat ${seat} ${JSON.stringify(action)}`);
  }
  let next = ctx.state;
  for (const e of res) next = applyEvent(next, e);
  expect(JSON.stringify(ctx.state), 'validateAction/applyEvent must not mutate input').toBe(before);
  ctx.state = next;
  ctx.log.push(...res);
  return res;
}

/** Asserts a rejection with the exact code (and exact params when given). */
function expectError(
  ctx: Ctx,
  seat: Seat,
  action: PlayerAction,
  code: string,
  params?: Record<string, string | number>,
): void {
  const before = JSON.stringify(ctx.state);
  const res = validateAction(ctx.state, seat, action);
  expect(isRuleError(res), `expected ${code} for seat ${seat} ${JSON.stringify(action)}`).toBe(
    true,
  );
  if (isRuleError(res)) {
    expect(res.code).toBe(code);
    if (params !== undefined) expect(res.params).toEqual(params);
  }
  expect(JSON.stringify(ctx.state), 'a rejected action must not mutate state').toBe(before);
}

/** The standard unrestricted illisoft bid hint. */
function openBidHint(over: Partial<Extract<ActionHint, { type: 'bid' }>> = {}): ActionHint {
  return {
    type: 'bid',
    min: 60,
    max: 420,
    step: 5,
    canPass: true,
    canDemandRedeal: false,
    forced: false,
    ...over,
  };
}

// ── Hint/validate consistency probe ──────────────────────────────────────────

/** Probes past ILLISOFT_RULES.maxBid (420) with margin. */
const PROBE_MAX = 450;

type BidHint = Extract<ActionHint, { type: 'bid' }>;

/**
 * Exhaustively asserts that the bid/pass/demandRedeal legality advertised by
 * allowedActions is EXACTLY what validateAction accepts for `seat`: every
 * integer amount 0..PROBE_MAX plus negative/fractional/NaN specials. Redeal
 * acceptance is matched against the bid hint's flag OR (in the illisoft
 * bidAndExchange window) a standalone demandRedeal hint.
 */
function probeBidConsistency(state: MatchState, seat: Seat): void {
  const before = JSON.stringify(state);
  const hints = allowedActions(state, seat);
  const bidHints = hints.filter((h): h is BidHint => h.type === 'bid');
  const hint = bidHints[0];

  if (state.deal?.phase.name === 'bidding') {
    if (expectedActor(state) === seat) {
      expect(bidHints.length, `seat ${seat} must get exactly one bid hint`).toBe(1);
      expect(hints.length).toBe(1);
    } else {
      expect(hints, `non-turn seat ${seat} must get no hints`).toEqual([]);
    }
  }

  const accepts = (a: PlayerAction) => !isRuleError(validateAction(state, seat, a));

  expect(accepts({ type: 'pass' }), `pass acceptance for seat ${seat}`).toBe(
    hint?.canPass ?? false,
  );
  const redealPerHints =
    (hint?.canDemandRedeal ?? false) || hints.some((h) => h.type === 'demandRedeal');
  expect(accepts({ type: 'demandRedeal' }), `redeal acceptance for seat ${seat}`).toBe(
    redealPerHints,
  );

  const mismatches: string[] = [];
  const check = (amount: number): void => {
    const legalPerHint =
      hint !== undefined && amount % hint.step === 0 && amount >= hint.min && amount <= hint.max;
    if (accepts({ type: 'bid', amount }) !== legalPerHint) {
      mismatches.push(`seat ${seat} amount ${amount}: hint says ${legalPerHint}`);
    }
  };
  for (let a = 0; a <= PROBE_MAX; a++) check(a);
  check(-5);
  check(-60);
  check(62.5);
  check(Number.NaN);
  expect(mismatches).toEqual([]);
  expect(JSON.stringify(state), 'probing must not mutate state').toBe(before);
}

function probeAllSeats(state: MatchState): void {
  for (const seat of SEATS) probeBidConsistency(state, seat);
}

// ── Fixture sanity ───────────────────────────────────────────────────────────

describe('deck fixtures', () => {
  it('are valid 36-card permutations', () => {
    const full = makeDeck().sort();
    expect([...FOUR_SIXES_SPLIT_DECK].sort()).toEqual(full);
    expect([...FOUR_SIXES_ONE_HAND_DECK].sort()).toEqual(full);
    expect([...THREE_SIXES_4P_DECK].sort()).toEqual(full);
    expect([...TALON_SIX_3P_DECK].sort()).toEqual(full);
    expect([...DUMMY_SIX_2P_DECK].sort()).toEqual(full);
  });
});

// ── Bid bounds: minBid 60, step 5, maxBid 420 ────────────────────────────────

describe('illisoft bid bounds', () => {
  it('opener may pass (no forced opening) and bids run 60..420 in steps of 5', () => {
    const ctx = freshBidding();
    expect(expectedActor(ctx.state)).toBe(1); // left of dealer 0
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint()]);
    expectError(ctx, 1, { type: 'bid', amount: 55 }, 'error.bidTooLow', { min: 60 });
    expectError(ctx, 1, { type: 'bid', amount: 0 }, 'error.bidTooLow', { min: 60 });
    expectError(ctx, 1, { type: 'bid', amount: 62 }, 'error.bidNotMultiple', { step: 5 });
    expectError(ctx, 1, { type: 'bid', amount: 425 }, 'error.bidTooHigh', { max: 420 });
    expect(act(ctx, 1, { type: 'bid', amount: 60 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 60 },
    ]);
    // each raise must be at least the previous bid + 5
    expect(allowedActions(ctx.state, 2)).toEqual([openBidHint({ min: 65 })]);
    expectError(ctx, 2, { type: 'bid', amount: 60 }, 'error.bidTooLow', { min: 65 });
  });

  it('anyone may pass at any turn; a pass is just a pass', () => {
    const ctx = freshBidding();
    expect(act(ctx, 1, { type: 'pass' })).toEqual([{ type: 'passed', seat: 1 }]);
    expect(expectedActor(ctx.state)).toBe(2);
    act(ctx, 2, { type: 'bid', amount: 60 });
    expect(act(ctx, 3, { type: 'pass' })).toEqual([{ type: 'passed', seat: 3 }]);
    // seat 0's pass is the third around a standing bid: bidding ends
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 2, amount: 60 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(2);
    expect(ctx.state.deal?.bid).toEqual({ seat: 2, amount: 60 });
  });

  it('opening at maxBid 420 ends the auction instantly', () => {
    const ctx = freshBidding();
    expect(act(ctx, 1, { type: 'bid', amount: 420 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 420 },
      { type: 'biddingEnded', declarer: 1, amount: 420 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(1);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 420 });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
  });

  it('raising to 420 ends the auction instantly even with no passes', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 60 });
    expect(act(ctx, 2, { type: 'bid', amount: 420 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 420 },
      { type: 'biddingEnded', declarer: 2, amount: 420 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(2);
  });

  it('only exactly 420 remains once the auction reaches 415', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 415 });
    expect(allowedActions(ctx.state, 2)).toEqual([openBidHint({ min: 420, max: 420 })]);
    expectError(ctx, 2, { type: 'bid', amount: 425 }, 'error.bidTooHigh', { max: 420 });
    expectError(ctx, 2, { type: 'bid', amount: 900 }, 'error.bidTooHigh', { max: 420 });
  });
});

// ── Bid ban: banned seats skipped in round 1 ─────────────────────────────────

describe('bid ban (negative score, bidBanReopen)', () => {
  it('banned seats are skipped in rotation and never get a turn in round 1', () => {
    const ctx = freshBidding({ scores: [0, -5] }); // side 1 (seats 1+3) banned
    // left of dealer (seat 1) is banned: the round opens at seat 2
    expect(expectedActor(ctx.state)).toBe(2);
    expect(allowedActions(ctx.state, 1)).toEqual([]);
    expect(allowedActions(ctx.state, 3)).toEqual([]);
    expectError(ctx, 1, { type: 'bid', amount: 60 }, 'error.notYourTurn');
    expectError(ctx, 1, { type: 'pass' }, 'error.notYourTurn');
    expect(allowedActions(ctx.state, 2)).toEqual([openBidHint()]);
    act(ctx, 2, { type: 'bid', amount: 60 });
    // rotation skips banned seat 3 straight to seat 0
    expect(expectedActor(ctx.state)).toBe(0);
    expectError(ctx, 3, { type: 'bid', amount: 65 }, 'error.notYourTurn');
    // one pass among the two eligible seats ends the auction
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 2, amount: 60 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(2);
  });

  it('bans exactly negative scores: -1 is banned, 0 is not', () => {
    const banned = freshBidding({ scores: [0, -1] });
    expect(expectedActor(banned.state)).toBe(2);

    const free = freshBidding({ scores: [0, 0] });
    expect(expectedActor(free.state)).toBe(1);
    expect(act(free, 1, { type: 'bid', amount: 60 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 60 },
    ]);
  });

  it('when every seat is banned, everyone bids normally from the start', () => {
    const ctx = freshBidding({ scores: [-5, -5] });
    expect(expectedActor(ctx.state)).toBe(1);
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint()]);
    expect(act(ctx, 1, { type: 'bid', amount: 60 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 60 },
    ]);
    expect(expectedActor(ctx.state)).toBe(2);
  });

  it('all-banned all-pass goes straight to allPassed with no reopen', () => {
    const ctx = freshBidding({ scores: [-5, -5] });
    act(ctx, 1, { type: 'pass' });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'allPassed' },
    ]);
  });
});

// ── bidBanReopen: reopened bidding for the banned seats ──────────────────────

describe('bidBanReopen', () => {
  it('all eligible passing without a bid reopens bidding for the banned seats', () => {
    const ctx = freshBidding({ scores: [0, -5] }); // banned: seats 1+3
    act(ctx, 2, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingReopened', seats: [1, 3] },
    ]);
    // reopened round starts clockwise from left of dealer among banned seats
    expect(expectedActor(ctx.state)).toBe(1);
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint()]);
    // the formerly banned seat now bids normally (no error.bidBanned)
    expect(act(ctx, 1, { type: 'bid', amount: 60 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 60 },
    ]);
    // pass permanence across the reopen: seats 2 and 0 stay out
    expect(expectedActor(ctx.state)).toBe(3);
    expect(allowedActions(ctx.state, 2)).toEqual([]);
    expect(allowedActions(ctx.state, 0)).toEqual([]);
    expectError(ctx, 2, { type: 'bid', amount: 65 }, 'error.notYourTurn');
    expectError(ctx, 0, { type: 'pass' }, 'error.notYourTurn');
    // seat 3 may raise the reopened auction
    act(ctx, 3, { type: 'bid', amount: 65 });
    expect(expectedActor(ctx.state)).toBe(1);
    expect(act(ctx, 1, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 1 },
      { type: 'biddingEnded', declarer: 3, amount: 65 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(3);
    expect(ctx.state.deal?.bid).toEqual({ seat: 3, amount: 65 });
    expect(ctx.state.deal?.bidLog).toEqual([
      { seat: 2, kind: 'pass' },
      { seat: 0, kind: 'pass' },
      { seat: 1, kind: 'bid', amount: 60 },
      { seat: 3, kind: 'bid', amount: 65 },
      { seat: 1, kind: 'pass' },
    ]);
  });

  it('everyone passing again after the reopen yields allPassed', () => {
    const ctx = freshBidding({ scores: [0, -5] });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 0, { type: 'pass' }); // biddingReopened [1, 3]
    expect(act(ctx, 1, { type: 'pass' })).toEqual([{ type: 'passed', seat: 1 }]);
    expect(expectedActor(ctx.state)).toBe(3);
    expect(act(ctx, 3, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 3 },
      { type: 'allPassed' },
    ]);
    expect(ctx.state.deal?.declarer).toBeNull();
    expect(ctx.state.deal?.bid).toBeNull();
    expect(ctx.state.deal?.contract).toBeNull();
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });

  it('the reopened round starts clockwise from left of dealer, skipping non-banned seats', () => {
    const ctx = freshBidding({ scores: [-5, 0] }); // banned: seats 0+2
    expect(expectedActor(ctx.state)).toBe(1); // left of dealer is eligible here
    act(ctx, 1, { type: 'pass' });
    expect(act(ctx, 3, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 3 },
      { type: 'biddingReopened', seats: [0, 2] },
    ]);
    // clockwise from seat 1 (left of dealer): 1 is not banned → seat 2 opens
    expect(expectedActor(ctx.state)).toBe(2);
    expect(act(ctx, 2, { type: 'bid', amount: 60 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 60 },
    ]);
    expect(expectedActor(ctx.state)).toBe(0);
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 2, amount: 60 },
    ]);
  });

  it('3p: a lone reopened seat bidding wins the auction instantly (talon follows)', () => {
    const ctx = freshBidding({ config: RULES_3P, scores: [0, -5, 0] }); // seat 1 banned
    expect(ctx.state.scores).toEqual([0, -5, 0]);
    expect(expectedActor(ctx.state)).toBe(2);
    act(ctx, 2, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingReopened', seats: [1] },
    ]);
    expect(expectedActor(ctx.state)).toBe(1);
    // 2-3p: winning the bid immediately takes the talon into hand
    expect(act(ctx, 1, { type: 'bid', amount: 60 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 60 },
      { type: 'biddingEnded', declarer: 1, amount: 60 },
      { type: 'talonTaken', seat: 1 },
    ]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeDiscard' });
    expect(ctx.state.deal?.talonTakenBy).toBe(1);
  });

  it('3p: the lone reopened seat passing yields allPassed', () => {
    const ctx = freshBidding({ config: RULES_3P, scores: [0, -5, 0] });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 0, { type: 'pass' }); // biddingReopened [1]
    expect(act(ctx, 1, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 1 },
      { type: 'allPassed' },
    ]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });
});

// ── allPassed → contract-less deal ───────────────────────────────────────────

describe('contract-less deal (allPassed)', () => {
  it('all four passing skips every exchange phase: left of dealer leads, all nulls', () => {
    const ctx = freshBidding(); // makeDeck: seat 1 holds all diamonds
    act(ctx, 1, { type: 'pass' });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'allPassed' },
    ]);
    expect(ctx.state.deal?.declarer).toBeNull();
    expect(ctx.state.deal?.bid).toBeNull();
    expect(ctx.state.deal?.contract).toBeNull();
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    expect(expectedActor(ctx.state)).toBe(1);
    expect(ctx.state.deal?.bidLog).toEqual([
      { seat: 1, kind: 'pass' },
      { seat: 2, kind: 'pass' },
      { seat: 3, kind: 'pass' },
      { seat: 0, kind: 'pass' },
    ]);
    // no declaration hint (canDeclare=false); aceShow constrains the lead to DA
    expect(allowedActions(ctx.state, 1)).toEqual([{ type: 'playCard', legal: ['DA'] }]);
  });

  it('rejects bidding, exchange and contract actions after allPassed', () => {
    const ctx = freshBidding();
    for (const seat of [1, 2, 3, 0] as const) act(ctx, seat, { type: 'pass' });
    for (const seat of SEATS) {
      expectError(ctx, seat, { type: 'bid', amount: 60 }, 'error.notInPhase');
      expectError(ctx, seat, { type: 'pass' }, 'error.notInPhase');
      expectError(ctx, seat, { type: 'setContract', amount: 60 }, 'error.notInPhase');
      expectError(
        ctx,
        seat,
        { type: 'giveCards', cards: ['DA', 'D10', 'DK', 'DQ'] },
        'error.notInPhase',
      );
      expectError(ctx, seat, { type: 'demandRedeal' }, 'error.notInPhase');
    }
  });

  it('dealer rotation still puts the leader left of the dealer', () => {
    const ctx = freshBidding({ dealer: 2 });
    for (const seat of [3, 0, 1, 2] as const) act(ctx, seat, { type: 'pass' });
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 3, canDeclare: false });
  });
});

// ── Redeal: fourSixes in bidding and exchange windows ────────────────────────

describe('redeal fourSixes', () => {
  it('4p: the pair holding all four sixes split 2+2 makes both partners eligible', () => {
    const ctx = freshBidding({ deck: FOUR_SIXES_SPLIT_DECK });
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint({ canDemandRedeal: true })]);
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealer).toBe(0);
    expect(ctx.state.dealIndex).toBe(0);
    // same dealer redeals; dealIndex does not increment
    expect(nextDealEvent(ctx.state, FOUR_SIXES_SPLIT_DECK)).toEqual({
      type: 'dealStarted',
      dealIndex: 0,
      dealer: 0,
      deck: FOUR_SIXES_SPLIT_DECK,
    });
  });

  it('4p: a seat with no sixes qualifies through its partner holding all four', () => {
    const ctx = freshBidding({ deck: FOUR_SIXES_ONE_HAND_DECK });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    // seat 3 holds zero sixes but its partner (seat 1) holds all four
    expect(allowedActions(ctx.state, 3)).toEqual([openBidHint({ min: 65, canDemandRedeal: true })]);
    expect(act(ctx, 3, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 3 }]);
    expect(ctx.state.deal).toBeNull();
  });

  it('4p: the pair without the sixes is not eligible', () => {
    const ctx = freshBidding({ deck: FOUR_SIXES_SPLIT_DECK });
    act(ctx, 1, { type: 'bid', amount: 60 });
    expect(allowedActions(ctx.state, 2)).toEqual([openBidHint({ min: 65 })]);
    expectError(ctx, 2, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('three own sixes are NOT enough under fourSixes (unlike päämuoto)', () => {
    const illisoft = freshBidding({ deck: THREE_SIXES_4P_DECK });
    expect(allowedActions(illisoft.state, 1)).toEqual([openBidHint()]);
    expectError(illisoft, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');

    // config gate: the same hand qualifies under päämuoto's threeSixes rule
    const paamuoto = freshBidding({ deck: THREE_SIXES_4P_DECK, config: DEFAULT_RULES });
    expect(allowedActions(paamuoto.state, 1)[0]).toMatchObject({ canDemandRedeal: true });
  });

  it('the bidding window closes after the first turn even for a qualifying pair', () => {
    const ctx = freshBidding({ deck: FOUR_SIXES_SPLIT_DECK });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'bid', amount: 65 });
    act(ctx, 0, { type: 'pass' });
    // seat 1's second turn: the pair still holds the sixes but it is too late
    expect(expectedActor(ctx.state)).toBe(1);
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint({ min: 70 })]);
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('4p: the redeal window spans every exchange phase for the acting seat', () => {
    const ctx = freshBidding({ deck: FOUR_SIXES_SPLIT_DECK });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    // exchangeGive: the partner acts and may demand; the declarer may not act
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
    expect(allowedActions(ctx.state, 3)).toEqual([
      { type: 'giveCards', count: 4 },
      { type: 'demandRedeal' },
    ]);
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.notYourTurn');
    act(ctx, 3, { type: 'giveCards', cards: ['S10', 'SK', 'SQ', 'SJ'] });
    // exchangeReturn (afterExchange order): declarer acts, still eligible
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeReturn' });
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'returnCards', count: 4 },
      { type: 'demandRedeal' },
    ]);
    expectError(ctx, 3, { type: 'demandRedeal' }, 'error.notYourTurn');
    act(ctx, 1, { type: 'returnCards', cards: ['S10', 'SK', 'SQ', 'SJ'] });
    // exchangeContract: the raise decision may still be preempted by a redeal
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeContract' });
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'setContract', min: 60, max: 420, step: 5 },
      { type: 'demandRedeal' },
    ]);
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealer).toBe(0);
    expect(ctx.state.dealIndex).toBe(0);
  });

  it('redealWindow firstBidTurn disables the exchange window entirely', () => {
    const config: RuleConfig = { ...ILLISOFT_RULES, redealWindow: 'firstBidTurn' };
    const ctx = freshBidding({ deck: FOUR_SIXES_SPLIT_DECK, config });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
    expect(allowedActions(ctx.state, 3)).toEqual([{ type: 'giveCards', count: 4 }]);
    expectError(ctx, 3, { type: 'demandRedeal' }, 'error.notInPhase');
  });

  it('3p: the talon completing the four sixes opens the exchange-window redeal', () => {
    const ctx = freshBidding({ config: RULES_3P, deck: TALON_SIX_3P_DECK });
    // at the bid turn seat 1 holds only three sixes: not eligible yet
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint()]);
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 60 },
      { type: 'talonTaken', seat: 1 },
    ]);
    // the talon's S6 is now in hand: all four sixes → redeal available
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeDiscard' });
    const hints = allowedActions(ctx.state, 1);
    expect(hints).toHaveLength(2);
    expect(hints[1]).toEqual({ type: 'demandRedeal' });
    const discard = hints[0];
    if (discard?.type !== 'discardCards') throw new Error('expected a discardCards hint');
    expect(discard.count).toBe(3);
    expect([...discard.legal].sort()).toEqual(
      ['H6', 'D6', 'C6', 'DQ', 'DJ', 'D9', 'D8', 'D7', 'CK', 'S6', 'S8', 'S7'].sort(),
    );
    // non-declarers may not demand during the exchange
    expectError(ctx, 2, { type: 'demandRedeal' }, 'error.notYourTurn');
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealer).toBe(0);
    expect(ctx.state.dealIndex).toBe(0);
  });

  it('3p: eligibility persists into exchangeContract while the sixes stay in hand', () => {
    const ctx = freshBidding({ config: RULES_3P, deck: TALON_SIX_3P_DECK });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    act(ctx, 1, { type: 'discardCards', cards: ['S8', 'S7', 'DQ'] });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeContract' });
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'setContract', min: 60, max: 420, step: 5 },
      { type: 'demandRedeal' },
    ]);
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
  });

  it('3p: discarding a six back into the koinipakka forfeits the redeal', () => {
    const ctx = freshBidding({ config: RULES_3P, deck: TALON_SIX_3P_DECK });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    act(ctx, 1, { type: 'discardCards', cards: ['S6', 'S8', 'S7'] });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeContract' });
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'setContract', min: 60, max: 420, step: 5 },
    ]);
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('2p: a six in the dummy hand never counts toward the four', () => {
    const ctx = freshBidding({ config: RULES_2P, deck: DUMMY_SIX_2P_DECK });
    expect(expectedActor(ctx.state)).toBe(1);
    // three sixes in hand, the fourth in the dummy: not eligible at the bid turn
    expect(allowedActions(ctx.state, 1)).toEqual([openBidHint()]);
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
    act(ctx, 1, { type: 'bid', amount: 60 });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 60 },
      { type: 'talonTaken', seat: 1 },
    ]);
    // the talon held no six either: still only three in hand
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeDiscard' });
    expect(allowedActions(ctx.state, 1).some((h) => h.type === 'demandRedeal')).toBe(false);
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });
});

// ── 4p contractTiming afterExchange: give → return → contract ────────────────

describe('4p contractTiming afterExchange (korotus)', () => {
  /** Runs the auction to declarer 1 at 60 (makeDeck hands). */
  function toExchangeGive(): Ctx {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    return ctx;
  }

  it('runs give → return → contract, rejecting out-of-order actions at each step', () => {
    const ctx = toExchangeGive();
    // 1) give: the partner acts; contract and return are premature
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
    expect(expectedActor(ctx.state)).toBe(3);
    expectError(ctx, 1, { type: 'setContract', amount: 60 }, 'error.notInPhase');
    expectError(
      ctx,
      1,
      { type: 'returnCards', cards: ['DA', 'D10', 'DK', 'DQ'] },
      'error.notInPhase',
    );
    expectError(
      ctx,
      1,
      { type: 'giveCards', cards: ['DA', 'D10', 'DK', 'DQ'] },
      'error.notYourTurn',
    );
    expectError(ctx, 3, { type: 'giveCards', cards: ['SA', 'S10', 'SK'] }, 'error.wrongCardCount', {
      expected: 4,
    });
    // aces and tens ARE allowed in the 4p exchange
    expect(act(ctx, 3, { type: 'giveCards', cards: ['SA', 'S10', 'SK', 'SQ'] })).toEqual([
      { type: 'cardsGiven', from: 3, to: 1, cards: ['SA', 'S10', 'SK', 'SQ'] },
    ]);
    // 2) return comes BEFORE the contract (illisoft), not after
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeReturn' });
    expect(expectedActor(ctx.state)).toBe(1);
    expectError(ctx, 1, { type: 'setContract', amount: 60 }, 'error.notInPhase');
    expectError(ctx, 3, { type: 'giveCards', cards: ['SJ', 'S9', 'S8', 'S7'] }, 'error.notInPhase');
    // returned cards may include just-received ones
    expect(act(ctx, 1, { type: 'returnCards', cards: ['SA', 'S10', 'D9', 'D8'] })).toEqual([
      { type: 'cardsReturned', from: 1, to: 3, cards: ['SA', 'S10', 'D9', 'D8'] },
    ]);
    // 3) contract last: only the declarer, bounded [bid, 420]
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeContract' });
    expect(expectedActor(ctx.state)).toBe(1);
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'setContract', min: 60, max: 420, step: 5 },
    ]);
    expectError(ctx, 3, { type: 'setContract', amount: 60 }, 'error.notYourTurn');
    expectError(ctx, 1, { type: 'setContract', amount: 55 }, 'error.contractTooLow', { min: 60 });
    expectError(ctx, 1, { type: 'setContract', amount: 62 }, 'error.contractNotMultiple', {
      step: 5,
    });
    expectError(ctx, 1, { type: 'setContract', amount: 425 }, 'error.contractTooHigh', {
      max: 420,
    });
    // "Ohi": contract = bid means no raise; play starts with the declarer
    expect(act(ctx, 1, { type: 'setContract', amount: 60 })).toEqual([
      { type: 'contractSet', seat: 1, amount: 60 },
    ]);
    expect(ctx.state.deal?.contract).toBe(60);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 60 });
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });

  it('the declarer may raise the contract up to 420 after seeing the full exchange', () => {
    const ctx = toExchangeGive();
    act(ctx, 3, { type: 'giveCards', cards: ['SA', 'S10', 'SK', 'SQ'] });
    act(ctx, 1, { type: 'returnCards', cards: ['SK', 'SQ', 'D9', 'D8'] });
    expect(act(ctx, 1, { type: 'setContract', amount: 420 })).toEqual([
      { type: 'contractSet', seat: 1, amount: 420 },
    ]);
    expect(ctx.state.deal?.contract).toBe(420);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 60 });
  });

  it('a 420 auction leaves 420 as the only legal contract', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 420 }); // instant biddingEnded
    act(ctx, 3, { type: 'giveCards', cards: ['SA', 'S10', 'SK', 'SQ'] });
    act(ctx, 1, { type: 'returnCards', cards: ['DA', 'D10', 'DK', 'DQ'] });
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'setContract', min: 420, max: 420, step: 5 },
    ]);
    expectError(ctx, 1, { type: 'setContract', amount: 415 }, 'error.contractTooLow', {
      min: 420,
    });
    expect(act(ctx, 1, { type: 'setContract', amount: 420 })).toEqual([
      { type: 'contractSet', seat: 1, amount: 420 },
    ]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });
});

// ── Exhaustive hint ⇄ validateAction consistency ─────────────────────────────

describe('allowedActions hints exactly match validateAction', () => {
  it('across a reopened auction (all seats, every amount probed)', () => {
    const ctx = freshBidding({ scores: [0, -5] });
    probeAllSeats(ctx.state);
    const steps: Array<[Seat, PlayerAction]> = [
      [2, { type: 'pass' }],
      [0, { type: 'pass' }], // biddingReopened [1, 3]
      [1, { type: 'bid', amount: 60 }],
      [3, { type: 'bid', amount: 65 }],
      [1, { type: 'pass' }], // biddingEnded → exchangeGive
    ];
    for (const [seat, action] of steps) {
      act(ctx, seat, action);
      probeAllSeats(ctx.state);
    }
    expect(ctx.state.deal?.declarer).toBe(3);
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
  });

  it('across a contract-less all-pass deal into the first lead', () => {
    const ctx = freshBidding();
    probeAllSeats(ctx.state);
    for (const seat of [1, 2, 3, 0] as const) {
      act(ctx, seat, { type: 'pass' });
      probeAllSeats(ctx.state); // final iteration probes the lead phase
    }
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });

  it('with redeal-eligible seats through the full exchange window', () => {
    const ctx = freshBidding({ deck: FOUR_SIXES_SPLIT_DECK });
    probeAllSeats(ctx.state); // seat 1 canDemandRedeal via the pair's sixes
    act(ctx, 1, { type: 'bid', amount: 60 });
    probeAllSeats(ctx.state);
    act(ctx, 2, { type: 'pass' });
    probeAllSeats(ctx.state); // seat 3 eligible via partner
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    probeAllSeats(ctx.state); // exchangeGive: standalone demandRedeal hint
    act(ctx, 3, { type: 'giveCards', cards: ['S10', 'SK', 'SQ', 'SJ'] });
    probeAllSeats(ctx.state); // exchangeReturn
    act(ctx, 1, { type: 'returnCards', cards: ['S10', 'SK', 'SQ', 'SJ'] });
    probeAllSeats(ctx.state); // exchangeContract
  });

  it('in 3p once the talon makes the declarer redeal-eligible', () => {
    const ctx = freshBidding({ config: RULES_3P, deck: TALON_SIX_3P_DECK });
    probeAllSeats(ctx.state);
    act(ctx, 1, { type: 'bid', amount: 60 });
    probeAllSeats(ctx.state);
    act(ctx, 2, { type: 'pass' });
    probeAllSeats(ctx.state);
    act(ctx, 0, { type: 'pass' });
    probeAllSeats(ctx.state); // exchangeDiscard with demandRedeal hint
  });
});
