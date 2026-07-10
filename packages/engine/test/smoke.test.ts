/**
 * Engine smoke test: one fully scripted deterministic deal driven exclusively
 * through nextDealEvent/validateAction/applyEvent with a hand-constructed deck,
 * plus bid-ban, redeal, whole-ask and scoring edge scenarios.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/config.js';
import { makeDeck, suitOf } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import { scoreDeal } from '../src/scoring.js';
import type {
  Card,
  DealResult,
  DealState,
  GameEvent,
  MatchState,
  PlayerAction,
  Seat,
  Side,
  Suit,
} from '../src/types.js';
import { isRuleError } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';
import { redactEventFor, redactViewFor } from '../src/view.js';

// ── Hand-constructed deck: seat s is dealt DECK[9s..9s+8] ────────────────────

const HAND0: Card[] = ['C9', 'S7', 'D7', 'DQ', 'H9', 'CQ', 'SA', 'HJ', 'H6'];
const HAND1: Card[] = ['C6', 'S10', 'D6', 'DJ', 'HQ', 'H8', 'H7', 'S9', 'S6'];
const HAND2: Card[] = ['CA', 'C10', 'D9', 'DK', 'SK', 'SQ', 'HA', 'H10', 'S8'];
const HAND3: Card[] = ['C7', 'CK', 'DA', 'D10', 'HK', 'D8', 'CJ', 'SJ', 'C8'];
const DECK: Card[] = [...HAND0, ...HAND1, ...HAND2, ...HAND3];

interface Ctx {
  state: MatchState;
  log: GameEvent[];
}

/** Applies a valid action, asserting reducer purity and collecting the log. */
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

function expectRuleError(ctx: Ctx, seat: Seat, action: PlayerAction, code: string): void {
  const res = validateAction(ctx.state, seat, action);
  expect(isRuleError(res), `expected ${code} for seat ${seat} ${JSON.stringify(action)}`).toBe(
    true,
  );
  if (isRuleError(res)) expect(res.code).toBe(code);
}

/** Plays a complete (non-final) trick, asserting exact event sequences. */
function playTrick(
  ctx: Ctx,
  plays: Array<[Seat, Card]>,
  won: { winner: Seat; trickIndex: number; canDeclareNext: boolean },
): void {
  for (const [i, [seat, card]] of plays.entries()) {
    expect(expectedActor(ctx.state)).toBe(seat);
    const events = act(ctx, seat, { type: 'playCard', card });
    if (i < 3) {
      expect(events).toEqual([{ type: 'cardPlayed', seat, card }]);
    } else {
      expect(events).toEqual([
        { type: 'cardPlayed', seat, card },
        {
          type: 'trickWon',
          seat: won.winner,
          trickIndex: won.trickIndex,
          canDeclareNext: won.canDeclareNext,
        },
      ]);
    }
  }
}

function legalOf(ctx: Ctx, seat: Seat): Card[] {
  const hint = allowedActions(ctx.state, seat).find((h) => h.type === 'playCard');
  if (!hint || hint.type !== 'playCard') throw new Error('no playCard hint');
  return hint.legal;
}

const EXPECTED_RESULT: DealResult = {
  declarer: 2,
  contract: 60,
  bid: 55,
  made: true,
  sides: [
    {
      cardPoints: 56,
      lastTrickBonus: 0,
      marriagePoints: 40,
      discardPoints: 0,
      rawTotal: 96,
      roundedTotal: 96,
      tricks: 4,
      porvoo: false,
      scoreDelta: 60,
    },
    {
      cardPoints: 64,
      lastTrickBonus: 10,
      marriagePoints: 100,
      discardPoints: 0,
      rawTotal: 174,
      roundedTotal: 174,
      tricks: 5,
      porvoo: false,
      scoreDelta: 174,
    },
  ],
};

/**
 * Plays the full scripted deal from the given starting scores. Deal outcome:
 * declarer seat 2, contract 60 made exactly (+60 clamped from raw 96) for
 * side 0, raw 174 for side 1.
 */
