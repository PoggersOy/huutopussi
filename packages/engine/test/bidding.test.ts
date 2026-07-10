/**
 * Bidding-phase specification suite (rules doc §5.2, §10; plan.md engine design).
 *
 * Covers: forced opening (must open at >= minBid, may not pass, may open higher),
 * raise validation with exact RuleError codes, pass permanence and seat skipping,
 * bidding end after three passes (declarer = last/highest bidder, including the
 * everyone-passes-after-forced-open case), instant end at maxBid, the bid ban
 * (banned forced opener may bid exactly minBid; banned raiser may only pass),
 * redeal demands (first turn only; >=3 sixes or nothing above jack; redeal keeps
 * dealer + dealIndex), wrong-turn/wrong-phase rejections, and an exhaustive
 * probe asserting allowedActions hints exactly match what validateAction accepts.
 */
import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../src/config.js';
import { DEFAULT_RULES, theoreticalMaxPoints } from '../src/config.js';
import { makeDeck } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import type { ActionHint, Card, GameEvent, MatchState, PlayerAction, Seat } from '../src/types.js';
import { isRuleError, partnerOf, SEATS } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';

// ── Deck fixtures (seat s is dealt deck[9s..9s+8]) ───────────────────────────

/** Dealer 0 → opener seat 1. Redeal eligibility per seat:
 *  seat 0: NOT eligible (zero sixes; S10/SK/SQ are above jack)
 *  seat 1: eligible via three sixes (despite holding high hearts)
 *  seat 2: NOT eligible (aces/tens/kings, zero sixes)
 *  seat 3: eligible via nothing-above-jack (SJ is its highest card)      */
const RD0: Card[] = ['H8', 'H7', 'D8', 'D7', 'C8', 'C7', 'S10', 'SK', 'SQ'];
const RD1: Card[] = ['H6', 'D6', 'C6', 'HA', 'H10', 'HK', 'HQ', 'HJ', 'H9'];
const RD2: Card[] = ['DA', 'D10', 'DK', 'DQ', 'CA', 'C10', 'CK', 'CQ', 'SA'];
const RD3: Card[] = ['DJ', 'CJ', 'SJ', 'D9', 'C9', 'S9', 'S8', 'S7', 'S6'];
const REDEAL_DECK: Card[] = [...RD0, ...RD1, ...RD2, ...RD3];

/** Opener seat 1 holds exactly TWO sixes plus high cards → not eligible. */
const TS0: Card[] = ['C6', 'S6', 'CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8'];
const TS1: Card[] = ['H6', 'D6', 'HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8'];
const TS2: Card[] = ['DA', 'D10', 'DK', 'DQ', 'DJ', 'D9', 'D8', 'D7', 'C7'];
const TS3: Card[] = ['SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7', 'H7'];
const TWO_SIXES_DECK: Card[] = [...TS0, ...TS1, ...TS2, ...TS3];

// ── Harness ──────────────────────────────────────────────────────────────────

interface Ctx {
  state: MatchState;
  log: GameEvent[];
}

