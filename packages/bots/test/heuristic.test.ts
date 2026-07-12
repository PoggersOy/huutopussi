/**
 * HeuristicBot decision tests: a 500-turn fuzz through the real engine
 * (every chosen action must be accepted, i.e. hinted-legal), plus scenario
 * tests on hand-crafted PlayerViews — the bot consumes only view + hints,
 * so views can be constructed directly.
 */
import {
  type ActionHint,
  allowedActions,
  applyEvent,
  type Card,
  DEFAULT_RULES,
  type DealPhase,
  type DealView,
  expectedActor,
  initialMatchState,
  isRuleError,
  makeDeck,
  nextDealEvent,
  type PlayerView,
  redactViewFor,
  SEATS,
  type Seat,
  validateAction,
} from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { HeuristicBot } from '../src/heuristic.js';
import { mulberry32, shuffle } from '../src/prng.js';

function makeView(hand: Card[], phase: DealPhase, over: Partial<DealView> = {}): PlayerView {
  return {
    viewer: 0,
    config: DEFAULT_RULES,
    scores: [0, 0],
    dealer: 3,
    dealIndex: 0,
    winnerSide: null,
    deal: {
      hand,
      handCounts: { 0: hand.length, 1: 9, 2: 9, 3: 9 },
      capturedCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
      tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0 },
      tricksPlayed: 0,
      trump: null,
      declarations: [],
      askedWhole: { 0: false, 1: false, 2: false, 3: false },
      askedHalf: { 0: false, 1: false, 2: false, 3: false },
      bidLog: [],
      bid: { seat: 0, amount: 50 },
      declarer: 0,
      contract: null,
      exchangeSeen: null,
      talonCount: null,
      talonSeen: null,
      dummyHandCount: null,
      discardedCount: null,
      lastTrick: null,
      phase,
      ...over,
    },
  };
}

function bot(): HeuristicBot {
  return new HeuristicBot(mulberry32(42));
}

/**
 * A 'hard' bot never takes the random-play detour (sloppiness 0), so its card
 * play is the deterministic heuristic — used by the trick-play scenario tests.
 * The lead/follow logic is identical across difficulties, so this asserts the
 * shared heuristic, not a level-specific quirk.
 */
function sharpBot(): HeuristicBot {
  return new HeuristicBot(mulberry32(42), 'hard');
}

describe('HeuristicBot fuzz', () => {
  it('always picks hinted-legal actions across 500 fuzzed turns', () => {
    const deck = makeDeck();
    let turns = 0;
    let game = 0;
    while (turns < 500) {
      const rng = mulberry32(0xbee5 + game);
      let state = initialMatchState(DEFAULT_RULES, (game % 4) as Seat);
      const bots = SEATS.map(() => new HeuristicBot(rng));
      let guard = 0;
      while (state.winnerSide === null && turns < 500) {
        guard++;
        if (guard > 20_000) throw new Error('runaway game');
        const actor = expectedActor(state);
        if (actor === null) {
          state = applyEvent(state, nextDealEvent(state, shuffle(rng, deck)));
          continue;
        }
        const hints = allowedActions(state, actor);
        const action = (bots[actor] as HeuristicBot).onTurn(redactViewFor(state, actor), hints);
        const res = validateAction(state, actor, action);
        if (isRuleError(res)) {
          throw new Error(
            `hinted-illegal action (${res.code}): seat ${actor} ${JSON.stringify(action)}`,
          );
        }
        turns++;
        for (const ev of res) state = applyEvent(state, ev);
      }
      game++;
    }
    expect(turns).toBe(500);
  });
});

