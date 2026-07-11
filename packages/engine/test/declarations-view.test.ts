/**
 * Declarations + view/redaction suite (rules doc §5.4, plan.md engine design).
 *
 * (A) Declarations: one suit per deal, declareOwn K+Q requirement, immediate
 *     trump switching, canDeclare gating (self-led win by default,
 *     declareRight='anyWonTrick' relaxation), exactly one attempt per lead
 *     opportunity, whole-ask auto-answer/choice/lock semantics, half-ask
 *     hold-the-half requirement, and window absence before trick 1 / on the
 *     last trick / after the deal.
 * (B) View/redaction: no serialized view ever contains a card from another
 *     seat's hand (exchange faces excepted for the exchanging side, which is
 *     privy by design), exchangeSeen visibility, spectator hands, event
 *     redaction, and count consistency.
 *
 * All states are built through the public API: initialMatchState +
 * nextDealEvent/validateAction/applyEvent chains over hand-crafted decks.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type RuleConfig } from '../src/config.js';
import { makeDeck, sortHand } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import type { Card, GameEvent, MatchState, PlayerAction, Seat } from '../src/types.js';
import { isRuleError, partnerOf, SEATS } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';
import { redactEventFor, redactViewFor } from '../src/view.js';

// ── Test harness ──────────────────────────────────────────────────────────────

type Viewer = Seat | 'spectator';
const VIEWERS: readonly Viewer[] = [0, 1, 2, 3, 'spectator'];

interface Ctx {
  state: MatchState;
  /** Every event applied, in order. */
  log: GameEvent[];
  /** State snapshot after every applied event (plus the initial state). */
  snapshots: MatchState[];
}

function apply(ctx: Ctx, event: GameEvent): void {
  ctx.state = applyEvent(ctx.state, event);
  ctx.log.push(event);
  ctx.snapshots.push(ctx.state);
}

/** Validates and applies an action that must be legal; returns its events. */
function act(ctx: Ctx, seat: Seat, action: PlayerAction): GameEvent[] {
  const res = validateAction(ctx.state, seat, action);
  if (isRuleError(res)) {
    throw new Error(`unexpected RuleError ${res.code} for seat ${seat} ${JSON.stringify(action)}`);
  }
  for (const e of res) apply(ctx, e);
  return res;
}

/** Asserts the action is rejected with exactly `code` (and changes nothing). */
function expectError(ctx: Ctx, seat: Seat, action: PlayerAction, code: string): void {
  const before = JSON.stringify(ctx.state);
  const res = validateAction(ctx.state, seat, action);
  expect(
    isRuleError(res),
    `expected ${code} for seat ${seat} ${JSON.stringify(action)}, got events`,
  ).toBe(true);
  if (isRuleError(res)) expect(res.code).toBe(code);
  expect(JSON.stringify(ctx.state), 'a rejected action must not mutate state').toBe(before);
}

type Hands = Record<Seat, Card[]>;

/** Deck laid out so seat s is dealt hands[s] (deck[9s..9s+8]). */
function deckOf(hands: Hands): Card[] {
  const deck = [...hands[0], ...hands[1], ...hands[2], ...hands[3]];
  expect([...deck].sort(), 'fixture must be a full 36-card permutation').toEqual(makeDeck().sort());
  return deck;
}

/**
 * Starts a deal (dealer 0), makes seat 1 declarer at bid/contract 50, and runs
 * the exchange: seat 3 gives `give` and the declarer returns the SAME cards,
 * so every hand is exactly as dealt when trick 0 is led by seat 1.
 */
function setupDeal(hands: Hands, give: Card[], config: RuleConfig = DEFAULT_RULES): Ctx {
  const ctx: Ctx = { state: initialMatchState(config, 0), log: [], snapshots: [] };
  ctx.snapshots.push(ctx.state);
  apply(ctx, nextDealEvent(ctx.state, deckOf(hands)));

  act(ctx, 1, { type: 'bid', amount: 50 }); // forced opening (left of dealer 0)
  act(ctx, 2, { type: 'pass' });
  act(ctx, 3, { type: 'pass' });
  act(ctx, 0, { type: 'pass' });
  expect(ctx.state.deal?.declarer).toBe(1);

  act(ctx, 3, { type: 'giveCards', cards: give });
  act(ctx, 1, { type: 'setContract', amount: 50 });
  act(ctx, 1, { type: 'returnCards', cards: give });
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  return ctx;
}

/** Plays a full trick (plays given in seating order from the leader). */
function playTrick(
  ctx: Ctx,
  plays: Array<[Seat, Card]>,
  won: { winner: Seat; trickIndex: number; canDeclareNext: boolean },
): void {
  for (const [i, [seat, card]] of plays.entries()) {
    expect(expectedActor(ctx.state)).toBe(seat);
    const events = act(ctx, seat, { type: 'playCard', card });
    expect(events[0]).toEqual({ type: 'cardPlayed', seat, card });
    if (i === 3) {
      expect(events[1]).toEqual({
        type: 'trickWon',
        seat: won.winner,
        trickIndex: won.trickIndex,
        canDeclareNext: won.canDeclareNext,
      });
    }
  }
}

function declarationHintOf(ctx: Ctx, seat: Seat) {
  return allowedActions(ctx.state, seat).find((h) => h.type === 'declaration');
}

// ── Deck fixtures ─────────────────────────────────────────────────────────────
// In every fixture seat 1 becomes declarer and wins trick 0 by leading CA
// (the other seats hold only losing clubs), opening a declaration window.

/**
 * WHOLE lifecycle deck: seat 1 holds the ♥ marriage; partner seat 3 holds the
 * ♦ AND ♣ marriages (whole-ask choice phase) plus enough trump control to win
 * self-led tricks of its own.
 */
const WHOLE_HANDS: Hands = {
  0: ['HA', 'H10', 'H8', 'D10', 'C8', 'C9', 'S8', 'SK', 'SQ'],
  1: ['CA', 'C10', 'HK', 'HQ', 'S6', 'H6', 'C6', 'D6', 'DJ'],
  2: ['SA', 'S10', 'SJ', 'S9', 'H9', 'HJ', 'D8', 'D9', 'CJ'],
  3: ['DA', 'DK', 'DQ', 'CK', 'CQ', 'D7', 'C7', 'S7', 'H7'],
};
const WHOLE_GIVE: Card[] = ['S7', 'H7', 'C7'];

/**
 * TRUMP_SWITCH deck: seat 1 holds BOTH the ♠ and ♥ marriages and two sure
 * winners (CA, DA) for back-to-back self-led windows; seat 0 is void in
 * spades so a forced heart trump can beat the SA after the ♠→♥ switch.
 */