function playScriptedDeal(initialScores: [number, number], expectWinner: Side | null): Ctx {
  const base = initialMatchState(DEFAULT_RULES, 0);
  const ctx: Ctx = { state: { ...base, scores: initialScores }, log: [] };

  // ── Deal ──
  const dealEvent = nextDealEvent(ctx.state, DECK);
  expect(dealEvent).toEqual({ type: 'dealStarted', dealIndex: 0, dealer: 0, deck: DECK });
  ctx.state = applyEvent(ctx.state, dealEvent);
  ctx.log.push(dealEvent);
  expect(redactEventFor(dealEvent, 2)).toEqual({ ...dealEvent, deck: [] });
  expect(redactEventFor(dealEvent, 'spectator')).toEqual({ ...dealEvent, deck: [] });

  // ── Bidding: forced opening, a raise, three passes ──
  expect(expectedActor(ctx.state)).toBe(1); // left of dealer 0
  expect(allowedActions(ctx.state, 1)).toEqual([
    // seat 1 holds three sixes -> redeal demand available but unused
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
  expect(allowedActions(ctx.state, 2)).toEqual([]);
  expectRuleError(ctx, 2, { type: 'bid', amount: 55 }, 'error.notYourTurn');
  expectRuleError(ctx, 1, { type: 'pass' }, 'error.forcedOpening');
  expectRuleError(ctx, 1, { type: 'bid', amount: 45 }, 'error.bidTooLow');
  expectRuleError(ctx, 1, { type: 'bid', amount: 52 }, 'error.bidNotMultiple');
  expectRuleError(ctx, 1, { type: 'bid', amount: 445 }, 'error.bidTooHigh');
  expect(act(ctx, 1, { type: 'bid', amount: 50 })).toEqual([
    { type: 'bidPlaced', seat: 1, amount: 50 },
  ]);

  expect(allowedActions(ctx.state, 2)).toEqual([
    {
      type: 'bid',
      min: 55,
      max: 440,
      step: 5,
      canPass: true,
      canDemandRedeal: false,
      forced: false,
    },
  ]);
  expectRuleError(ctx, 2, { type: 'bid', amount: 50 }, 'error.bidTooLow');
  expect(act(ctx, 2, { type: 'bid', amount: 55 })).toEqual([
    { type: 'bidPlaced', seat: 2, amount: 55 },
  ]);
  expect(act(ctx, 3, { type: 'pass' })).toEqual([{ type: 'passed', seat: 3 }]);
  expect(act(ctx, 0, { type: 'pass' })).toEqual([{ type: 'passed', seat: 0 }]);
  // seat 1 already took its first bidding turn -> redeal window closed
  expectRuleError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  expect(act(ctx, 1, { type: 'pass' })).toEqual([
    { type: 'passed', seat: 1 },
    { type: 'biddingEnded', declarer: 2, amount: 55 },
  ]);

  // ── Exchange: partner 0 gives 3, declarer 2 contracts and returns 3 ──
  expect(ctx.state.deal?.phase.name).toBe('exchangeGive');
  expect(expectedActor(ctx.state)).toBe(0);
  expect(allowedActions(ctx.state, 0)).toEqual([{ type: 'giveCards', count: 3 }]);
  expect(allowedActions(ctx.state, 3)).toEqual([]);
  expectRuleError(ctx, 2, { type: 'giveCards', cards: ['CA', 'C10', 'D9'] }, 'error.notYourTurn');
  expectRuleError(ctx, 0, { type: 'giveCards', cards: ['SA'] }, 'error.wrongCardCount');
  expectRuleError(ctx, 0, { type: 'giveCards', cards: ['SA', 'HJ', 'C6'] }, 'error.cardNotInHand');
  const given = act(ctx, 0, { type: 'giveCards', cards: ['SA', 'HJ', 'CQ'] });
  expect(given).toEqual([{ type: 'cardsGiven', from: 0, to: 2, cards: ['SA', 'HJ', 'CQ'] }]);
  const givenEvent = given[0];
  if (givenEvent) {
    expect(redactEventFor(givenEvent, 0)).toEqual(givenEvent);
    expect(redactEventFor(givenEvent, 2)).toEqual(givenEvent);
    expect(redactEventFor(givenEvent, 1)).toEqual({ ...givenEvent, cards: [] });
    expect(redactEventFor(givenEvent, 'spectator')).toEqual({ ...givenEvent, cards: [] });
  }

  expect(expectedActor(ctx.state)).toBe(2);
  expect(allowedActions(ctx.state, 2)).toEqual([
    { type: 'setContract', min: 55, max: 440, step: 5 },
  ]);
  expectRuleError(ctx, 0, { type: 'setContract', amount: 60 }, 'error.notYourTurn');
  expectRuleError(ctx, 2, { type: 'setContract', amount: 50 }, 'error.contractTooLow');
  expectRuleError(ctx, 2, { type: 'setContract', amount: 62 }, 'error.contractNotMultiple');
  expectRuleError(ctx, 2, { type: 'setContract', amount: 445 }, 'error.contractTooHigh');
  expect(act(ctx, 2, { type: 'setContract', amount: 60 })).toEqual([
    { type: 'contractSet', seat: 2, amount: 60 },
  ]);

  expect(allowedActions(ctx.state, 2)).toEqual([{ type: 'returnCards', count: 3 }]);
  expectRuleError(
    ctx,
    2,
    { type: 'returnCards', cards: ['D6', 'HA', 'H10'] },
    'error.cardNotInHand',
  );
  expect(act(ctx, 2, { type: 'returnCards', cards: ['HA', 'H10', 'S8'] })).toEqual([
    { type: 'cardsReturned', from: 2, to: 0, cards: ['HA', 'H10', 'S8'] },
  ]);

  // Post-exchange redacted views: own sorted hand, exchange faces only for side 0.
  const view0 = redactViewFor(ctx.state, 0);
  expect(view0.deal?.hand).toEqual(['HA', 'H10', 'H9', 'H6', 'DQ', 'D7', 'C9', 'S8', 'S7']);
  expect(view0.deal?.exchangeSeen).toEqual({
    given: ['SA', 'HJ', 'CQ'],
    returned: ['HA', 'H10', 'S8'],
  });
  expect(redactViewFor(ctx.state, 2).deal?.exchangeSeen).toEqual({
    given: ['SA', 'HJ', 'CQ'],
    returned: ['HA', 'H10', 'S8'],
  });
  expect(redactViewFor(ctx.state, 1).deal?.exchangeSeen).toBeNull();
  const spectatorView = redactViewFor(ctx.state, 'spectator');
  expect(spectatorView.deal?.exchangeSeen).toBeNull();
  expect(spectatorView.deal?.hand).toEqual([]);
  expect(spectatorView.deal?.handCounts).toEqual({ 0: 9, 1: 9, 2: 9, 3: 9 });

  // ── Trick 0: declarer leads, no trump yet, no declaration right ──
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 2, canDeclare: false });
  expectRuleError(ctx, 2, { type: 'declareOwn', suit: 'S' }, 'error.declarationUsed');
  playTrick(
    ctx,
    [
      [2, 'CA'],
      [3, 'C7'],
      [0, 'C9'],
      [1, 'C6'],
    ],
    { winner: 2, trickIndex: 0, canDeclareNext: true },
  );

  // ── Declaration window 1: seat 2 declares spades from hand ──
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 2, canDeclare: true });
  expect(allowedActions(ctx.state, 2)).toEqual([
    {
      type: 'declaration',
      ownSuits: ['S'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'D', rankHeld: 'K' },
        { suit: 'C', rankHeld: 'Q' },
        { suit: 'S', rankHeld: 'K' },
        { suit: 'S', rankHeld: 'Q' },
      ],
    },
    {
      type: 'playCard',
      legal: ['C10', 'D9', 'DK', 'SK', 'SQ', 'SA', 'HJ', 'CQ'],
    },
  ]);
  expectRuleError(ctx, 3, { type: 'declareOwn', suit: 'S' }, 'error.notYourTurn');
  expectRuleError(ctx, 2, { type: 'declareOwn', suit: 'H' }, 'error.noMarriageInHand');
  expectRuleError(ctx, 2, { type: 'askHalf', suit: 'D', rankHeld: 'Q' }, 'error.notHoldingHalf');
  expect(act(ctx, 2, { type: 'declareOwn', suit: 'S' })).toEqual([
    { type: 'declaredOwn', seat: 2, suit: 'S' },
    { type: 'trumpSet', suit: 'S', seat: 2, side: 0, how: 'own', points: 40 },
  ]);
  expect(ctx.state.deal?.trump).toBe('S');
  expect(ctx.state.deal?.declarations).toEqual([
    { suit: 'S', seat: 2, side: 0, how: 'own', trickIndex: 1, points: 40 },
  ]);
  // exactly one attempt per lead opportunity
  expectRuleError(ctx, 2, { type: 'askHalf', suit: 'D', rankHeld: 'K' }, 'error.declarationUsed');

  // ── Trick 1: void -> must trump, must overtrump; no trumping while holding led suit ──
  act(ctx, 2, { type: 'playCard', card: 'C10' });
  expectRuleError(ctx, 3, { type: 'playCard', card: 'SJ' }, 'error.mustFollowSuit');
  expect(legalOf(ctx, 3)).toEqual(['CK', 'CJ', 'C8']); // C10 cannot be beaten
  act(ctx, 3, { type: 'playCard', card: 'CK' });
  expectRuleError(ctx, 0, { type: 'playCard', card: 'H9' }, 'error.mustTrump');
  expect(legalOf(ctx, 0)).toEqual(['S7', 'S8']); // void in clubs -> must trump
  act(ctx, 0, { type: 'playCard', card: 'S7' });
  expectRuleError(ctx, 1, { type: 'playCard', card: 'S6' }, 'error.mustOvertrump');
  expect(legalOf(ctx, 1)).toEqual(['S10', 'S9']);
  const t1End = act(ctx, 1, { type: 'playCard', card: 'S10' });
  expect(t1End[1]).toEqual({ type: 'trickWon', seat: 1, trickIndex: 1, canDeclareNext: false });

  // ── Trick 2: must head within the led suit ──
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  act(ctx, 1, { type: 'playCard', card: 'D6' });
  expect(legalOf(ctx, 2)).toEqual(['D9', 'DK']);
  act(ctx, 2, { type: 'playCard', card: 'D9' });
  expectRuleError(ctx, 3, { type: 'playCard', card: 'D8' }, 'error.mustHeadTrick');
  expect(legalOf(ctx, 3)).toEqual(['DA', 'D10']);
  act(ctx, 3, { type: 'playCard', card: 'DA' });
  expectRuleError(ctx, 0, { type: 'playCard', card: 'C6' }, 'error.cardNotInHand');
  expect(legalOf(ctx, 0)).toEqual(['D7', 'DQ']); // cannot beat DA -> any led-suit card
  const t2End = act(ctx, 0, { type: 'playCard', card: 'D7' });
  expect(t2End[1]).toEqual({ type: 'trickWon', seat: 3, trickIndex: 2, canDeclareNext: false });

  // ── Trick 3: seat 3 wins a trick it led itself -> earns declaration right ──
  playTrick(
    ctx,
    [
      [3, 'D10'],
      [0, 'DQ'],
      [1, 'DJ'],
      [2, 'DK'],
    ],
    { winner: 3, trickIndex: 3, canDeclareNext: true },
  );

  // ── Declaration window 2: mid-deal trump CHANGE via a half-ask ──
  expect(allowedActions(ctx.state, 3)).toEqual([
    {
      type: 'declaration',
      ownSuits: [],
      canAskWhole: true,
      halfAsks: [{ suit: 'H', rankHeld: 'K' }],
    },
    { type: 'playCard', legal: ['HK', 'D8', 'CJ', 'SJ', 'C8'] },
  ]);
  expectRuleError(
    ctx,
    3,
    { type: 'askHalf', suit: 'S', rankHeld: 'K' },
    'error.suitAlreadyDeclared',
  );
  expectRuleError(ctx, 3, { type: 'askHalf', suit: 'H', rankHeld: 'Q' }, 'error.notHoldingHalf');
  expectRuleError(ctx, 3, { type: 'askHalf', suit: 'D', rankHeld: 'K' }, 'error.notHoldingHalf');
  expect(act(ctx, 3, { type: 'askHalf', suit: 'H', rankHeld: 'K' })).toEqual([
    { type: 'askedHalf', seat: 3, suit: 'H', rankHeld: 'K' },
    { type: 'answeredHalf', seat: 1, yes: true },
    { type: 'trumpSet', suit: 'H', seat: 3, side: 1, how: 'halfAsk', points: 100 },
  ]);
  expect(ctx.state.deal?.trump).toBe('H'); // trump changed S -> H
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 3, canDeclare: false });

  // ── Trick 4: forced under-trump ──
  act(ctx, 3, { type: 'playCard', card: 'D8' });
  expectRuleError(ctx, 0, { type: 'playCard', card: 'S8' }, 'error.mustTrump');
  expect(legalOf(ctx, 0)).toEqual(['H9', 'H6', 'HA', 'H10']);
  act(ctx, 0, { type: 'playCard', card: 'H9' });
  expectRuleError(ctx, 1, { type: 'playCard', card: 'H7' }, 'error.mustOvertrump');
  act(ctx, 1, { type: 'playCard', card: 'HQ' });
  expectRuleError(ctx, 2, { type: 'playCard', card: 'SA' }, 'error.mustTrump');
  expect(legalOf(ctx, 2)).toEqual(['HJ']); // cannot overtrump HQ -> forced under-trump
  const t4End = act(ctx, 2, { type: 'playCard', card: 'HJ' });
  expect(t4End[1]).toEqual({ type: 'trickWon', seat: 1, trickIndex: 4, canDeclareNext: false });

  // ── Trick 5 ──
  playTrick(
    ctx,
    [
      [1, 'S9'],
      [2, 'SQ'],
      [3, 'SJ'],
      [0, 'S8'],
    ],
    { winner: 2, trickIndex: 5, canDeclareNext: false },
  );

  // ── Trick 6: holding the led suit forbids trumping even after others trumped ──
  act(ctx, 2, { type: 'playCard', card: 'SA' });
  expectRuleError(ctx, 3, { type: 'playCard', card: 'CJ' }, 'error.mustTrump');
  expect(legalOf(ctx, 3)).toEqual(['HK']);
  act(ctx, 3, { type: 'playCard', card: 'HK' });
  expectRuleError(ctx, 0, { type: 'playCard', card: 'H6' }, 'error.mustOvertrump');
  expect(legalOf(ctx, 0)).toEqual(['HA', 'H10']); // must overtrump partner's HK too
  act(ctx, 0, { type: 'playCard', card: 'H10' });
  expectRuleError(ctx, 1, { type: 'playCard', card: 'H8' }, 'error.mustFollowSuit');
  expect(legalOf(ctx, 1)).toEqual(['S6']);
  const t6End = act(ctx, 1, { type: 'playCard', card: 'S6' });
  expect(t6End[1]).toEqual({ type: 'trickWon', seat: 0, trickIndex: 6, canDeclareNext: false });

  // ── Trick 7: leading trump; off-suit no-trump hand may play anything ──
  act(ctx, 0, { type: 'playCard', card: 'HA' });
  expect(legalOf(ctx, 1)).toEqual(['H8', 'H7']);
  act(ctx, 1, { type: 'playCard', card: 'H7' });
  expect(legalOf(ctx, 2)).toEqual(['SK', 'CQ']); // void in hearts, holds no trump
  act(ctx, 2, { type: 'playCard', card: 'SK' });
  expect(legalOf(ctx, 3)).toEqual(['CJ', 'C8']);
  const t7End = act(ctx, 3, { type: 'playCard', card: 'C8' });
  expect(t7End[1]).toEqual({ type: 'trickWon', seat: 0, trickIndex: 7, canDeclareNext: true });

  // ── Declaration window 3: whole-ask auto-answered null (partner has nothing) ──
  expect(allowedActions(ctx.state, 0)).toEqual([
    { type: 'declaration', ownSuits: [], canAskWhole: true, halfAsks: [] },
    { type: 'playCard', legal: ['H6'] },
  ]);
  expectRuleError(ctx, 0, { type: 'declareOwn', suit: 'S' }, 'error.suitAlreadyDeclared');
  expectRuleError(
    ctx,
    0,
    { type: 'askHalf', suit: 'H', rankHeld: 'Q' },
    'error.suitAlreadyDeclared',
  );
  expectRuleError(ctx, 0, { type: 'askHalf', suit: 'D', rankHeld: 'K' }, 'error.notHoldingHalf');
  expect(act(ctx, 0, { type: 'askWhole' })).toEqual([
    { type: 'askedWhole', seat: 0 },
    { type: 'answeredWhole', seat: 2, suit: null },
  ]);
  expect(ctx.state.deal?.trump).toBe('H'); // unchanged
  expect(ctx.state.deal?.askedWhole).toEqual({ 0: true, 1: false, 2: false, 3: false });
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 0, canDeclare: false });
  expectRuleError(ctx, 0, { type: 'askWhole' }, 'error.declarationUsed');

  // ── Trick 8 (last): trick resolution + dealScored (+ matchEnded) in one chain ──
  act(ctx, 0, { type: 'playCard', card: 'H6' });
  expect(legalOf(ctx, 1)).toEqual(['H8']); // must head the trump lead
  act(ctx, 1, { type: 'playCard', card: 'H8' });
  act(ctx, 2, { type: 'playCard', card: 'CQ' });
  const finalEvents = act(ctx, 3, { type: 'playCard', card: 'CJ' });
  const expectedTail: GameEvent[] = [
    { type: 'cardPlayed', seat: 3, card: 'CJ' },
    { type: 'trickWon', seat: 1, trickIndex: 8, canDeclareNext: false },
    { type: 'dealScored', result: EXPECTED_RESULT },
  ];
  if (expectWinner !== null) {
    expectedTail.push({ type: 'matchEnded', winnerSide: expectWinner });
  }
  expect(finalEvents).toEqual(expectedTail);
  expect(ctx.state.deal?.phase).toEqual({ name: 'scored', result: EXPECTED_RESULT });
  expect(ctx.state.winnerSide).toBe(expectWinner);
  expect(expectedActor(ctx.state)).toBeNull();
  expect(allowedActions(ctx.state, 1)).toEqual([]);
  return ctx;
}

