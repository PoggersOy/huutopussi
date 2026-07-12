/**
 * Learning-scenario integrity + winnability.
 *
 *  1. Every scenario deck is a valid 36-card permutation (a typo in a hand
 *     fails here, not at runtime with a broken deal).
 *  2. Every puzzle is WINNABLE: a greedy "optimal-ish" human, playing against
 *     the shipped teaching opponent, meets the puzzle's goal. The tutorial just
 *     has to reach a scored deal. This runs the real @hp/engine synchronously
 *     (no timers), exactly like localMatch.ts drives it.
 */
import {
  type ActionHint,
  allowedActions,
  applyEvent,
  type Card,
  expectedActor,
  initialMatchState,
  isRuleError,
  type MatchState,
  makeDeck,
  nextDealEvent,
  type PlayerAction,
  type PlayerView,
  rankIndex,
  rankOf,
  redactViewFor,
  sideOf,
  validateAction,
} from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { teachAction } from '../src/localMatch';
import { SCENARIOS, type Scenario } from '../src/scenarios';

/** Weakest-first (A=0 … 6=8 ⇒ larger index = weaker). */
const byWeakest = (a: Card, b: Card): number => rankIndex(rankOf(b)) - rankIndex(rankOf(a));
const strongest = (cards: readonly Card[]): Card =>
  [...cards].sort((a, b) => rankIndex(rankOf(a)) - rankIndex(rankOf(b)))[0] as Card;

/** A greedy human: bid, declare marriages, keep strong cards, play strongest. */
function greedyHuman(view: PlayerView, hints: ActionHint[]): PlayerAction {
  const hand: readonly Card[] = view.deal?.hand ?? [];
  for (const h of hints) if (h.type === 'bid') return { type: 'bid', amount: h.min };
  for (const h of hints) {
    if (h.type === 'declaration' && h.ownSuits.length > 0) {
      return { type: 'declareOwn', suit: h.ownSuits[0] as (typeof h.ownSuits)[number] };
    }
  }
  for (const h of hints) {
    if (h.type === 'giveCards')
      return { type: 'giveCards', cards: [...hand].sort(byWeakest).slice(0, h.count) };
    if (h.type === 'returnCards')
      return { type: 'returnCards', cards: [...hand].sort(byWeakest).slice(0, h.count) };
    if (h.type === 'discardCards')
      return { type: 'discardCards', cards: [...h.legal].sort(byWeakest).slice(0, h.count) };
    if (h.type === 'setContract') return { type: 'setContract', amount: h.min };
    if (h.type === 'answerWhole') {
      const s = h.suits[0];
      if (s !== undefined) return { type: 'answerWhole', suit: s };
    }
  }
  const play = hints.find(
    (h): h is Extract<ActionHint, { type: 'playCard' }> => h.type === 'playCard',
  );
  if (play !== undefined) return { type: 'playCard', card: strongest(play.legal) };
  throw new Error(`greedyHuman: no move in ${JSON.stringify(hints)}`);
}

/** Play a scenario to its scored deal; return the final state (or throw). */
function playOut(sc: Scenario): MatchState {
  let state = initialMatchState(sc.config, sc.firstDealer);
  state = applyEvent(state, nextDealEvent(state, sc.deck));
  for (let guard = 0; guard < 400; guard++) {
    if (state.winnerSide !== null) return state;
    if (state.deal !== null && state.deal.phase.name === 'scored') return state;
    const actor = expectedActor(state);
    if (actor === null) throw new Error('no actor but deal not scored');
    const view = redactViewFor(state, actor);
    const hints = allowedActions(state, actor);
    const action = actor === sc.humanSeat ? greedyHuman(view, hints) : teachAction(view, hints);
    const res = validateAction(state, actor, action);
    if (isRuleError(res)) throw new Error(`illegal ${action.type} by seat ${actor}: ${res.code}`);
    for (const e of res) state = applyEvent(state, e);
  }
  throw new Error('scenario did not settle within the step cap');
}

describe('learning scenarios', () => {
  const canonical = [...makeDeck()].sort();

  for (const sc of SCENARIOS) {
    it(`${sc.id}: deck is a valid 36-card permutation`, () => {
      expect(sc.deck).toHaveLength(36);
      expect([...sc.deck].sort()).toEqual(canonical);
    });
  }

  for (const sc of SCENARIOS) {
    it(`${sc.id}: plays out to a scored deal`, () => {
      const state = playOut(sc);
      const deal = state.deal;
      expect(deal?.phase.name === 'scored' || state.winnerSide !== null).toBe(true);
    });
  }

  for (const sc of SCENARIOS.filter((s) => s.goal !== undefined)) {
    it(`${sc.id}: is winnable by optimal play`, () => {
      const state = playOut(sc);
      const deal = state.deal;
      if (deal === null || deal.phase.name !== 'scored') throw new Error('deal not scored');
      const humanSide = sideOf(sc.humanSeat, sc.config.players);
      const won = sc.goal?.(deal.phase.result, humanSide);
      expect(won).toBe(true);
    });
  }
});
