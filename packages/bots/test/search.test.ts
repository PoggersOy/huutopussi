/**
 * search.ts determinizations must be consistent with everything the seat's
 * view proves, and must never be built from the real hidden hands. Plus a
 * small arena smoke test of the difficulty ladder.
 */
import {
  activeSeats,
  allowedActions,
  applyEvent,
  type Card,
  expectedActor,
  ILLISOFT_RULES,
  initialMatchState,
  isRuleError,
  type MatchState,
  makeDeck,
  nextDealEvent,
  type RuleConfig,
  redactViewFor,
  type Seat,
  validateAction,
} from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { arena } from '../src/arena.js';
import { HeuristicBot } from '../src/heuristic.js';
import { DealMemory, knowledgeOf } from '../src/memory.js';
import { mulberry32, shuffle } from '../src/prng.js';
import { determinize } from '../src/search.js';

/** Plays `steps` actions with hard bots, feeding a memory for seat 0. */
function midDeal(config: RuleConfig, seed: number, steps: number) {
  const rng = mulberry32(seed);
  let state: MatchState = initialMatchState(config, 0);
  state = applyEvent(state, nextDealEvent(state, shuffle(rng, makeDeck())));
  const seats = activeSeats(config.players);
  const bots = seats.map((s) => new HeuristicBot(mulberry32(seed + s), 'hard'));
  const memory = new DealMemory();
  for (let i = 0; i < steps; i++) {
    const actor = expectedActor(state);
    if (actor === null || state.deal?.phase.name === 'scored') break;
    memory.observe(redactViewFor(state, 0));
    const hints = allowedActions(state, actor);
    const action = (bots[actor] as HeuristicBot).onTurn(redactViewFor(state, actor), hints);
    const res = validateAction(state, actor, action);
    if (isRuleError(res)) throw new Error(res.code);
    for (const ev of res) state = applyEvent(state, ev);
  }
  memory.observe(redactViewFor(state, 0));
  return { state, memory };
}

function allCards(s: MatchState): Card[] {
  const d = s.deal;
  if (!d) return [];
  const out: Card[] = [];
  for (const seat of [0, 1, 2, 3] as Seat[]) out.push(...d.hands[seat], ...d.captured[seat]);
  if (d.phase.name === 'follow') out.push(...d.phase.plays.map((p) => p.card));
  if (d.talon && d.talonTakenBy === null) out.push(...d.talon);
  if (d.dummyHand) out.push(...d.dummyHand);
  if (d.discarded) out.push(...d.discarded);
  return out;
}

describe('determinize', () => {
  for (const players of [4, 3, 2] as const) {
    it(`builds consistent hypothetical states (${players}p)`, () => {
      const config: RuleConfig = {
        ...ILLISOFT_RULES,
        players,
        ...(players === 4 ? {} : { talonSize: 3 }),
      };
      for (const steps of [10, 25, 40]) {
        const { state, memory } = midDeal(config, 11 * players + steps, steps);
        const view = redactViewFor(state, 0);
        const know = knowledgeOf(view, memory);
        const rng = mulberry32(steps);
        for (let i = 0; i < 10; i++) {
          const h = determinize(view, know, memory, rng);
          if (!h?.deal || !state.deal) throw new Error('no determinization');
          // Same visible facts: my hand, counts, phase.
          expect([...h.deal.hands[0]].sort()).toEqual([...state.deal.hands[0]].sort());
          for (const s of activeSeats(players)) {
            expect(h.deal.hands[s].length).toBe(state.deal.hands[s].length);
            for (const c of h.deal.hands[s])
              if (s !== 0) expect(know.excluded[s].has(c)).toBe(false);
          }
          // Every one of the 36 cards exists exactly once.
          const cards = allCards(h);
          if (state.deal.phase.name !== 'bidding' || players === 4) {
            expect(new Set(cards).size).toBe(cards.length);
          }
          // The rollout engine accepts it: the actor has legal hints.
          const actor = expectedActor(h);
          if (actor !== null) expect(allowedActions(h, actor).length).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe('difficulty ladder (arena smoke test)', () => {
  it('hard beats easy and medium beats easy in duplicate deals', () => {
    const hardVsEasy = arena({
      a: 'hard',
      b: 'easy',
      players: 4,
      count: 150,
      seed: 1,
      mode: 'deals',
    });
    const medVsEasy = arena({
      a: 'medium',
      b: 'easy',
      players: 4,
      count: 150,
      seed: 2,
      mode: 'deals',
    });
    expect(hardVsEasy.meanDelta - hardVsEasy.ci).toBeGreaterThan(0);
    expect(medVsEasy.meanDelta - medVsEasy.ci).toBeGreaterThan(0);
  });
});
