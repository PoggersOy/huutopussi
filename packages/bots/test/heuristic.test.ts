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
  ILLISOFT_RULES,
  initialMatchState,
  isRuleError,
  makeDeck,
  nextDealEvent,
  type PlayerView,
  type RuleConfig,
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
  for (const [level, players, budget] of [
    ['easy', 4, 300],
    ['hard', 3, 300],
    ['expert', 4, 120],
    ['expert', 3, 120],
    ['expert', 2, 120],
  ] as const) {
    it(`${level} picks hinted-legal actions (${players}p, ${budget} turns)`, () => {
      const config: RuleConfig = { ...ILLISOFT_RULES, players, talonSize: 3 };
      const deck = makeDeck();
      const rng = mulberry32(0xc0de + players);
      let state = initialMatchState(config, 0);
      const bots = SEATS.slice(0, players).map((s) => new HeuristicBot(mulberry32(s + 1), level));
      let turns = 0;
      for (let guard = 0; turns < budget && state.winnerSide === null && guard < 20_000; guard++) {
        const actor = expectedActor(state);
        if (actor === null) {
          state = applyEvent(state, nextDealEvent(state, shuffle(rng, deck)));
          continue;
        }
        for (const s of SEATS.slice(0, players)) {
          if (s !== actor) (bots[s] as HeuristicBot).observe(redactViewFor(state, s));
        }
        const hints = allowedActions(state, actor);
        const action = (bots[actor] as HeuristicBot).onTurn(redactViewFor(state, actor), hints);
        const res = validateAction(state, actor, action);
        if (isRuleError(res)) throw new Error(`illegal ${JSON.stringify(action)} (${res.code})`);
        turns++;
        for (const ev of res) state = applyEvent(state, ev);
      }
      expect(turns).toBeGreaterThan(0);
    });
  }

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

  it('calibrated levels bid a dominant hand and pass junk', () => {
    const strong: Card[] = ['HA', 'HK', 'HQ', 'H10', 'DA', 'D10', 'SA', 'CA', 'C10'];
    const junk: Card[] = ['H9', 'H8', 'H7', 'D9', 'D8', 'C9', 'C8', 'S9', 'S8'];
    for (const level of ['medium', 'hard', 'expert'] as const) {
      const b = new HeuristicBot(mulberry32(42), level);
      const strongView = makeView(strong, biddingPhase, { bid: null, declarer: null });
      const junkView = makeView(junk, biddingPhase, { bid: null, declarer: null });
      expect(b.onTurn(strongView, bidHint())).toEqual({ type: 'bid', amount: 55 });
      expect(b.onTurn(junkView, bidHint())).toEqual({ type: 'pass' });
    }
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
    // The ten is not a master (the diamond ace is out), so it goes on the
    // partner's sure trick; a master ace would be kept to win a trick itself.
    const hand: Card[] = ['D10', 'D6'];
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
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'D10' });
  });

  it('keeps a master ace instead of smearing it', () => {
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
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'D6' });
  });

  it('leads a safe master instead of junk', () => {
    // Spade ace already played: the spade ten is the master and nobody has
    // shown a void, so it is cashed rather than leading the low club.
    const hand: Card[] = ['S10', 'C7', 'C8'];
    const view = makeView(
      hand,
      { name: 'lead', leader: 0, canDeclare: false },
      {
        tricksPlayed: 1,
        handCounts: { 0: 3, 1: 3, 2: 3, 3: 3 },
        lastTrick: {
          plays: [
            { seat: 0, card: 'SA' },
            { seat: 1, card: 'S9' },
            { seat: 2, card: 'S8' },
            { seat: 3, card: 'S7' },
          ],
          winner: 0,
        },
      },
    );
    const hints: ActionHint[] = [{ type: 'playCard', legal: hand }];
    expect(sharpBot().onTurn(view, hints)).toEqual({ type: 'playCard', card: 'S10' });
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

  it('easy sets a naive conservative contract from the 12-card hand', () => {
    // Strength: H marriage 100 + 4 aces 44 + 2 tens 20 + length bonus 5 = 169;
    // easy's margin 40 => 129, floored to the 5-step 125.
    const hand: Card[] = ['HA', 'H10', 'HK', 'HQ', 'DA', 'D10', 'CA', 'SA', 'C6', 'C7', 'C8', 'S6'];
    const view = makeView(hand, { name: 'exchangeContract' });
    const hints: ActionHint[] = [{ type: 'setContract', min: 50, max: 440, step: 5 }];
    const easy = new HeuristicBot(mulberry32(42), 'easy');
    expect(easy.onTurn(view, hints)).toEqual({ type: 'setContract', amount: 125 });
  });

  it('calibrated contracts rise with the hand and respect the floor', () => {
    const strong: Card[] = [
      'HA',
      'H10',
      'HK',
      'HQ',
      'DA',
      'D10',
      'CA',
      'SA',
      'C6',
      'C7',
      'C8',
      'S6',
    ];
    const weak: Card[] = ['H6', 'H7', 'H8', 'D6', 'D7', 'D8', 'C6', 'C7', 'C8', 'S6', 'S7', 'SJ'];
    const hints: ActionHint[] = [{ type: 'setContract', min: 50, max: 440, step: 5 }];
    const amount = (hand: Card[]): number => {
      const action = sharpBot().onTurn(makeView(hand, { name: 'exchangeContract' }), hints);
      if (action.type !== 'setContract') throw new Error('expected a contract');
      return action.amount;
    };
    expect(amount(strong)).toBeGreaterThan(amount(weak));
    expect(amount(weak)).toBe(50);
    expect(amount(strong) % 5).toBe(0);
  });
});