const SWITCH_HANDS: Hands = {
  0: ['CQ', 'C8', 'C9', 'DQ', 'D8', 'D9', 'HA', 'HJ', 'H7'],
  1: ['CA', 'DA', 'HK', 'HQ', 'SK', 'SQ', 'C6', 'D6', 'H6'],
  2: ['C10', 'CJ', 'D10', 'DJ', 'H9', 'H8', 'S9', 'S8', 'SJ'],
  3: ['CK', 'C7', 'DK', 'D7', 'H10', 'S10', 'S7', 'SA', 'S6'],
};
const SWITCH_GIVE: Card[] = ['C7', 'D7', 'S7'];

/**
 * ANYWON deck: seat 0 (an opponent) holds the ♦ marriage and the top hearts,
 * so it wins seat 1's heart lead at trick 1 — a won-but-not-self-led trick.
 * Partner seat 3 holds exactly one marriage (♣) for the auto-answer path.
 */
const ANYWON_HANDS: Hands = {
  0: ['HA', 'H10', 'H8', 'DK', 'DQ', 'C8', 'C9', 'S8', 'S9'],
  1: ['CA', 'C10', 'HK', 'HQ', 'SK', 'SQ', 'S6', 'H6', 'C6'],
  2: ['SA', 'S10', 'SJ', 'H9', 'HJ', 'D8', 'D9', 'DJ', 'CJ'],
  3: ['DA', 'D10', 'D6', 'D7', 'CK', 'CQ', 'C7', 'S7', 'H7'],
};
const ANYWON_GIVE: Card[] = ['C7', 'S7', 'H7'];

/**
 * HALF deck: seat 1 holds the ♥ marriage plus lone halves CK (complement CQ
 * at an OPPONENT → truthful 'no') and DK (complement DQ at the partner →
 * truthful 'yes'); partner seat 3 holds no declarable marriage at all.
 */
const HALF_HANDS: Hands = {
  0: ['HA', 'H10', 'H8', 'D10', 'C8', 'C9', 'S8', 'SK', 'SQ'],
  1: ['CA', 'C10', 'CK', 'DK', 'HK', 'HQ', 'H6', 'S6', 'C6'],
  2: ['CQ', 'CJ', 'H9', 'HJ', 'D8', 'D9', 'DJ', 'SJ', 'S9'],
  3: ['DA', 'DQ', 'D7', 'D6', 'C7', 'S7', 'H7', 'S10', 'SA'],
};
const HALF_GIVE: Card[] = ['C7', 'S7', 'H7'];

/**
 * CHOICE2 deck: seat 1 holds the ♥ marriage and three sure winners (CA, DA,
 * SA) for three consecutive self-led windows; partner seat 3 holds the ♦ and
 * ♣ marriages, so a whole-ask hits the choice phase and a re-ask after ♦ is
 * declared auto-answers the single remaining ♣.
 */
const CHOICE2_HANDS: Hands = {
  0: ['C8', 'C9', 'D8', 'D9', 'HA', 'H10', 'S10', 'SK', 'SQ'],
  1: ['CA', 'DA', 'SA', 'HK', 'HQ', 'H6', 'C6', 'D6', 'S6'],
  2: ['C10', 'CJ', 'D10', 'DJ', 'H9', 'HJ', 'S9', 'SJ', 'S8'],
  3: ['DK', 'DQ', 'CK', 'CQ', 'C7', 'D7', 'S7', 'H7', 'H8'],
};
const CHOICE2_GIVE: Card[] = ['C7', 'D7', 'S7'];

/** Seat 1 wins trick 0 with CA in every fixture above. */
function winTrick0(ctx: Ctx, follows: [Card, Card, Card]): void {
  playTrick(
    ctx,
    [
      [1, 'CA'],
      [2, follows[0]],
      [3, follows[1]],
      [0, follows[2]],
    ],
    { winner: 1, trickIndex: 0, canDeclareNext: true },
  );
  expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: true });
}

// ── (A) Declarations ─────────────────────────────────────────────────────────

describe('declaration windows (canDeclare gating)', () => {
  it('gives no declaration right at the first lead of the deal (before trick 1)', () => {
    const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE);
    // Seat 1 holds HK+HQ, yet the deal's very first lead has no window.
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.declarationUsed');
    expectError(ctx, 1, { type: 'askWhole' }, 'error.declarationUsed');
    expectError(ctx, 1, { type: 'askHalf', suit: 'H', rankHeld: 'K' }, 'error.declarationUsed');
    // Non-leaders are turned away before any declaration logic runs.
    expectError(ctx, 3, { type: 'declareOwn', suit: 'D' }, 'error.notYourTurn');
    // No declaration hint is offered — only the lead itself.
    expect(allowedActions(ctx.state, 1)).toEqual([{ type: 'playCard', legal: WHOLE_HANDS[1] }]);
  });

  it('rejects declarations in bidding and exchange phases with error.notInPhase', () => {
    const ctx: Ctx = { state: initialMatchState(DEFAULT_RULES, 0), log: [], snapshots: [] };
    apply(ctx, nextDealEvent(ctx.state, deckOf(WHOLE_HANDS)));
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'askWhole' }, 'error.notInPhase');

    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    expect(ctx.state.deal?.phase.name).toBe('exchangeGive');
    expectError(ctx, 3, { type: 'askHalf', suit: 'D', rankHeld: 'K' }, 'error.notInPhase');

    act(ctx, 3, { type: 'giveCards', cards: WHOLE_GIVE });
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.notInPhase');
    act(ctx, 1, { type: 'setContract', amount: 50 });
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.notInPhase');
  });

  it('opens exactly one window after a self-led trick win (default declareRight)', () => {
    const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']); // asserts trickWon.canDeclareNext === true
    const hint = declarationHintOf(ctx, 1);
    expect(hint).toEqual({
      type: 'declaration',
      ownSuits: ['H'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'H', rankHeld: 'K' },
        { suit: 'H', rankHeld: 'Q' },
      ],
    });
  });

  it('denies the window when the trick was won but led by someone else (default)', () => {
    const ctx = setupDeal(ANYWON_HANDS, ANYWON_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    // Seat 1 skips its window by leading; seat 0 heads the heart trick and wins.
    playTrick(
      ctx,
      [
        [1, 'HK'],
        [2, 'H9'],
        [3, 'H7'],
        [0, 'HA'],
      ],
      { winner: 0, trickIndex: 1, canDeclareNext: false },
    );
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 0, canDeclare: false });
    // Seat 0 holds DK+DQ but won a trick seat 1 led: no declaration.
    expectError(ctx, 0, { type: 'declareOwn', suit: 'D' }, 'error.declarationUsed');
    expectError(ctx, 0, { type: 'askWhole' }, 'error.declarationUsed');
    expect(declarationHintOf(ctx, 0)).toBeUndefined();

    // …but winning a trick it leads ITSELF then opens the window.
    playTrick(
      ctx,
      [
        [0, 'H10'],
        [1, 'H6'],
        [2, 'HJ'],
        [3, 'D6'], // seat 3 is void in hearts, no trump yet -> free discard
      ],
      { winner: 0, trickIndex: 2, canDeclareNext: true },
    );
    expect(declarationHintOf(ctx, 0)).toEqual({
      type: 'declaration',
      ownSuits: ['D'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'D', rankHeld: 'K' },
        { suit: 'D', rankHeld: 'Q' },
      ],
    });
    expect(act(ctx, 0, { type: 'declareOwn', suit: 'D' })).toEqual([
      { type: 'declaredOwn', seat: 0, suit: 'D' },
      { type: 'trumpSet', suit: 'D', seat: 0, side: 0, how: 'own', points: 80 },
    ]);
    expect(ctx.state.deal?.trump).toBe('D');
  });

  it("declareRight 'anyWonTrick' grants the window on any trick win", () => {
    const config: RuleConfig = { ...DEFAULT_RULES, declareRight: 'anyWonTrick' };
    const ctx = setupDeal(ANYWON_HANDS, ANYWON_GIVE, config);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    playTrick(
      ctx,
      [
        [1, 'HK'],
        [2, 'H9'],
        [3, 'H7'],
        [0, 'HA'],
      ],
      { winner: 0, trickIndex: 1, canDeclareNext: true }, // relaxed right
    );
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 0, canDeclare: true });
    expect(declarationHintOf(ctx, 0)).toEqual({
      type: 'declaration',
      ownSuits: ['D'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'D', rankHeld: 'K' },
        { suit: 'D', rankHeld: 'Q' },
      ],
    });
    expect(act(ctx, 0, { type: 'declareOwn', suit: 'D' })).toEqual([
      { type: 'declaredOwn', seat: 0, suit: 'D' },
      { type: 'trumpSet', suit: 'D', seat: 0, side: 0, how: 'own', points: 80 },
    ]);
  });
});