/** Fresh match dealt straight into the bidding phase. */
function freshBidding(
  opts: { scores?: [number, number]; deck?: Card[]; config?: RuleConfig; dealer?: Seat } = {},
): Ctx {
  const config = opts.config ?? DEFAULT_RULES;
  const base = initialMatchState(config, opts.dealer ?? 0);
  const ctx: Ctx = { state: { ...base, scores: opts.scores ?? [0, 0] }, log: [] };
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

// ── Hint/validate consistency probe ──────────────────────────────────────────

/** Probes past DEFAULT_RULES.maxBid (440) with margin. */
const PROBE_MAX = 470;

type BidHint = Extract<ActionHint, { type: 'bid' }>;

/**
 * Exhaustively asserts that the bid/pass/demandRedeal legality advertised by
 * allowedActions is EXACTLY what validateAction accepts for `seat`: every
 * integer amount 0..PROBE_MAX plus negative/fractional/NaN specials.
 */
function probeBidConsistency(state: MatchState, seat: Seat): void {
  const before = JSON.stringify(state);
  const hints = allowedActions(state, seat);
  const bidHints = hints.filter((h): h is BidHint => h.type === 'bid');
  const hint = bidHints[0];

  if (state.deal?.phase.name === 'bidding') {
    if (expectedActor(state) === seat) {
      // The turn holder gets exactly one hint and it is the bid hint.
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
  expect(accepts({ type: 'demandRedeal' }), `redeal acceptance for seat ${seat}`).toBe(
    hint?.canDemandRedeal ?? false,
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
  check(-50);
  check(52.5);
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
    expect([...REDEAL_DECK].sort()).toEqual(makeDeck().sort());
    expect([...TWO_SIXES_DECK].sort()).toEqual(makeDeck().sort());
  });
});

// ── Forced opening ───────────────────────────────────────────────────────────

describe('forced opening', () => {
  it('forces the opener: pass and malformed/low/high bids rejected with exact errors', () => {
    const ctx = freshBidding();
    expect(expectedActor(ctx.state)).toBe(1); // left of dealer 0
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 440,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);
    expectError(ctx, 1, { type: 'pass' }, 'error.forcedOpening', { min: 50 });
    expectError(ctx, 1, { type: 'bid', amount: 45 }, 'error.bidTooLow', { min: 50 });
    expectError(ctx, 1, { type: 'bid', amount: 0 }, 'error.bidTooLow', { min: 50 });
    expectError(ctx, 1, { type: 'bid', amount: 52 }, 'error.bidNotMultiple', { step: 5 });
    expectError(ctx, 1, { type: 'bid', amount: 445 }, 'error.bidTooHigh', { max: 440 });
    expect(act(ctx, 1, { type: 'bid', amount: 50 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 50 },
    ]);
    // once a bid exists nobody is forced any more
    expect(allowedActions(ctx.state, 2)[0]).toMatchObject({ forced: false, canPass: true });
  });

  it('lets the opener open above minBid; the next raise builds on it', () => {
    const ctx = freshBidding();
    expect(act(ctx, 1, { type: 'bid', amount: 300 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 300 },
    ]);
    expect(allowedActions(ctx.state, 2)).toEqual([
      {
        type: 'bid',
        min: 305,
        max: 440,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    expectError(ctx, 2, { type: 'bid', amount: 300 }, 'error.bidTooLow', { min: 305 });
  });

  it('honours dealer rotation and the firstBidder config', () => {
    const leftOfDealer = freshBidding({ dealer: 2 });
    expect(expectedActor(leftOfDealer.state)).toBe(3);
    expect(allowedActions(leftOfDealer.state, 3)[0]).toMatchObject({ forced: true });

    const dealerOpens = freshBidding({
      dealer: 2,
      config: { ...DEFAULT_RULES, firstBidder: 'dealer' },
    });
    expect(expectedActor(dealerOpens.state)).toBe(2);
    expect(allowedActions(dealerOpens.state, 2)[0]).toMatchObject({ forced: true });
  });
});

// ── Raises ───────────────────────────────────────────────────────────────────

describe('raises', () => {
  it('rejects equal, too-low, non-multiple and too-high raises with exact errors', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    expectError(ctx, 2, { type: 'bid', amount: 50 }, 'error.bidTooLow', { min: 55 });
    expectError(ctx, 2, { type: 'bid', amount: 45 }, 'error.bidTooLow', { min: 55 });
    expectError(ctx, 2, { type: 'bid', amount: 52 }, 'error.bidNotMultiple', { step: 5 });
    expectError(ctx, 2, { type: 'bid', amount: 57 }, 'error.bidNotMultiple', { step: 5 });
    expectError(ctx, 2, { type: 'bid', amount: 445 }, 'error.bidTooHigh', { max: 440 });
    expect(act(ctx, 2, { type: 'bid', amount: 55 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 55 },
    ]);
  });

  it('allows jump raises of several steps', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    expect(act(ctx, 2, { type: 'bid', amount: 200 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 200 },
    ]);
    expect(allowedActions(ctx.state, 3)[0]).toMatchObject({ min: 205 });
  });
});

// ── Pass permanence & bidding end ────────────────────────────────────────────

describe('pass permanence and bidding end', () => {
  it('a passed seat is skipped and may never act again this auction', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    expect(expectedActor(ctx.state)).toBe(3);
    expect(allowedActions(ctx.state, 2)).toEqual([]);
    expectError(ctx, 2, { type: 'pass' }, 'error.notYourTurn');
    expectError(ctx, 2, { type: 'bid', amount: 60 }, 'error.notYourTurn');
    act(ctx, 3, { type: 'bid', amount: 55 });
    act(ctx, 0, { type: 'bid', amount: 60 });
    expect(expectedActor(ctx.state)).toBe(1);
    act(ctx, 1, { type: 'bid', amount: 65 });
    expect(expectedActor(ctx.state)).toBe(3); // skips passed seat 2
    expectError(ctx, 2, { type: 'bid', amount: 70 }, 'error.notYourTurn');
    act(ctx, 3, { type: 'pass' });
    expect(expectedActor(ctx.state)).toBe(0);
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 65 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(1);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 65 });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
    expect(expectedActor(ctx.state)).toBe(partnerOf(1));
    expect(ctx.state.deal?.bidLog).toEqual([
      { seat: 1, kind: 'bid', amount: 50 },
      { seat: 2, kind: 'pass' },
      { seat: 3, kind: 'bid', amount: 55 },
      { seat: 0, kind: 'bid', amount: 60 },
      { seat: 1, kind: 'bid', amount: 65 },
      { seat: 3, kind: 'pass' },
      { seat: 0, kind: 'pass' },
    ]);
  });

  it('everyone passing after the forced opening makes the opener declarer at the opening bid', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 50 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(1);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 50 });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
    expect(expectedActor(ctx.state)).toBe(3); // declarer's partner gives cards
  });

  it('an overbid opener may pass; the third pass crowns the raiser', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'bid', amount: 55 });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    expect(act(ctx, 1, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 1 },
      { type: 'biddingEnded', declarer: 2, amount: 55 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(2);
  });

  it('earlier passes keep counting after a later raise', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'bid', amount: 60 });
    expect(expectedActor(ctx.state)).toBe(1); // seats 2 and 3 stay skipped
    expect(act(ctx, 1, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 1 },
      { type: 'biddingEnded', declarer: 0, amount: 60 },
    ]);
  });
});

