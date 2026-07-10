/**
 * Regression suite for bugs found by the fuzz/simulation gate (packages/bots,
 * `pnpm sim`) and by its exhaustive hint/validate probing. One test per bug;
 * each carries the reproduction (sim seed, or the minimized action sequence)
 * in its comment.
 */
import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../src/config.js';
import { DEFAULT_RULES, theoreticalMaxPoints } from '../src/config.js';
import { makeDeck } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import type { Card, MatchState, PlayerAction, Seat } from '../src/types.js';
import { isRuleError } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';

function apply(state: MatchState, seat: Seat, action: PlayerAction): MatchState {
  const res = validateAction(state, seat, action);
  if (isRuleError(res)) {
    throw new Error(`unexpected RuleError ${res.code} for seat ${seat} ${JSON.stringify(action)}`);
  }
  let next = state;
  for (const e of res) next = applyEvent(next, e);
  return next;
}

describe('regression: contract soft-lock at winning bids above theoreticalMaxPoints', () => {
  /**
   * BUG (found by P2 gate audit / hint-probe reasoning, fixed in validate.ts):
   * with DEFAULT_RULES (cardPoints 'A'), maxBid 440 > theoreticalMaxPoints 410,
   * but maxContractOf capped contracts at min(maxBid, theoreticalMax) = 410.
   * A declarer who won the auction at 415–440 was left with min = winning bid
   * > max = 410 — no legal setContract amount — and the deal soft-locked in
   * exchangeContract forever (a termination failure). Rules doc §5.3 only
   * requires the contract to be a bidStep multiple at least the winning bid,
   * so the contract cap must track the bid cap.
   */
  it('a 440 winning bid yields a usable setContract hint and accepts 440', () => {
    expect(theoreticalMaxPoints(DEFAULT_RULES)).toBe(410);

    // Canonical deck: seat 1 holds all diamonds, seat 3 all spades; dealer 0.
    let state = initialMatchState(DEFAULT_RULES, 0);
    state = applyEvent(state, nextDealEvent(state, makeDeck()));

    // Seat 1 (forced opener) bids maxBid → instant biddingEnded, declarer 1.
    state = apply(state, 1, { type: 'bid', amount: 440 });
    expect(state.deal?.phase.name).toBe('exchangeGive');
    state = apply(state, 3, { type: 'giveCards', cards: ['SA', 'S10', 'SK'] });

    // The hint range must be non-empty (min <= max) — this is the soft-lock.
    expect(expectedActor(state)).toBe(1);
    expect(allowedActions(state, 1)).toEqual([
      { type: 'setContract', min: 440, max: 440, step: 5 },
    ]);

    state = apply(state, 1, { type: 'setContract', amount: 440 });
    expect(state.deal?.contract).toBe(440);
    expect(state.deal?.phase.name).toBe('exchangeReturn');

    // Above the bid cap stays illegal.
    const tooHigh = validateAction(state, 1, { type: 'setContract', amount: 445 });
    expect(isRuleError(tooHigh)).toBe(true);
  });

  it('with maxBid null the contract cap follows the theoretical bid cap', () => {
    const config: RuleConfig = { ...DEFAULT_RULES, maxBid: null };
    let state = initialMatchState(config, 0);
    state = applyEvent(state, nextDealEvent(state, makeDeck()));

    state = apply(state, 1, { type: 'bid', amount: 410 }); // = theoreticalMaxPoints
    state = apply(state, 2, { type: 'pass' });
    state = apply(state, 3, { type: 'pass' });
    state = apply(state, 0, { type: 'pass' });
    expect(state.deal?.declarer).toBe(1);

    const give: Card[] = ['SA', 'S10', 'SK'];
    state = apply(state, 3, { type: 'giveCards', cards: give });
    expect(allowedActions(state, 1)).toEqual([
      { type: 'setContract', min: 410, max: 410, step: 5 },
    ]);
    const tooHigh = validateAction(state, 1, { type: 'setContract', amount: 415 });
    expect(isRuleError(tooHigh)).toBe(true);
    state = apply(state, 1, { type: 'setContract', amount: 410 });
    expect(state.deal?.contract).toBe(410);
  });
});