describe('declareOwn', () => {
  it('requires both K and Q of the suit in hand (error.noMarriageInHand)', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    // Seat 1 holds CK without CQ, DK without DQ, and no spade honor at all.
    expectError(ctx, 1, { type: 'declareOwn', suit: 'C' }, 'error.noMarriageInHand');
    expectError(ctx, 1, { type: 'declareOwn', suit: 'D' }, 'error.noMarriageInHand');
    expectError(ctx, 1, { type: 'declareOwn', suit: 'S' }, 'error.noMarriageInHand');
    // Rejections do not consume the window; the real marriage still declares.
    expect(act(ctx, 1, { type: 'declareOwn', suit: 'H' })).toEqual([
      { type: 'declaredOwn', seat: 1, suit: 'H' },
      { type: 'trumpSet', suit: 'H', seat: 1, side: 1, how: 'own', points: 100 },
    ]);
    expect(ctx.state.deal?.trump).toBe('H');
    expect(ctx.state.deal?.declarations).toEqual([
      { suit: 'H', seat: 1, side: 1, how: 'own', trickIndex: 1, points: 100 },
    ]);
  });

  it('allows each suit to be declared only once per deal', () => {
    const ctx = setupDeal(SWITCH_HANDS, SWITCH_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    act(ctx, 1, { type: 'declareOwn', suit: 'S' });
    expect(ctx.state.deal?.trump).toBe('S');

    // Second self-led win -> second window.
    playTrick(
      ctx,
      [
        [1, 'DA'],
        [2, 'DJ'],
        [3, 'D7'],
        [0, 'D8'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    // Seat 1 STILL holds SK+SQ (declaring removes no cards), yet ♠ is spent.
    expectError(ctx, 1, { type: 'declareOwn', suit: 'S' }, 'error.suitAlreadyDeclared');
    // The declared suit also drops out of the hint.
    expect(declarationHintOf(ctx, 1)).toEqual({
      type: 'declaration',
      ownSuits: ['H'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'H', rankHeld: 'K' },
        { suit: 'H', rankHeld: 'Q' },
      ],
    });
  });
});

describe('trump switching', () => {
  it('switches trump immediately and resolves the next trick under the new trump', () => {
    const ctx = setupDeal(SWITCH_HANDS, SWITCH_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);

    act(ctx, 1, { type: 'declareOwn', suit: 'S' });
    expect(ctx.state.deal?.trump).toBe('S'); // immediate

    playTrick(
      ctx,
      [
        [1, 'DA'],
        [2, 'DJ'],
        [3, 'D7'],
        [0, 'D8'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    act(ctx, 1, { type: 'declareOwn', suit: 'H' });
    expect(ctx.state.deal?.trump).toBe('H'); // ♠ -> ♥ before the next trick
    expect(ctx.state.deal?.declarations).toEqual([
      { suit: 'S', seat: 1, side: 1, how: 'own', trickIndex: 1, points: 40 },
      { suit: 'H', seat: 1, side: 1, how: 'own', trickIndex: 2, points: 100 },
    ]);

    // Trick 2 resolves under ♥: seat 1 leads SK, seat 3 heads with the SA,
    // and seat 0 (void in spades) is FORCED to trump with a heart, which
    // now beats the ace of the former trump suit.
    act(ctx, 1, { type: 'playCard', card: 'SK' });
    act(ctx, 2, { type: 'playCard', card: 'S8' });
    // Mid-trick there is no declaring — trump can never change inside a trick.
    expectError(ctx, 3, { type: 'declareOwn', suit: 'D' }, 'error.notInPhase');
    act(ctx, 3, { type: 'playCard', card: 'SA' });
    const hint = allowedActions(ctx.state, 0).find((h) => h.type === 'playCard');
    expect(hint).toEqual({ type: 'playCard', legal: ['HA', 'HJ', 'H7'] }); // must trump
    const end = act(ctx, 0, { type: 'playCard', card: 'HJ' });
    expect(end[1]).toEqual({ type: 'trickWon', seat: 0, trickIndex: 2, canDeclareNext: false });
    expect(ctx.state.deal?.trump).toBe('H');
  });
});

describe('askHalf', () => {
  it('requires actually holding the announced half (error.notHoldingHalf)', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expectError(ctx, 1, { type: 'askHalf', suit: 'C', rankHeld: 'Q' }, 'error.notHoldingHalf');
    expectError(ctx, 1, { type: 'askHalf', suit: 'D', rankHeld: 'Q' }, 'error.notHoldingHalf');
    expectError(ctx, 1, { type: 'askHalf', suit: 'S', rankHeld: 'K' }, 'error.notHoldingHalf');
    // Only actually-held halves are hinted.
    expect(declarationHintOf(ctx, 1)).toEqual({
      type: 'declaration',
      ownSuits: ['H'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'H', rankHeld: 'K' },
        { suit: 'H', rankHeld: 'Q' },
        { suit: 'D', rankHeld: 'K' },
        { suit: 'C', rankHeld: 'K' },
      ],
    });
  });

  it('declares the suit when the partner holds the complement', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expect(act(ctx, 1, { type: 'askHalf', suit: 'D', rankHeld: 'K' })).toEqual([
      { type: 'askedHalf', seat: 1, suit: 'D', rankHeld: 'K' },
      { type: 'answeredHalf', seat: 3, yes: true },
      { type: 'trumpSet', suit: 'D', seat: 1, side: 1, how: 'halfAsk', points: 80 },
    ]);
    expect(ctx.state.deal?.trump).toBe('D');
    expect(ctx.state.deal?.declarations).toEqual([
      { suit: 'D', seat: 1, side: 1, how: 'halfAsk', trickIndex: 1, points: 80 },
    ]);
  });

  it("a truthful 'no' answer sets no trump but consumes the attempt", () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    // CQ sits with an opponent, so the answer is no.
    expect(act(ctx, 1, { type: 'askHalf', suit: 'C', rankHeld: 'K' })).toEqual([
      { type: 'askedHalf', seat: 1, suit: 'C', rankHeld: 'K' },
      { type: 'answeredHalf', seat: 3, yes: false },
    ]);
    expect(ctx.state.deal?.trump).toBeNull();
    expect(ctx.state.deal?.declarations).toEqual([]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    // The failed ask WAS the one attempt: nothing else may follow.
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.declarationUsed');
    expectError(ctx, 1, { type: 'askWhole' }, 'error.declarationUsed');
    expectError(ctx, 1, { type: 'askHalf', suit: 'D', rankHeld: 'K' }, 'error.declarationUsed');
    // Playing a card still works normally.
    expect(act(ctx, 1, { type: 'playCard', card: 'C10' })[0]).toEqual({
      type: 'cardPlayed',
      seat: 1,
      card: 'C10',
    });
  });

  it('never re-offers or accepts a half the partner already denied', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    // Trick 1: ask ♣ (CQ sits with an opponent → 'no'); the denial is recorded
    // for the asking side.
    act(ctx, 1, { type: 'askHalf', suit: 'C', rankHeld: 'K' });
    expect(ctx.state.deal?.deniedHalves).toEqual([{ side: 1, suit: 'C' }]);
    // Seat 1 leads C10 and wins, reopening the declaration window at trick 2.
    playTrick(
      ctx,
      [
        [1, 'C10'],
        [2, 'CQ'],
        [3, 'S7'],
        [0, 'C9'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: true });
    // The denied ♣ half is gone from the hint; the untried ♥/♦ halves remain.
    expect(declarationHintOf(ctx, 1)).toEqual({
      type: 'declaration',
      ownSuits: ['H'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'H', rankHeld: 'K' },
        { suit: 'H', rankHeld: 'Q' },
        { suit: 'D', rankHeld: 'K' },
      ],
    });
    // Re-asking the denied ♣ half is rejected outright; an untried suit still works.
    expectError(ctx, 1, { type: 'askHalf', suit: 'C', rankHeld: 'K' }, 'error.halfAlreadyDenied');
    expect(act(ctx, 1, { type: 'askHalf', suit: 'D', rankHeld: 'K' })).toEqual([
      { type: 'askedHalf', seat: 1, suit: 'D', rankHeld: 'K' },
      { type: 'answeredHalf', seat: 3, yes: true },
      { type: 'trumpSet', suit: 'D', seat: 1, side: 1, how: 'halfAsk', points: 80 },
    ]);
  });

  it('rejects asking in an already-declared suit (error.suitAlreadyDeclared)', () => {
    const ctx = setupDeal(SWITCH_HANDS, SWITCH_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    act(ctx, 1, { type: 'declareOwn', suit: 'S' });
    playTrick(
      ctx,
      [
        [1, 'DA'],
        [2, 'DJ'],
        [3, 'D7'],
        [0, 'D8'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    // Seat 1 still holds SK and SQ, but ♠ was already declared.
    expectError(ctx, 1, { type: 'askHalf', suit: 'S', rankHeld: 'K' }, 'error.suitAlreadyDeclared');
    expectError(ctx, 1, { type: 'askHalf', suit: 'S', rankHeld: 'Q' }, 'error.suitAlreadyDeclared');
  });

  it('askHalfMustHoldCard=false permits bluff asks and hints every half', () => {
    const config: RuleConfig = { ...DEFAULT_RULES, askHalfMustHoldCard: false };
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE, config);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expect(declarationHintOf(ctx, 1)).toEqual({
      type: 'declaration',
      ownSuits: ['H'],
      canAskWhole: true,
      halfAsks: [
        { suit: 'H', rankHeld: 'K' },
        { suit: 'H', rankHeld: 'Q' },
        { suit: 'D', rankHeld: 'K' },
        { suit: 'D', rankHeld: 'Q' },
        { suit: 'C', rankHeld: 'K' },
        { suit: 'C', rankHeld: 'Q' },
        { suit: 'S', rankHeld: 'K' },
        { suit: 'S', rankHeld: 'Q' },
      ],
    });
    // Seat 1 holds neither ♠ honor yet may ask; the truthful answer is no.
    expect(act(ctx, 1, { type: 'askHalf', suit: 'S', rankHeld: 'Q' })).toEqual([
      { type: 'askedHalf', seat: 1, suit: 'S', rankHeld: 'Q' },
      { type: 'answeredHalf', seat: 3, yes: false },
    ]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });
});

describe('askWhole', () => {
  it('auto-answers null when the partner has no declarable marriage', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expect(act(ctx, 1, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 1 },
      { type: 'answeredWhole', seat: 3, suit: null },
    ]);
    expect(ctx.state.deal?.trump).toBeNull();
    expect(ctx.state.deal?.askedWhole).toEqual({ 0: false, 1: true, 2: false, 3: false });
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    // The null answer consumed the single attempt.
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.declarationUsed');
  });

  it('auto-answers and sets trump when the partner has exactly one marriage', () => {
    const ctx = setupDeal(ANYWON_HANDS, ANYWON_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expect(act(ctx, 1, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 1 },
      { type: 'answeredWhole', seat: 3, suit: 'C' },
      { type: 'trumpSet', suit: 'C', seat: 3, side: 1, how: 'wholeAsk', points: 60 },
    ]);
    expect(ctx.state.deal?.trump).toBe('C');
    // ohje 587: the declaration is attributed to the HOLDER (seat 3), not the
    // asker (seat 1). Both share side 1.
    expect(ctx.state.deal?.declarations).toEqual([
      { suit: 'C', seat: 3, side: 1, how: 'wholeAsk', trickIndex: 1, points: 60 },
    ]);
  });

  // ohje 587: "jos valtti tehdään kokonaista kysymällä, valtin tekijäksi
  // katsotaan se pelaaja, jolla valtti oli kädessään, ei se, joka kysyi
  // kokonaista." Regression guard for the asker-credit divergence.
  it('credits a whole-ask trump to the HOLDER seat, never the asker (ohje 587)', () => {
    const ctx = setupDeal(ANYWON_HANDS, ANYWON_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    const events = act(ctx, 1, { type: 'askWhole' });
    const trumpSet = events.find((e) => e.type === 'trumpSet');
    // Asker is seat 1; the ♣ marriage sits in the partner's (seat 3) hand.
    expect(trumpSet).toMatchObject({ how: 'wholeAsk', seat: 3 });
    expect(trumpSet).not.toMatchObject({ seat: 1 });
    const decl = ctx.state.deal?.declarations[0];
    expect(decl?.seat).toBe(3);
    expect(decl?.side).toBe(1); // asker and holder still share the side
  });

  it('enters the choice phase with 2+ marriages and validates the answer', () => {
    const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expect(act(ctx, 1, { type: 'askWhole' })).toEqual([{ type: 'askedWhole', seat: 1 }]);
    expect(ctx.state.deal?.phase).toEqual({ name: 'awaitWholeAnswer', leader: 1 });
    expect(expectedActor(ctx.state)).toBe(3);
    expect(allowedActions(ctx.state, 3)).toEqual([{ type: 'answerWhole', suits: ['D', 'C'] }]);

    // Only the asked partner may answer, and only with a real marriage.
    expectError(ctx, 2, { type: 'answerWhole', suit: 'D' }, 'error.notYourTurn');
    expectError(ctx, 1, { type: 'answerWhole', suit: 'D' }, 'error.notYourTurn');
    expectError(ctx, 3, { type: 'answerWhole', suit: 'H' }, 'error.noMarriageInHand');
    expectError(ctx, 3, { type: 'answerWhole', suit: 'S' }, 'error.noMarriageInHand');
    // Nothing else can happen while the answer is pending.
    expectError(ctx, 1, { type: 'playCard', card: 'C10' }, 'error.notInPhase');
    expectError(ctx, 3, { type: 'playCard', card: 'DA' }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.notInPhase');

    expect(act(ctx, 3, { type: 'answerWhole', suit: 'C' })).toEqual([
      { type: 'answeredWhole', seat: 3, suit: 'C' },
      // ohje 587: credited to the holder (seat 3), not the asker (seat 1).
      { type: 'trumpSet', suit: 'C', seat: 3, side: 1, how: 'wholeAsk', points: 60 },
    ]);
    expect(ctx.state.deal?.trump).toBe('C');
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    expectError(ctx, 1, { type: 'askWhole' }, 'error.declarationUsed');
  });

  it('excludes declared suits from answers and auto-answers the single leftover', () => {
    const ctx = setupDeal(CHOICE2_HANDS, CHOICE2_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    act(ctx, 1, { type: 'declareOwn', suit: 'H' }); // window 1: ♥ trump

    playTrick(
      ctx,
      [
        [1, 'DA'],
        [2, 'DJ'],
        [3, 'D7'],
        [0, 'D8'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    act(ctx, 1, { type: 'askWhole' }); // partner holds ♦ and ♣ -> choice
    expect(ctx.state.deal?.phase).toEqual({ name: 'awaitWholeAnswer', leader: 1 });
    expect(allowedActions(ctx.state, 3)).toEqual([{ type: 'answerWhole', suits: ['D', 'C'] }]);
    // ♥ is already declared this deal — even the ANSWER may not reuse it.
    expectError(ctx, 3, { type: 'answerWhole', suit: 'H' }, 'error.suitAlreadyDeclared');
    act(ctx, 3, { type: 'answerWhole', suit: 'D' });
    expect(ctx.state.deal?.trump).toBe('D');

    playTrick(
      ctx,
      [
        [1, 'SA'],
        [2, 'S8'],
        [3, 'S7'],
        [0, 'SK'],
      ],
      { winner: 1, trickIndex: 2, canDeclareNext: true },
    );
    // Re-asking is legal (the partner never asked). ♦ is spent, so the
    // partner's remaining single marriage ♣ auto-answers — even though the
    // ♦ cards are still in their hand.
    expect(declarationHintOf(ctx, 1)).toEqual({
      type: 'declaration',
      ownSuits: [], // asker is locked out of own declarations
      canAskWhole: true,
      halfAsks: [],
    });
    expect(act(ctx, 1, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 1 },
      { type: 'answeredWhole', seat: 3, suit: 'C' },
      // ohje 587: credited to the holder (seat 3), not the asker (seat 1).
      { type: 'trumpSet', suit: 'C', seat: 3, side: 1, how: 'wholeAsk', points: 60 },
    ]);
    expect(ctx.state.deal?.trump).toBe('C');
    expect(ctx.state.deal?.declarations.map((d) => d.suit)).toEqual(['H', 'D', 'C']);
  });

  it('locks the asker out of declareOwn on later windows (error.askedWholeLock)', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    act(ctx, 1, { type: 'askWhole' }); // auto-null, askedWhole[1] = true

    // Seat 1 wins another self-led trick -> a fresh window.
    playTrick(
      ctx,
      [
        [1, 'C10'],
        [2, 'CQ'],
        [3, 'S10'], // void in clubs, no trump -> free discard
        [0, 'C9'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    // Holds HK+HQ, ♥ undeclared — but the whole-ask lock forbids declareOwn.
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.askedWholeLock');
    expect(declarationHintOf(ctx, 1)).toEqual({
      type: 'declaration',
      ownSuits: [],
      canAskWhole: true, // partner never asked, so re-asking stays open
      halfAsks: [
        { suit: 'H', rankHeld: 'K' },
        { suit: 'H', rankHeld: 'Q' },
        { suit: 'D', rankHeld: 'K' },
        { suit: 'C', rankHeld: 'K' },
      ],
    });
    // Re-asking the partner is still legal and auto-answers null again.
    expect(act(ctx, 1, { type: 'askWhole' })).toEqual([
      { type: 'askedWhole', seat: 1 },
      { type: 'answeredWhole', seat: 3, suit: null },
    ]);
  });
});

describe('one attempt per lead opportunity', () => {
  it('a successful declaration consumes the attempt', () => {
    const ctx = setupDeal(SWITCH_HANDS, SWITCH_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    act(ctx, 1, { type: 'declareOwn', suit: 'S' });
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.declarationUsed');
    expectError(ctx, 1, { type: 'askWhole' }, 'error.declarationUsed');
    expectError(ctx, 1, { type: 'askHalf', suit: 'H', rankHeld: 'K' }, 'error.declarationUsed');
  });

  it('a rejected declaration does NOT consume the attempt', () => {
    const ctx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expectError(ctx, 1, { type: 'declareOwn', suit: 'C' }, 'error.noMarriageInHand');
    expectError(ctx, 1, { type: 'askHalf', suit: 'S', rankHeld: 'K' }, 'error.notHoldingHalf');
    // The window is still open after invalid tries.
    expect(ctx.state.deal?.phase).toEqual({ name: 'lead', leader: 1, canDeclare: true });
    expect(act(ctx, 1, { type: 'declareOwn', suit: 'H' })[1]).toMatchObject({
      type: 'trumpSet',
      suit: 'H',
    });
  });

  it('leading a card is the implicit skip and the window never reopens by itself', () => {
    const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    // Skip by playing; the same lead opportunity cannot be declared into later.
    act(ctx, 1, { type: 'playCard', card: 'C10' });
    expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.notInPhase'); // mid-trick
  });
});

/**
 * Full-deal lifecycle: choice-phase whole-ask, both askedWhole lock
 * directions, a mid-deal own-declaration by the partner, trump ♣ -> ♦,
 * suitAlreadyDeclared on a half-ask, no window on the last trick even when
 * self-led, notInPhase after scoring, and an exact marriage-inclusive score.
 * The returned ctx (with per-event snapshots) also feeds the view suite.
 */
function playLifecycleDeal(): Ctx {
  const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE);

  // Trick 0: seat 1 wins its own club lead -> window at the trick-1 lead.
  winTrick0(ctx, ['CJ', 'C7', 'C8']);

  // Window 1: whole-ask hits the choice phase (partner holds ♦ and ♣).
  act(ctx, 1, { type: 'askWhole' });
  expect(ctx.state.deal?.phase).toEqual({ name: 'awaitWholeAnswer', leader: 1 });
  act(ctx, 3, { type: 'answerWhole', suit: 'C' });
  expect(ctx.state.deal?.trump).toBe('C');
  expect(ctx.state.deal?.askedWhole).toEqual({ 0: false, 1: true, 2: false, 3: false });

  // Trick 1: seat 1 wins again under ♣ trump (nobody can take C10).
  playTrick(
    ctx,
    [
      [1, 'C10'],
      [2, 'S9'], // void in clubs = void in trump -> free discard
      [3, 'CQ'],
      [0, 'C9'],
    ],
    { winner: 1, trickIndex: 1, canDeclareNext: true },
  );

  // Window 2: the asker may no longer declare from hand.
  expectError(ctx, 1, { type: 'declareOwn', suit: 'H' }, 'error.askedWholeLock');
  expect(declarationHintOf(ctx, 1)).toEqual({
    type: 'declaration',
    ownSuits: [],
    canAskWhole: true,
    halfAsks: [
      { suit: 'H', rankHeld: 'K' },
      { suit: 'H', rankHeld: 'Q' },
    ],
  });

  // Trick 2 (window 2 skipped implicitly): seat 3 must head partner's DJ
  // with the DA and wins a trick it did NOT lead -> no window.
  playTrick(
    ctx,
    [
      [1, 'DJ'],
      [2, 'D8'],
      [3, 'DA'],
      [0, 'D10'],
    ],
    { winner: 3, trickIndex: 2, canDeclareNext: false },
  );
  expectError(ctx, 3, { type: 'declareOwn', suit: 'D' }, 'error.declarationUsed');
  expect(declarationHintOf(ctx, 3)).toBeUndefined();

  // Trick 3: seat 3 wins a self-led trump trick -> earns its own window.
  playTrick(
    ctx,
    [
      [3, 'CK'],
      [0, 'S8'],
      [1, 'C6'],
      [2, 'SJ'],
    ],
    { winner: 3, trickIndex: 3, canDeclareNext: true },
  );

  // Window 3: the partner of the asker may not ask a whole back…
  expectError(ctx, 3, { type: 'askWhole' }, 'error.askedWholeLock');
  expect(declarationHintOf(ctx, 3)).toEqual({
    type: 'declaration',
    ownSuits: ['D'],
    canAskWhole: false, // locked: seat 1 already asked
    halfAsks: [
      { suit: 'D', rankHeld: 'K' },
      { suit: 'D', rankHeld: 'Q' },
    ],
  });
  // …but the ANSWERER keeps its own-hand declaration right: ♦ becomes trump.
  expect(act(ctx, 3, { type: 'declareOwn', suit: 'D' })).toEqual([
    { type: 'declaredOwn', seat: 3, suit: 'D' },
    { type: 'trumpSet', suit: 'D', seat: 3, side: 1, how: 'own', points: 80 },
  ]);
  expect(ctx.state.deal?.trump).toBe('D');
  expectError(ctx, 3, { type: 'askHalf', suit: 'H', rankHeld: 'K' }, 'error.declarationUsed');

  // Trick 4: ♦ trump governs; seat 3 wins self-led again.
  playTrick(
    ctx,
    [
      [3, 'DK'],
      [0, 'H8'], // void in diamonds, no trump in hand
      [1, 'D6'],
      [2, 'D9'],
    ],
    { winner: 3, trickIndex: 4, canDeclareNext: true },
  );

  // Window 4: asking a half in the already-declared ♦ is rejected
  // (seat 3 does hold the DQ), and the rejection keeps the window open.
  expectError(ctx, 3, { type: 'askHalf', suit: 'D', rankHeld: 'Q' }, 'error.suitAlreadyDeclared');

  // Tricks 5-6: seat 3 cashes the remaining trumps (windows skipped).
  playTrick(
    ctx,
    [
      [3, 'DQ'],
      [0, 'H10'],
      [1, 'S6'],
      [2, 'H9'],
    ],
    { winner: 3, trickIndex: 5, canDeclareNext: true },
  );
  // A window with no options at all yields no declaration hint.
  playTrick(
    ctx,
    [
      [3, 'D7'],
      [0, 'SQ'],
      [1, 'H6'],
      [2, 'HJ'],
    ],
    { winner: 3, trickIndex: 6, canDeclareNext: true },
  );
  expect(declarationHintOf(ctx, 3)).toBeUndefined();
  expect(allowedActions(ctx.state, 3)).toEqual([{ type: 'playCard', legal: ['S7', 'H7'] }]);

  // Trick 7: seat 2 heads with the SA and wins a trick seat 3 led.
  playTrick(
    ctx,
    [
      [3, 'S7'],
      [0, 'SK'],
      [1, 'HQ'],
      [2, 'SA'],
    ],
    { winner: 2, trickIndex: 7, canDeclareNext: false },
  );

  // Trick 8 (the 9th and last): seat 2 wins its OWN lead, yet the last trick
  // never opens a window; the deal scores in the same event chain.
  act(ctx, 2, { type: 'playCard', card: 'S10' });
  act(ctx, 3, { type: 'playCard', card: 'H7' });
  act(ctx, 0, { type: 'playCard', card: 'HA' });
  const finalEvents = act(ctx, 1, { type: 'playCard', card: 'HK' });
  expect(finalEvents).toEqual([
    { type: 'cardPlayed', seat: 1, card: 'HK' },
    { type: 'trickWon', seat: 2, trickIndex: 8, canDeclareNext: false },
    {
      type: 'dealScored',
      result: {
        declarer: 1,
        contract: 50,
        bid: 50,
        made: true,
        sides: [
          {
            cardPoints: 43,
            lastTrickBonus: 10,
            marriagePoints: 0,
            discardPoints: 0,
            rawTotal: 53,
            roundedTotal: 53,
            tricks: 2,
            porvoo: false,
            scoreDelta: 53,
          },
          {
            cardPoints: 77,
            lastTrickBonus: 0,
            marriagePoints: 140, // ♣60 + ♦80, both to side 1
            discardPoints: 0,
            rawTotal: 217,
            roundedTotal: 217,
            tricks: 7,
            porvoo: false,
            scoreDelta: 50, // clamped to the contract
          },
        ],
      },
    },
  ]);
  expect(ctx.state.scores).toEqual([53, 50]);

  // After the deal no declaration (or anything else) is possible.
  expect(ctx.state.deal?.phase.name).toBe('scored');
  expectError(ctx, 2, { type: 'declareOwn', suit: 'S' }, 'error.notInPhase');
  expectError(ctx, 2, { type: 'askWhole' }, 'error.notInPhase');
  expectError(ctx, 1, { type: 'askHalf', suit: 'S', rankHeld: 'K' }, 'error.notInPhase');
  for (const s of SEATS) expect(allowedActions(ctx.state, s)).toEqual([]);
  return ctx;
}

describe('full-deal declaration lifecycle', () => {
  it('runs whole-ask locks, mid-deal switches and end-of-deal boundaries', () => {
    const ctx = playLifecycleDeal();
    expect(ctx.state.deal?.declarations).toEqual([
      // ohje 587: the whole-ask ♣ is credited to the holder (seat 3), not the
      // asker (seat 1); seat 3 also declared ♦ from hand.
      { suit: 'C', seat: 3, side: 1, how: 'wholeAsk', trickIndex: 1, points: 60 },
      { suit: 'D', seat: 3, side: 1, how: 'own', trickIndex: 4, points: 80 },
    ]);
    // Replay determinism: the event log reproduces the final state.
    let replayed = initialMatchState(DEFAULT_RULES, 0);
    for (const e of ctx.log) replayed = applyEvent(replayed, e);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(ctx.state));
  });
});

// ── (B) View & event redaction ───────────────────────────────────────────────

/**
 * Asserts that no viewer's serialized view contains a card that is currently
 * in another seat's hand. The ONLY sanctioned exception is the exchange:
 * the declarer and partner are privy to the given/returned faces
 * (exchangeSeen), which may still sit in the other's hand. Cards appear in
 * view JSON solely as quoted strings, so searching for the quoted token is
 * an exact match (no substring collisions).
 */
function assertNoForeignCards(state: MatchState): void {
  const deal = state.deal;
  for (const viewer of VIEWERS) {
    const view = redactViewFor(state, viewer);
    if (!deal) {
      expect(view.deal).toBeNull();
      continue;
    }
    const json = JSON.stringify(view);
    const privy =
      viewer !== 'spectator' &&
      deal.declarer !== null &&
      (viewer === deal.declarer || viewer === partnerOf(deal.declarer));
    const allowed = new Set<Card>(
      privy ? [...(deal.exchange.given ?? []), ...(deal.exchange.returned ?? [])] : [],
    );
    for (const seat of SEATS) {
      if (viewer === seat) continue;
      for (const card of deal.hands[seat]) {
        if (allowed.has(card)) continue;
        expect(
          json.includes(`"${card}"`),
          `view of ${String(viewer)} leaks ${card} from seat ${seat}'s hand`,
        ).toBe(false);
      }
    }
  }
}

/** Counts, own-hand, spectator and exchangeSeen invariants for one state. */
function assertViewConsistency(state: MatchState): void {
  const deal = state.deal;
  for (const viewer of VIEWERS) {
    const view = redactViewFor(state, viewer);
    expect(view.viewer).toBe(viewer);
    if (!deal) {
      expect(view.deal).toBeNull();
      continue;
    }
    const dv = view.deal;
    expect(dv).not.toBeNull();
    if (!dv) continue;
    expect(dv.handCounts).toEqual({
      0: deal.hands[0].length,
      1: deal.hands[1].length,
      2: deal.hands[2].length,
      3: deal.hands[3].length,
    });
    expect(dv.capturedCounts).toEqual({
      0: deal.captured[0].length,
      1: deal.captured[1].length,
      2: deal.captured[2].length,
      3: deal.captured[3].length,
    });
    expect(dv.tricksWon).toEqual(deal.tricksWon);
    expect(dv.tricksPlayed).toBe(deal.tricksPlayed);
    expect(dv.trump).toBe(deal.trump);
    if (viewer === 'spectator') {
      expect(dv.hand).toEqual([]);
    } else {
      expect(dv.hand).toEqual(sortHand(deal.hands[viewer]));
    }
    const privy =
      viewer !== 'spectator' &&
      deal.declarer !== null &&
      (viewer === deal.declarer || viewer === partnerOf(deal.declarer));
    if (privy) {
      expect(dv.exchangeSeen).toEqual({
        given: deal.exchange.given,
        returned: deal.exchange.returned,
      });
    } else {
      expect(dv.exchangeSeen).toBeNull();
    }
  }
}

describe('view redaction', () => {
  it('never leaks a card from another hand, after every event of a full deal', () => {
    const ctx = playLifecycleDeal();
    expect(ctx.snapshots.length).toBeGreaterThan(40);
    for (const s of ctx.snapshots) assertNoForeignCards(s);
  });

  it('never leaks across a deal with two own-declarations either', () => {
    const ctx = setupDeal(SWITCH_HANDS, SWITCH_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    act(ctx, 1, { type: 'declareOwn', suit: 'S' });
    playTrick(
      ctx,
      [
        [1, 'DA'],
        [2, 'DJ'],
        [3, 'D7'],
        [0, 'D8'],
      ],
      { winner: 1, trickIndex: 1, canDeclareNext: true },
    );
    act(ctx, 1, { type: 'declareOwn', suit: 'H' });
    for (const s of ctx.snapshots) assertNoForeignCards(s);
  });

  it('keeps counts, own hands, spectator hand and exchangeSeen consistent throughout', () => {
    const ctx = playLifecycleDeal();
    for (const s of ctx.snapshots) assertViewConsistency(s);
  });

  it('shows exchangeSeen only to the declarer and partner, phase by phase', () => {
    const ctx: Ctx = { state: initialMatchState(DEFAULT_RULES, 0), log: [], snapshots: [] };
    apply(ctx, nextDealEvent(ctx.state, deckOf(WHOLE_HANDS)));
    act(ctx, 1, { type: 'bid', amount: 50 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 3, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });

    // After the give, before the return: both privy seats already see it.
    act(ctx, 3, { type: 'giveCards', cards: ['S7', 'H7', 'C7'] });
    expect(redactViewFor(ctx.state, 1).deal?.exchangeSeen).toEqual({
      given: ['S7', 'H7', 'C7'],
      returned: null,
    });
    expect(redactViewFor(ctx.state, 3).deal?.exchangeSeen).toEqual({
      given: ['S7', 'H7', 'C7'],
      returned: null,
    });
    expect(redactViewFor(ctx.state, 0).deal?.exchangeSeen).toBeNull();
    expect(redactViewFor(ctx.state, 2).deal?.exchangeSeen).toBeNull();
    expect(redactViewFor(ctx.state, 'spectator').deal?.exchangeSeen).toBeNull();

    act(ctx, 1, { type: 'setContract', amount: 50 });
    act(ctx, 1, { type: 'returnCards', cards: ['S7', 'H7', 'C7'] });
    for (const privySeat of [1, 3] as const) {
      expect(redactViewFor(ctx.state, privySeat).deal?.exchangeSeen).toEqual({
        given: ['S7', 'H7', 'C7'],
        returned: ['S7', 'H7', 'C7'],
      });
    }
    for (const other of [0, 2, 'spectator'] as const) {
      expect(redactViewFor(ctx.state, other).deal?.exchangeSeen).toBeNull();
    }
  });

  it('gives spectators an empty hand but full public information', () => {
    const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    const view = redactViewFor(ctx.state, 'spectator');
    expect(view.viewer).toBe('spectator');
    expect(view.deal?.hand).toEqual([]);
    expect(view.deal?.handCounts).toEqual({ 0: 8, 1: 8, 2: 8, 3: 8 });
    expect(view.deal?.declarer).toBe(1);
    expect(view.deal?.contract).toBe(50);
    expect(view.deal?.lastTrick).toEqual({
      plays: [
        { seat: 1, card: 'CA' },
        { seat: 2, card: 'CJ' },
        { seat: 3, card: 'C7' },
        { seat: 0, card: 'C8' },
      ],
      winner: 1,
    });
  });

  it('hides lastTrick from every viewer when config.showLastTrick is false', () => {
    const config: RuleConfig = { ...DEFAULT_RULES, showLastTrick: false };
    const ctx = setupDeal(WHOLE_HANDS, WHOLE_GIVE, config);
    winTrick0(ctx, ['CJ', 'C7', 'C8']);
    expect(ctx.state.deal?.lastTrick?.winner).toBe(1); // truth keeps it
    for (const viewer of VIEWERS) {
      expect(redactViewFor(ctx.state, viewer).deal?.lastTrick).toBeNull();
    }
  });
});

describe('event redaction (redactEventFor)', () => {
  it('empties the dealStarted deck for every viewer including seats', () => {
    const event: GameEvent = {
      type: 'dealStarted',
      dealIndex: 0,
      dealer: 0,
      deck: deckOf(WHOLE_HANDS),
    };
    for (const viewer of VIEWERS) {
      expect(redactEventFor(event, viewer)).toEqual({ ...event, deck: [] });
    }
    expect(event.type === 'dealStarted' && event.deck.length).toBe(36); // input untouched
  });

  it('shows exchange card faces only to the two exchanging seats', () => {
    const given: GameEvent = { type: 'cardsGiven', from: 3, to: 1, cards: ['S7', 'H7', 'C7'] };
    const returned: GameEvent = {
      type: 'cardsReturned',
      from: 1,
      to: 3,
      cards: ['DK', 'H7', 'C7'],
    };
    for (const event of [given, returned]) {
      expect(redactEventFor(event, 1)).toEqual(event);
      expect(redactEventFor(event, 3)).toEqual(event);
      expect(redactEventFor(event, 0)).toEqual({ ...event, cards: [] });
      expect(redactEventFor(event, 2)).toEqual({ ...event, cards: [] });
      expect(redactEventFor(event, 'spectator')).toEqual({ ...event, cards: [] });
    }
  });

  it('passes every public event of a real deal through verbatim', () => {
    const ctx = playLifecycleDeal();
    const types = new Set(ctx.log.map((e) => e.type));
    // The lifecycle log must exercise a broad slice of the event vocabulary.
    for (const t of [
      'dealStarted',
      'bidPlaced',
      'passed',
      'biddingEnded',
      'cardsGiven',
      'contractSet',
      'cardsReturned',
      'askedWhole',
      'answeredWhole',
      'declaredOwn',
      'trumpSet',
      'cardPlayed',
      'trickWon',
      'dealScored',
    ] as const) {
      expect(types.has(t), `lifecycle log should contain ${t}`).toBe(true);
    }
    for (const event of ctx.log) {
      for (const viewer of VIEWERS) {
        const red = redactEventFor(event, viewer);
        if (event.type === 'dealStarted') {
          expect(red).toEqual({ ...event, deck: [] });
        } else if (event.type === 'cardsGiven' || event.type === 'cardsReturned') {
          if (viewer === event.from || viewer === event.to) {
            expect(red).toEqual(event);
          } else {
            expect(red).toEqual({ ...event, cards: [] });
          }
        } else {
          expect(red, `${event.type} must be public and unmodified`).toEqual(event);
        }
      }
    }
  });

  it('passes askedHalf/answeredHalf and synthetic public events verbatim', () => {
    const halfCtx = setupDeal(HALF_HANDS, HALF_GIVE);
    winTrick0(halfCtx, ['CJ', 'C7', 'C8']);
    const events = act(halfCtx, 1, { type: 'askHalf', suit: 'D', rankHeld: 'K' });
    for (const event of events) {
      for (const viewer of VIEWERS) {
        // Ask outcomes (and the halves involved) are table-public by design.
        expect(redactEventFor(event, viewer)).toEqual(event);
      }
    }
    const synthetic: GameEvent[] = [
      { type: 'redealDemanded', seat: 2 },
      { type: 'matchEnded', winnerSide: 1 },
      { type: 'answeredWhole', seat: 3, suit: null },
    ];
    for (const event of synthetic) {
      for (const viewer of VIEWERS) {
        expect(redactEventFor(event, viewer)).toEqual(event);
      }
    }
  });
});