// ── Hand-built states for focused scenarios ──────────────────────────────────

function leadState(opts: {
  hands: Record<Seat, Card[]>;
  leader: Seat;
  declarations?: DealState['declarations'];
  askedWhole?: Partial<Record<Seat, boolean>>;
  trump?: Suit | null;
}): MatchState {
  const deal: DealState = {
    hands: opts.hands,
    captured: { 0: [], 1: [], 2: [], 3: [] },
    tricksWon: { 0: 1, 1: 0, 2: 0, 3: 0 },
    tricksPlayed: 1,
    trump: opts.trump ?? null,
    declarations: opts.declarations ?? [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false, ...opts.askedWhole },
    askedHalf: { 0: false, 1: false, 2: false, 3: false },
    bidLog: [],
    bid: { seat: 2, amount: 55 },
    declarer: 2,
    contract: 60,
    exchange: { given: null, returned: null },
    talon: null,
    talonTakenBy: null,
    dummyHand: null,
    discarded: null,
    lastTrick: null,
    phase: { name: 'lead', leader: opts.leader, canDeclare: true },
  };
  return { ...initialMatchState(DEFAULT_RULES, 0), deal };
}

function scoredDealState(opts: {
  declarer: Seat;
  contract: number;
  captured: Partial<Record<Seat, Card[]>>;
  tricksWon: Partial<Record<Seat, number>>;
  lastWinner: Seat;
}): DealState {
  return {
    hands: { 0: [], 1: [], 2: [], 3: [] },
    captured: { 0: [], 1: [], 2: [], 3: [], ...opts.captured },
    tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0, ...opts.tricksWon },
    tricksPlayed: 9,
    trump: null,
    declarations: [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false },
    askedHalf: { 0: false, 1: false, 2: false, 3: false },
    bidLog: [],
    bid: { seat: opts.declarer, amount: opts.contract },
    declarer: opts.declarer,
    contract: opts.contract,
    exchange: { given: null, returned: null },
    talon: null,
    talonTakenBy: null,
    dummyHand: null,
    discarded: null,
    lastTrick: { plays: [], winner: opts.lastWinner },
    phase: { name: 'lead', leader: opts.lastWinner, canDeclare: false },
  };
}