describe('HeuristicBot declarations', () => {
  it('declares an available marriage immediately, highest value first', () => {
    const hand: Card[] = ['HK', 'HQ', 'SK', 'SQ', 'DA', 'C9', 'C8', 'C7', 'C6'];
    const view = makeView(hand, { name: 'lead', leader: 0, canDeclare: true });
    const hints: ActionHint[] = [
      {
        type: 'declaration',
        ownSuits: ['H', 'S'],
        canAskWhole: true,
        halfAsks: [
          { suit: 'H', rankHeld: 'K' },
          { suit: 'H', rankHeld: 'Q' },
          { suit: 'S', rankHeld: 'K' },
          { suit: 'S', rankHeld: 'Q' },
        ],
      },
      { type: 'playCard', legal: hand },
    ];
    expect(bot().onTurn(view, hints)).toEqual({ type: 'declareOwn', suit: 'H' });
  });

  it('asks the half when holding exactly one half', () => {
    const hand: Card[] = ['HQ', 'DA', 'D10', 'D9', 'C9', 'C8', 'C7', 'S8', 'S7'];
    const view = makeView(hand, { name: 'lead', leader: 0, canDeclare: true });
    const hints: ActionHint[] = [
      {
        type: 'declaration',
        ownSuits: [],
        canAskWhole: true,
        halfAsks: [{ suit: 'H', rankHeld: 'Q' }],
      },
      { type: 'playCard', legal: hand },
    ];
    expect(bot().onTurn(view, hints)).toEqual({ type: 'askHalf', suit: 'H', rankHeld: 'Q' });
  });
});

describe('HeuristicBot bidding', () => {
  const biddingPhase: DealPhase = {
    name: 'bidding',
    turn: 0,
    highBid: { seat: 1, amount: 50 },
    passed: [],
    firstTurnTaken: [1],
    excluded: [],
  };
  const bidHint = (over: Partial<Extract<ActionHint, { type: 'bid' }>> = {}): ActionHint[] => [
    {
      type: 'bid',
      min: 55,
      max: 440,
      step: 5,
      canPass: true,
      canDemandRedeal: false,
      forced: false,
      ...over,
    },
  ];

  it('passes a hopeless hand', () => {
    const junk: Card[] = ['H9', 'H8', 'H7', 'D9', 'D8', 'C9', 'C8', 'S9', 'S8'];
    const view = makeView(junk, biddingPhase, { bid: { seat: 1, amount: 50 }, declarer: null });
    expect(bot().onTurn(view, bidHint())).toEqual({ type: 'pass' });
  });

  it('bids the hinted minimum on a strong hand', () => {
    const strong: Card[] = ['HA', 'HK', 'HQ', 'H10', 'DA', 'D10', 'SA', 'CA', 'C10'];
    const view = makeView(strong, biddingPhase, { bid: { seat: 1, amount: 50 }, declarer: null });
    expect(bot().onTurn(view, bidHint())).toEqual({ type: 'bid', amount: 55 });
  });

  it('bids the forced opening even with junk', () => {
    const junk: Card[] = ['H9', 'H8', 'H7', 'D9', 'D8', 'C9', 'C8', 'S9', 'S8'];
    const view = makeView(junk, biddingPhase, { bid: null, declarer: null });
    const hints = bidHint({ min: 50, canPass: false, forced: true });
    expect(bot().onTurn(view, hints)).toEqual({ type: 'bid', amount: 50 });
  });

  it('passes under a bid ban (min > max) regardless of strength', () => {
    const strong: Card[] = ['HA', 'HK', 'HQ', 'H10', 'DA', 'D10', 'SA', 'CA', 'C10'];
    const view = makeView(strong, biddingPhase, { bid: { seat: 1, amount: 50 }, declarer: null });
    const hints = bidHint({ min: 55, max: 50 });
    expect(bot().onTurn(view, hints)).toEqual({ type: 'pass' });
  });

  it('bids braver at higher difficulty (easy folds a hand hard contests)', () => {
    // Clubs marriage (60) + the club ace (11) = strength 71: clears hard's
    // 55+12 threshold but not easy's fatter 55+30 cushion.
    const hand: Card[] = ['CK', 'CQ', 'CA', 'H9', 'H8', 'D9', 'D8', 'S9', 'S8'];
    const view = makeView(hand, biddingPhase, { bid: { seat: 1, amount: 50 }, declarer: null });
    const easy = new HeuristicBot(mulberry32(42), 'easy');
    const hard = new HeuristicBot(mulberry32(42), 'hard');
    expect(easy.onTurn(view, bidHint())).toEqual({ type: 'pass' });
    expect(hard.onTurn(view, bidHint())).toEqual({ type: 'bid', amount: 55 });
  });
});