// ── maxBid ───────────────────────────────────────────────────────────────────

describe('maxBid', () => {
  it('opening at maxBid ends the auction instantly', () => {
    const ctx = freshBidding();
    expect(act(ctx, 1, { type: 'bid', amount: 440 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 440 },
      { type: 'biddingEnded', declarer: 1, amount: 440 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(1);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 440 });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
  });

  it('raising to maxBid ends the auction instantly even with no passes', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 50 });
    expect(act(ctx, 2, { type: 'bid', amount: 440 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 440 },
      { type: 'biddingEnded', declarer: 2, amount: 440 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(2);
  });

  it('rejects any bid above maxBid mid-auction', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 430 });
    expectError(ctx, 2, { type: 'bid', amount: 445 }, 'error.bidTooHigh', { max: 440 });
    expectError(ctx, 2, { type: 'bid', amount: 900 }, 'error.bidTooHigh', { max: 440 });
    expect(act(ctx, 2, { type: 'bid', amount: 435 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 435 },
    ]);
    // only exactly 440 remains
    expect(allowedActions(ctx.state, 3)).toEqual([
      {
        type: 'bid',
        min: 440,
        max: 440,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
  });

  it('maxBid null caps bids at the theoretical deal maximum with no instant end', () => {
    const config: RuleConfig = { ...DEFAULT_RULES, maxBid: null };
    expect(theoreticalMaxPoints(config)).toBe(410);
    const ctx = freshBidding({ config });
    expectError(ctx, 1, { type: 'bid', amount: 415 }, 'error.bidTooHigh', { max: 410 });
    // bidding the cap does NOT end the auction instantly (no configured maxBid)
    expect(act(ctx, 1, { type: 'bid', amount: 410 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 410 },
    ]);
    expect(ctx.state.deal?.phase.name).toBe('bidding');
    // nobody can raise past the cap: hint signals min > max, pass only
    expect(allowedActions(ctx.state, 2)).toEqual([
      {
        type: 'bid',
        min: 415,
        max: 410,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    expectError(ctx, 2, { type: 'bid', amount: 415 }, 'error.bidTooHigh', { max: 410 });
    expectError(ctx, 2, { type: 'bid', amount: 410 }, 'error.bidTooLow', { min: 415 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 410 },
    ]);
  });

  /**
   * ENGINE BUG (fixed): with DEFAULT_RULES, maxBid (440) exceeds
   * theoreticalMaxPoints (410), and validate.ts used to cap contracts at
   * min(maxBid, theoreticalMax) = 410 while allowing winning bids up to 440.
   * A declarer who won the auction at 415–440 then had NO legal setContract
   * amount (min = winning bid > max = 410) and the deal soft-locked in
   * exchangeContract. Rules doc §5.3 only requires the contract to be a
   * multiple of 5 at least the size of the winning bid, so 440 stands:
   * maxContractOf now tracks maxBidOf. See also test/regressions.test.ts.
   */
  it('a declarer who won at maxBid 440 can set a 440 contract (no soft-lock)', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 440 });
    act(ctx, 3, { type: 'giveCards', cards: ['SA', 'S10', 'SK'] });
    const res = validateAction(ctx.state, 1, { type: 'setContract', amount: 440 });
    expect(isRuleError(res)).toBe(false);
  });
});