const REDEAL_DECK: Card[] = [
  // seat 0: nothing above jack
  ...(['HJ', 'H9', 'H8', 'H7', 'H6', 'CJ', 'C9', 'C8', 'C7'] as Card[]),
  // seat 1: three sixes (but also high cards)
  ...(['D6', 'C6', 'S6', 'DA', 'D10', 'DK', 'DQ', 'DJ', 'D9'] as Card[]),
  // seats 2 and 3: unqualified hands
  ...(['HA', 'H10', 'HK', 'HQ', 'D8', 'D7', 'CA', 'C10', 'CK'] as Card[]),
  ...(['CQ', 'SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7'] as Card[]),
];

function freshCtx(scores: [number, number], deck: Card[]): Ctx {
  const ctx: Ctx = { state: { ...initialMatchState(DEFAULT_RULES, 0), scores }, log: [] };
  const e = nextDealEvent(ctx.state, deck);
  ctx.state = applyEvent(ctx.state, e);
  ctx.log.push(e);
  return ctx;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deck fixtures', () => {
  it('are valid 36-card permutations', () => {
    expect([...DECK].sort()).toEqual(makeDeck().sort());
    expect([...REDEAL_DECK].sort()).toEqual(makeDeck().sort());
  });
});

describe('scripted deal', () => {
  it('plays a full deal end to end with exact events and scores', () => {
    const ctx = playScriptedDeal([0, 0], null);
    expect(ctx.state.scores).toEqual([60, 174]);
    expect(ctx.state.deal?.tricksWon).toEqual({ 0: 2, 1: 3, 2: 2, 3: 2 });
    expect(ctx.state.deal?.declarations).toEqual([
      { suit: 'S', seat: 2, side: 0, how: 'own', trickIndex: 1, points: 40 },
      { suit: 'H', seat: 3, side: 1, how: 'halfAsk', trickIndex: 4, points: 100 },
    ]);

    // Replay determinism: reapplying the event log reproduces the final state.
    let replayed = initialMatchState(DEFAULT_RULES, 0);
    for (const e of ctx.log) replayed = applyEvent(replayed, e);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(ctx.state));

    // Next deal rotates the dealer and increments dealIndex.
    const e = nextDealEvent(ctx.state, DECK);
    expect(e).toEqual({ type: 'dealStarted', dealIndex: 1, dealer: 1, deck: DECK });
    const nextState = applyEvent(ctx.state, e);
    expect(nextState.deal?.phase).toEqual({
      name: 'bidding',
      turn: 2,
      highBid: null,
      passed: [],
      firstTurnTaken: [],
      excluded: [],
    });
  });

  it('ends the match when a side crosses winTarget', () => {
    const ctx = playScriptedDeal([0, 400], 1);
    expect(ctx.state.scores).toEqual([60, 574]);
    expect(ctx.state.winnerSide).toBe(1);
    expectRuleError(ctx, 1, { type: 'pass' }, 'error.notInPhase');
    expect(() => nextDealEvent(ctx.state, DECK)).toThrow();
  });

  it('declares the higher side winner when both cross winTarget', () => {
    const ctx = playScriptedDeal([443, 326], 0);
    expect(ctx.state.scores).toEqual([503, 500]);
  });

  it('plays on when both sides reach winTarget with equal scores', () => {
    const ctx = playScriptedDeal([440, 326], null);
    expect(ctx.state.scores).toEqual([500, 500]);
    expect(nextDealEvent(ctx.state, DECK)).toEqual({
      type: 'dealStarted',
      dealIndex: 1,
      dealer: 1,
      deck: DECK,
    });
  });
});