describe('HeuristicBot trick play', () => {
  it('heads the trick minimally when the partner holds it', () => {
    const hand: Card[] = ['HA', 'H10', 'C6'];
    const view = makeView(hand, {
      name: 'follow',
      leader: 2,
      plays: [
        { seat: 2, card: 'HK' },
        { seat: 3, card: 'H9' },
      ],
    });
    const hints: ActionHint[] = [{ type: 'playCard', legal: ['HA', 'H10'] }];
    // Both legal cards head the partner's HK; the minimal winner is the 10.
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'H10' });
  });

  it('wins minimally over an opponent too', () => {
    const hand: Card[] = ['DA', 'D10', 'DK', 'C6'];
    const view = makeView(hand, {
      name: 'follow',
      leader: 1,
      plays: [{ seat: 1, card: 'DQ' }],
    });
    const hints: ActionHint[] = [{ type: 'playCard', legal: ['DA', 'D10', 'DK'] }];
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'DK' });
  });

  it('dumps the lowest-point card when it cannot win', () => {
    const hand: Card[] = ['C10', 'CJ', 'C7'];
    const view = makeView(hand, {
      name: 'follow',
      leader: 1,
      plays: [
        { seat: 1, card: 'SA' },
        { seat: 2, card: 'S6' },
      ],
    });
    // Void in spades, no trump set: everything is legal, nothing wins.
    const hints: ActionHint[] = [{ type: 'playCard', legal: hand }];
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'C7' });
  });

  it('smears points when the partner has the trick and it plays last', () => {
    const hand: Card[] = ['DA', 'D6'];
    const view = makeView(hand, {
      name: 'follow',
      leader: 1,
      plays: [
        { seat: 1, card: 'S9' },
        { seat: 2, card: 'SA' },
        { seat: 3, card: 'S6' },
      ],
    });
    const hints: ActionHint[] = [{ type: 'playCard', legal: hand }];
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'DA' });
  });

  it('saves undeclared marriage halves it fully holds', () => {
    const hand: Card[] = ['HK', 'HQ', 'H7'];
    const view = makeView(hand, { name: 'lead', leader: 0, canDeclare: false });
    const hints: ActionHint[] = [{ type: 'playCard', legal: hand }];
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'H7' });
  });
});

describe('HeuristicBot exchange', () => {
  it('gives aces and tens but never a half of its own complete marriage', () => {
    const hand: Card[] = ['HK', 'HQ', 'SA', 'S10', 'D7', 'D8', 'C6', 'C7', 'C8'];
    const view = makeView(hand, { name: 'exchangeGive' }, { declarer: 2 });
    const hints: ActionHint[] = [{ type: 'giveCards', count: 3 }];
    const action = bot().onTurn(view, hints);
    expect(action.type).toBe('giveCards');
    if (action.type !== 'giveCards') throw new Error('unreachable');
    expect(action.cards).toHaveLength(3);
    expect(action.cards).toContain('SA');
    expect(action.cards).toContain('S10');
    expect(action.cards).not.toContain('HK');
    expect(action.cards).not.toContain('HQ');
  });

  it('returns the lowest-point junk, keeping marriage halves', () => {
    const hand: Card[] = ['HA', 'H10', 'HK', 'HQ', 'DA', 'D10', 'C6', 'C7', 'C8', 'S6', 'SK', 'SQ'];
    const view = makeView(hand, { name: 'exchangeReturn' });
    const hints: ActionHint[] = [{ type: 'returnCards', count: 3 }];
    const action = bot().onTurn(view, hints);
    expect(action.type).toBe('returnCards');
    if (action.type !== 'returnCards') throw new Error('unreachable');
    expect([...action.cards].sort()).toEqual(['C6', 'C7', 'S6']);
  });

  it('sets a conservative contract from the 12-card hand', () => {
    // Strength: H marriage 100 + 4 aces 44 + 2 tens 20 + length bonus 5 = 169;
    // margin 20 => 145 (bid 50 raised in 5-steps, capped at 440).
    const hand: Card[] = ['HA', 'H10', 'HK', 'HQ', 'DA', 'D10', 'CA', 'SA', 'C6', 'C7', 'C8', 'S6'];
    const view = makeView(hand, { name: 'exchangeContract' });
    const hints: ActionHint[] = [{ type: 'setContract', min: 50, max: 440, step: 5 }];
    expect(bot().onTurn(view, hints)).toEqual({ type: 'setContract', amount: 145 });
  });
});