// ── Bid ban ──────────────────────────────────────────────────────────────────

describe('bid ban', () => {
  it('a banned forced opener must bid exactly minBid and wins it if all pass', () => {
    const ctx = freshBidding({ scores: [0, -500] }); // side 1 (seats 1+3) banned
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 50,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);
    expectError(ctx, 1, { type: 'pass' }, 'error.forcedOpening', { min: 50 });
    expectError(ctx, 1, { type: 'bid', amount: 55 }, 'error.bidBanned');
    expectError(ctx, 1, { type: 'bid', amount: 100 }, 'error.bidBanned');
    expectError(ctx, 1, { type: 'bid', amount: 45 }, 'error.bidBanned'); // ban precedes range checks
    expect(act(ctx, 1, { type: 'bid', amount: 50 })).toEqual([
      { type: 'bidPlaced', seat: 1, amount: 50 },
    ]);
    act(ctx, 2, { type: 'pass' });
    // the opener's banned partner cannot raise either
    expect(allowedActions(ctx.state, 3)).toEqual([
      {
        type: 'bid',
        min: 55,
        max: 50,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    expectError(ctx, 3, { type: 'bid', amount: 55 }, 'error.bidBanned');
    act(ctx, 3, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 50 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(1);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 50 });
  });

  it('a banned raiser may only pass; every bid is error.bidBanned', () => {
    const ctx = freshBidding({ scores: [-500, 0] }); // side 0 (seats 0+2) banned
    // the unbanned opener is unrestricted
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 440,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);
    act(ctx, 1, { type: 'bid', amount: 50 });
    expect(allowedActions(ctx.state, 2)).toEqual([
      {
        type: 'bid',
        min: 55,
        max: 50,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    expectError(ctx, 2, { type: 'bid', amount: 55 }, 'error.bidBanned');
    expectError(ctx, 2, { type: 'bid', amount: 52 }, 'error.bidBanned'); // ban precedes step check
    expectError(ctx, 2, { type: 'bid', amount: 440 }, 'error.bidBanned');
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'bid', amount: 55 });
    expectError(ctx, 0, { type: 'bid', amount: 60 }, 'error.bidBanned');
    act(ctx, 0, { type: 'pass' });
    expect(act(ctx, 1, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 1 },
      { type: 'biddingEnded', declarer: 3, amount: 55 },
    ]);
  });

  it('applies exactly at the threshold and not one step above it', () => {
    const banned = freshBidding({ scores: [-500, 0] });
    act(banned, 1, { type: 'bid', amount: 50 });
    expectError(banned, 2, { type: 'bid', amount: 55 }, 'error.bidBanned');

    const free = freshBidding({ scores: [-495, 0] });
    act(free, 1, { type: 'bid', amount: 50 });
    expect(act(free, 2, { type: 'bid', amount: 55 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 55 },
    ]);
  });

  it('bidBanThreshold null disables the ban entirely', () => {
    const ctx = freshBidding({
      scores: [-10000, -10000],
      config: { ...DEFAULT_RULES, bidBanThreshold: null },
    });
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({ min: 50, max: 440 });
    act(ctx, 1, { type: 'bid', amount: 50 });
    expect(act(ctx, 2, { type: 'bid', amount: 55 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 55 },
    ]);
  });
});