describe('bid ban', () => {
  it('lets a banned side only pass outside the forced opening', () => {
    const ctx = freshCtx([-500, 0], makeDeck());
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

    // seat 2 (side 0, at -500) may not bid at all: hint signals min > max
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
    expectRuleError(ctx, 2, { type: 'bid', amount: 55 }, 'error.bidBanned');
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'bid', amount: 55 });
    expectRuleError(ctx, 0, { type: 'bid', amount: 60 }, 'error.bidBanned');
    act(ctx, 0, { type: 'pass' });
    expect(act(ctx, 1, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 1 },
      { type: 'biddingEnded', declarer: 3, amount: 55 },
    ]);
  });

  it('forces a banned opener to bid exactly minBid, winning it if all pass', () => {
    const ctx = freshCtx([0, -500], makeDeck());
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
    expectRuleError(ctx, 1, { type: 'bid', amount: 55 }, 'error.bidBanned');
    expectRuleError(ctx, 1, { type: 'pass' }, 'error.forcedOpening');
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    expectRuleError(ctx, 3, { type: 'bid', amount: 55 }, 'error.bidBanned');
    act(ctx, 3, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 50 },
    ]);
    expect(ctx.state.deal?.declarer).toBe(1);
    expect(ctx.state.deal?.bid).toEqual({ seat: 1, amount: 50 });
  });
});

describe('redeal demand', () => {
  it('lets a qualifying opener demand a redeal; the fresh deal keeps dealer and index', () => {
    const ctx = freshCtx([0, 0], REDEAL_DECK);
    const hint = allowedActions(ctx.state, 1)[0];
    expect(hint).toEqual({
      type: 'bid',
      min: 50,
      max: 440,
      step: 5,
      canPass: false,
      canDemandRedeal: true,
      forced: true,
    });
    expect(act(ctx, 1, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 1 }]);
    expect(ctx.state.deal).toBeNull();
    expect(ctx.state.dealer).toBe(0);
    expect(ctx.state.dealIndex).toBe(0);

    const fresh = nextDealEvent(ctx.state, makeDeck());
    expect(fresh).toEqual({ type: 'dealStarted', dealIndex: 0, dealer: 0, deck: makeDeck() });
    ctx.state = applyEvent(ctx.state, fresh);
    expect(expectedActor(ctx.state)).toBe(1);
  });

  it('allows demanding only on the first turn and only with a qualifying hand', () => {
    const ctx = freshCtx([0, 0], REDEAL_DECK);
    act(ctx, 1, { type: 'bid', amount: 50 });
    // seat 2 holds aces and only one six -> not eligible
    expectRuleError(ctx, 2, { type: 'demandRedeal' }, 'error.redealNotEligible');
    act(ctx, 2, { type: 'bid', amount: 55 });
    act(ctx, 3, { type: 'pass' });
    // seat 0 (nothing above jack) may demand on its first turn even after bids
    expect(allowedActions(ctx.state, 0)[0]).toMatchObject({ canDemandRedeal: true });
    expect(act(ctx, 0, { type: 'demandRedeal' })).toEqual([{ type: 'redealDemanded', seat: 0 }]);
    expect(ctx.state.deal).toBeNull();

    // Fresh deal, same deck: a second bidding turn closes the window for seat 1.
    ctx.state = applyEvent(ctx.state, nextDealEvent(ctx.state, REDEAL_DECK));
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'bid', amount: 55 });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({ canDemandRedeal: false });
    expectRuleError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });

  it('is disabled entirely when config.redealCondition is null', () => {
    const config = { ...DEFAULT_RULES, redealCondition: null };
    const ctx: Ctx = { state: initialMatchState(config, 0), log: [] };
    ctx.state = applyEvent(ctx.state, nextDealEvent(ctx.state, REDEAL_DECK));
    expect(allowedActions(ctx.state, 1)[0]).toMatchObject({ canDemandRedeal: false });
    expectRuleError(ctx, 1, { type: 'demandRedeal' }, 'error.redealNotEligible');
  });
});