// ── Redeal demand ────────────────────────────────────────────────────────────

describe('redeal demand', () => {
  it('three sixes qualify; the redeal keeps dealer and dealIndex and reopens the window', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK });
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 440,
        step: 5,
        canPass: false,
        canDemandRedeal: true,
        forced: true,
      },
    ]);
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealer).toBe(0);
    expect(ctx.state.dealIndex).toBe(0);

    // while undealt nothing is legal for anyone
    expect(expectedActor(ctx.state)).toBeNull();
    for (const seat of SEATS) expect(allowedActions(ctx.state, seat)).toEqual([]);
    expectError(ctx, 1, { type: 'bid', amount: 50 }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'pass' }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.notInPhase');

    // a fresh nextDealEvent redeals with the SAME dealer and dealIndex
    const fresh = nextDealEvent(ctx.state, REDEAL_DECK);
    expect(fresh).toEqual({
      type: 'dealStarted',
      dealIndex: 0,
      dealer: 0,
      deck: REDEAL_DECK,
    });
    ctx.state = applyEvent(ctx.state, fresh);
    ctx.log.push(fresh);
    expect(expectedActor(ctx.state)).toBe(1);
    expect(ctx.state.deal?.hands[1]).toEqual(RD1);

    // the first-turn window is fresh again: the same seat may demand again
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({ canDemandRedeal: true });
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealIndex).toBe(0);
  });

  it('a hand with nothing above jack qualifies, also mid-auction on its first turn', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK });
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    expect(allowedActions(ctx.state, 3)[0]).toMatchObject({ canDemandRedeal: true });
    expect(act(ctx, 3, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 3 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealer).toBe(0);
    expect(ctx.state.dealIndex).toBe(0);
  });

  it('non-qualifying hands are rejected with error.redealNotEligible', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK });
    act(ctx, 1, { type: 'bid', amount: 50 });
    // seat 2: aces/tens/kings, zero sixes
    expect(allowedActions(ctx.state, 2)[0]).toMatchObject({ canDemandRedeal: false });
    expectError(ctx, 2, { type: 'demandRedeal' }, 'error.redealNotEligible');
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    // seat 0: jack-low apart from S10/SK/SQ, zero sixes → both routes fail
    expect(allowedActions(ctx.state, 0)[0]).toMatchObject({ canDemandRedeal: false });
    expectError(ctx, 0, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('exactly two sixes plus high cards does not qualify', () => {
    const ctx = freshBidding({ deck: TWO_SIXES_DECK });
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({
      canDemandRedeal: false,
      forced: true,
    });
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('is allowed only on the very first bidding turn', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK });
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'bid', amount: 55 });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    // seat 1's hand still qualifies, but its second turn is too late
    expect(expectedActor(ctx.state)).toBe(1);
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({ canDemandRedeal: false });
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('cannot be demanded out of turn even with a qualifying hand', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK });
    expectError(ctx, 3, { type: 'demandRedeal' }, 'error.notYourTurn');
  });

  it('a banned opener may still demand a qualifying redeal', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK, scores: [0, -500] });
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 50,
        step: 5,
        canPass: false,
        canDemandRedeal: true,
        forced: true,
      },
    ]);
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
  });

  it('is disabled entirely by config.redealRule=false', () => {
    const ctx = freshBidding({
      deck: REDEAL_DECK,
      config: { ...DEFAULT_RULES, redealRule: false },
    });
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({ canDemandRedeal: false });
    expectError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });
});

// ── Wrong turn & wrong phase ─────────────────────────────────────────────────