describe('whole-ask answer paths', () => {
  const baseHands: Record<Seat, Card[]> = {
    0: ['S6', 'D6'],
    1: ['C7'],
    2: ['C6'],
    3: ['D7'],
  };

  it('auto-answers null when the partner has no declarable marriage', () => {
    const ctx: Ctx = { state: leadState({ hands: baseHands, leader: 0 }), log: [] };
    expect(act(ctx, 0, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 0 },
      { type: 'answeredWhole', seat: 2, suit: null },
    ]);
    expect(ctx.state.deal?.trump).toBeNull();
    expect(ctx.state.deal?.askedWhole).toEqual({ 0: true, 1: false, 2: false, 3: false });
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 0, canDeclare: false });
  });

  it('auto-answers and sets trump when the partner has exactly one marriage', () => {
    const hands = { ...baseHands, 2: ['DK', 'DQ', 'C6'] as Card[] };
    const ctx: Ctx = { state: leadState({ hands, leader: 0 }), log: [] };
    expect(act(ctx, 0, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 0 },
      { type: 'answeredWhole', seat: 2, suit: 'D' },
      { type: 'trumpSet', suit: 'D', seat: 0, side: 0, how: 'wholeAsk', points: 80 },
    ]);
    expect(ctx.state.deal?.trump).toBe('D');
    expect(ctx.state.deal?.declarations).toEqual([
      { suit: 'D', seat: 0, side: 0, how: 'wholeAsk', trickIndex: 1, points: 80 },
    ]);
  });

  it('lets the partner choose with two declarable marriages', () => {
    const hands = { ...baseHands, 2: ['DK', 'DQ', 'CK', 'CQ'] as Card[] };
    const ctx: Ctx = { state: leadState({ hands, leader: 0 }), log: [] };
    expect(act(ctx, 0, { type: 'askWhole' })).toEqual([{ type: 'askedWhole', seat: 0 }]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'awaitWholeAnswer', leader: 0 });
    expect(expectedActor(ctx.state)).toBe(2);
    expect(allowedActions(ctx.state, 2)).toEqual([{ type: 'answerWhole', suits: ['D', 'C'] }]);
    expectRuleError(ctx, 1, { type: 'answerWhole', suit: 'D' }, 'error.notYourTurn');
    expectRuleError(ctx, 2, { type: 'answerWhole', suit: 'H' }, 'error.noMarriageInHand');
    expectRuleError(ctx, 0, { type: 'playCard', card: 'S6' }, 'error.notInPhase');
    expect(act(ctx, 2, { type: 'answerWhole', suit: 'C' })).toEqual([
      { type: 'answeredWhole', seat: 2, suit: 'C' },
      { type: 'trumpSet', suit: 'C', seat: 0, side: 0, how: 'wholeAsk', points: 60 },
    ]);
    expect(ctx.state.deal?.trump).toBe('C');
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 0, canDeclare: false });
  });

  it('only offers marriages in suits not yet declared', () => {
    const hands = { ...baseHands, 2: ['DK', 'DQ', 'CK', 'CQ'] as Card[] };
    const declarations = [
      { suit: 'D', seat: 1, side: 1, how: 'own', trickIndex: 0, points: 80 },
    ] as DealState['declarations'];
    const ctx: Ctx = { state: leadState({ hands, leader: 0, declarations, trump: 'D' }), log: [] };
    expect(act(ctx, 0, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 0 },
      { type: 'answeredWhole', seat: 2, suit: 'C' },
      { type: 'trumpSet', suit: 'C', seat: 0, side: 0, how: 'wholeAsk', points: 60 },
    ]);
    expect(ctx.state.deal?.trump).toBe('C');
  });

  it('enforces the askedWhole locks but leaves half-asks available', () => {
    const hands = { ...baseHands, 0: ['SK', 'SQ'] as Card[] };
    const locked1 = leadState({ hands, leader: 0, askedWhole: { 2: true } });
    expectRuleError({ state: locked1, log: [] }, 0, { type: 'askWhole' }, 'error.askedWholeLock');

    const locked2 = leadState({ hands, leader: 0, askedWhole: { 0: true } });
    const ctx: Ctx = { state: locked2, log: [] };
    expectRuleError(ctx, 0, { type: 'declareOwn', suit: 'S' }, 'error.askedWholeLock');
    expect(allowedActions(ctx.state, 0)[0]).toMatchObject({ ownSuits: [], canAskWhole: true });
    expect(act(ctx, 0, { type: 'askHalf', suit: 'S', rankHeld: 'K' })).toEqual([
      { type: 'askedHalf', seat: 0, suit: 'S', rankHeld: 'K' },
      { type: 'answeredHalf', seat: 2, yes: false },
    ]);
  });
});