describe('wrong turn and wrong phase', () => {
  it('rejects every bidding action from non-turn seats before any amount checks', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK }); // seat 3 would qualify for redeal
    for (const seat of [0, 2, 3] as const) {
      expect(allowedActions(ctx.state, seat)).toEqual([]);
      expectError(ctx, seat, { type: 'bid', amount: 50 }, 'error.notYourTurn');
      expectError(ctx, seat, { type: 'bid', amount: 52 }, 'error.notYourTurn');
      expectError(ctx, seat, { type: 'bid', amount: 900 }, 'error.notYourTurn');
      expectError(ctx, seat, { type: 'pass' }, 'error.notYourTurn');
      expectError(ctx, seat, { type: 'demandRedeal' }, 'error.notYourTurn');
    }
  });

  it('rejects non-bidding actions during bidding as error.notInPhase', () => {
    const ctx = freshBidding(); // seat 1 (turn holder) holds all diamonds
    const actions: PlayerAction[] = [
      { type: 'giveCards', cards: ['D6', 'D7', 'D8'] },
      { type: 'setContract', amount: 60 },
      { type: 'returnCards', cards: ['D6', 'D7', 'D8'] },
      { type: 'declareOwn', suit: 'D' },
      { type: 'askWhole' },
      { type: 'askHalf', suit: 'D', rankHeld: 'K' },
      { type: 'answerWhole', suit: 'D' },
      { type: 'playCard', card: 'DA' },
    ];
    for (const action of actions) expectError(ctx, 1, action, 'error.notInPhase');
  });

  it('rejects bidding actions before any deal and after bidding has ended', () => {
    const undealt: Ctx = { state: initialMatchState(DEFAULT_RULES, 0), log: [] };
    expectError(undealt, 1, { type: 'bid', amount: 50 }, 'error.notInPhase');
    expectError(undealt, 1, { type: 'pass' }, 'error.notInPhase');
    expectError(undealt, 1, { type: 'demandRedeal' }, 'error.notInPhase');

    const ended = freshBidding();
    act(ended, 1, { type: 'bid', amount: 440 }); // instant biddingEnded
    for (const seat of SEATS) {
      expectError(ended, seat, { type: 'bid', amount: 100 }, 'error.notInPhase');
      expectError(ended, seat, { type: 'pass' }, 'error.notInPhase');
      expectError(ended, seat, { type: 'demandRedeal' }, 'error.notInPhase');
    }
  });
});

// ── forcedOpening=false fallback ─────────────────────────────────────────────

describe('forcedOpening=false (engine-pinned fallback)', () => {
  it('everyone may pass until the last unpassed seat, who must open', () => {
    const config: RuleConfig = { ...DEFAULT_RULES, forcedOpening: false };
    const ctx = freshBidding({ config });
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 440,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    act(ctx, 1, { type: 'pass' });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    // the deal must get a declarer: the last seat becomes a forced opener
    expect(allowedActions(ctx.state, 0)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 440,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);
    expectError(ctx, 0, { type: 'pass' }, 'error.forcedOpening', { min: 50 });
    expect(act(ctx, 0, { type: 'bid', amount: 50 })).toEqual([
      { type: 'bidPlaced', seat: 0, amount: 50 },
      { type: 'biddingEnded', declarer: 0, amount: 50 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(0);
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
  });

  it('a banned seat forced open by three passes must bid exactly minBid', () => {
    const config: RuleConfig = { ...DEFAULT_RULES, forcedOpening: false };
    const ctx = freshBidding({ config, scores: [-500, -500] });
    // banned non-forced opener: no legal bid at all, pass allowed
    expect(allowedActions(ctx.state, 1)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 45,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    expectError(ctx, 1, { type: 'bid', amount: 50 }, 'error.bidBanned');
    act(ctx, 1, { type: 'pass' });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    expect(allowedActions(ctx.state, 0)).toEqual([
      {
        type: 'bid',
        min: 50,
        max: 50,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);
    expectError(ctx, 0, { type: 'bid', amount: 55 }, 'error.bidBanned');
    expect(act(ctx, 0, { type: 'bid', amount: 50 })).toEqual([
      { type: 'bidPlaced', seat: 0, amount: 50 },
      { type: 'biddingEnded', declarer: 0, amount: 50 },
    ]);
  });
});

// ── Exhaustive hint ⇄ validateAction consistency ─────────────────────────────

describe('allowedActions hints exactly match validateAction', () => {
  it('at every step of a contested auction (all seats, every amount probed)', () => {
    const ctx = freshBidding();
    const steps: Array<[Seat, PlayerAction]> = [
      [1, { type: 'bid', amount: 50 }],
      [2, { type: 'bid', amount: 55 }],
      [3, { type: 'pass' }],
      [0, { type: 'bid', amount: 60 }],
      [1, { type: 'bid', amount: 65 }],
      [2, { type: 'pass' }],
      [0, { type: 'bid', amount: 70 }],
      [1, { type: 'pass' }],
    ];
    probeAllSeats(ctx.state);
    for (const [seat, action] of steps) {
      act(ctx, seat, action);
      probeAllSeats(ctx.state); // also probes the post-biddingEnded exchange state
    }
    expect(ctx.state.deal?.declarer).toBe(0);
    expect(ctx.state.deal?.bid).toEqual({ seat: 0, amount: 70 });
    expect(ctx.state.deal?.phase).toEqual({ name: 'exchangeGive' });
  });

  it('when only the exact maxBid remains biddable', () => {
    const ctx = freshBidding();
    act(ctx, 1, { type: 'bid', amount: 435 });
    expect(allowedActions(ctx.state, 2)).toEqual([
      {
        type: 'bid',
        min: 440,
        max: 440,
        step: 5,
        canPass: true,
        canDemandRedeal: false,
        forced: false,
      },
    ]);
    probeAllSeats(ctx.state);
    expect(act(ctx, 2, { type: 'bid', amount: 440 })).toEqual([
      { type: 'bidPlaced', seat: 2, amount: 440 },
      { type: 'biddingEnded', declarer: 2, amount: 440 },
    ]);
  });

  it('for banned openers and banned raisers', () => {
    const bannedOpenerSide = freshBidding({ scores: [0, -500] });
    probeAllSeats(bannedOpenerSide.state); // banned forced opener (min=max=50)
    act(bannedOpenerSide, 1, { type: 'bid', amount: 50 });
    probeAllSeats(bannedOpenerSide.state); // unbanned raiser seat 2
    act(bannedOpenerSide, 2, { type: 'pass' });
    probeAllSeats(bannedOpenerSide.state); // banned raiser seat 3 (min > max)

    const bannedRaiserSide = freshBidding({ scores: [-500, 0] });
    probeAllSeats(bannedRaiserSide.state); // unbanned forced opener
    act(bannedRaiserSide, 1, { type: 'bid', amount: 50 });
    probeAllSeats(bannedRaiserSide.state); // banned raiser seat 2
  });

  it('for redeal-eligible and ineligible seats', () => {
    const ctx = freshBidding({ deck: REDEAL_DECK });
    probeAllSeats(ctx.state); // opener eligible via three sixes
    act(ctx, 1, { type: 'bid', amount: 50 });
    probeAllSeats(ctx.state); // seat 2 ineligible
    act(ctx, 2, { type: 'pass' });
    probeAllSeats(ctx.state); // seat 3 eligible via nothing-above-jack

    const twoSixes = freshBidding({ deck: TWO_SIXES_DECK });
    probeAllSeats(twoSixes.state); // opener ineligible with two sixes

    const bannedEligible = freshBidding({ deck: REDEAL_DECK, scores: [0, -500] });
    probeAllSeats(bannedEligible.state); // banned + redeal-eligible forced opener
  });

  it('with maxBid=null once raising past the theoretical maximum is impossible', () => {
    const ctx = freshBidding({ config: { ...DEFAULT_RULES, maxBid: null } });
    probeAllSeats(ctx.state);
    act(ctx, 1, { type: 'bid', amount: 410 });
    probeAllSeats(ctx.state); // min 415 > max 410 → pass only, no bid accepted
  });

  it('with forcedOpening=false through an all-pass sequence', () => {
    const ctx = freshBidding({ config: { ...DEFAULT_RULES, forcedOpening: false } });
    probeAllSeats(ctx.state);
    act(ctx, 1, { type: 'pass' });
    probeAllSeats(ctx.state);
    act(ctx, 2, { type: 'pass' });
    probeAllSeats(ctx.state);
    act(ctx, 3, { type: 'pass' });
    probeAllSeats(ctx.state); // last unpassed seat is now forced
  });
});