describe('scoring edge cases', () => {
  const allCards = makeDeck();
  const blackCards = allCards.filter((c) => suitOf(c) === 'S' || suitOf(c) === 'C');
  const redCards = allCards.filter((c) => suitOf(c) === 'H' || suitOf(c) === 'D');

  it('Porvoo: a trickless opponent side scores minus the contract', () => {
    const deal = scoredDealState({
      declarer: 2,
      contract: 60,
      captured: { 2: allCards },
      tricksWon: { 2: 9 },
      lastWinner: 2,
    });
    expect(scoreDeal(deal, DEFAULT_RULES)).toEqual({
      declarer: 2,
      contract: 60,
      bid: 60,
      made: true,
      sides: [
        {
          cardPoints: 120,
          lastTrickBonus: 10,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 130,
          roundedTotal: 130,
          tricks: 9,
          porvoo: false,
          scoreDelta: 60,
        },
        {
          cardPoints: 0,
          lastTrickBonus: 0,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 0,
          roundedTotal: 0,
          tricks: 0,
          porvoo: true,
          scoreDelta: -60,
        },
      ],
    });
  });

  it('Porvoo: a trickless declarer side scores minus twice the contract', () => {
    const deal = scoredDealState({
      declarer: 2,
      contract: 60,
      captured: { 1: allCards },
      tricksWon: { 1: 9 },
      lastWinner: 1,
    });
    const result = scoreDeal(deal, DEFAULT_RULES);
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
      scoreDelta: -120,
    });
    expect(result.sides[1]?.scoreDelta).toBe(130);
  });

  it('a failed contract costs the declarer side the full contract', () => {
    const deal = scoredDealState({
      declarer: 0,
      contract: 200,
      captured: { 0: blackCards, 1: redCards },
      tricksWon: { 0: 4, 1: 5 },
      lastWinner: 1,
    });
    const result = scoreDeal(deal, DEFAULT_RULES);
    expect(result.made).toBe(false);
    expect(result.sides[0]).toEqual({
      cardPoints: 60,
      lastTrickBonus: 0,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 60,
      roundedTotal: 60,
      tricks: 4,
      porvoo: false,
      scoreDelta: -200,
    });
    expect(result.sides[1]).toEqual({
      cardPoints: 60,
      lastTrickBonus: 10,
      marriagePoints: 0,
      discardPoints: 0,
      rawTotal: 70,
      roundedTotal: 70,
      tricks: 5,
      porvoo: false,
      scoreDelta: 70,
    });
  });
});
