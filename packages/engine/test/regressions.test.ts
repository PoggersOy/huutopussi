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

describe('regression: minBid that is not a bidStep multiple (config patch, e.g. 52)', () => {
  /**
   * BUG (found by exhaustive hint/validate probing, fixed in validate.ts):
   * the lobby config patch admits any integer minBid 0–200 while bidStep is
   * fixed at 5, and validate.ts used raw cfg.minBid as the forced-opening
   * amount and as the bid-hint minimum. With { minBid: 52 } the forced
   * opener's hint advertised min=52/step=5, but EVERY amount in
   * {52, 57, 62, …} failed the bidStep-multiple check (error.bidNotMultiple)
   * while pass stayed forbidden (error.forcedOpening) — violating the
   * "accepted actions == hints" invariant and wedging every hint-driven
   * client/bot. Worse, a bid-BANNED forced opener's only ban exemption was
   * amount === cfg.minBid (52), itself rejected as a non-multiple, and with a
   * non-redeal-eligible hand the seat had ZERO legal actions: the deal
   * soft-locked permanently. minBid is now rounded UP to the next bidStep
   * multiple (52 → 55) everywhere it acts as a bid/contract amount
   * (rules doc §5.2: all bids are multiples of five).
   */
  const CONFIG: RuleConfig = { ...DEFAULT_RULES, minBid: 52 };

  /** Fresh deal (canonical deck, dealer 0 → forced opener seat 1). */
  function fresh(scores: [number, number]): MatchState {
    const base = initialMatchState(CONFIG, 0);
    const state = { ...base, scores };
    return applyEvent(state, nextDealEvent(state, makeDeck()));
  }

  it('forced opener hint min is the rounded-up multiple 55, and bidding it is legal', () => {
    let state = fresh([0, 0]);
    expect(allowedActions(state, 1)).toEqual([
      {
        type: 'bid',
        min: 55,
        max: 440,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);

    // The raw configured minimum stays illegal (not a multiple of 5)…
    const raw = validateAction(state, 1, { type: 'bid', amount: 52 });
    expect(isRuleError(raw) && raw.code === 'error.bidNotMultiple').toBe(true);
    // …50 is below the effective minimum…
    const low = validateAction(state, 1, { type: 'bid', amount: 50 });
    expect(isRuleError(low) && low.code === 'error.bidTooLow' && low.params?.min === 55).toBe(true);
    // …pass reports the effective minimum…
    const pass = validateAction(state, 1, { type: 'pass' });
    expect(
      isRuleError(pass) && pass.code === 'error.forcedOpening' && pass.params?.min === 55,
    ).toBe(true);
    // …and the hint minimum itself is accepted (accepted actions == hints).
    state = apply(state, 1, { type: 'bid', amount: 55 });
    expect(state.deal?.phase).toMatchObject({ name: 'bidding', highBid: { seat: 1, amount: 55 } });
  });

  it('a bid-banned forced opener has exactly one legal action — bid 55 (no soft-lock)', () => {
    // Side 1 (seats 1+3) at the bid-ban threshold; seat 1 must open and its
    // hand (all diamonds) is not redeal-eligible.
    let state = fresh([0, -500]);
    expect(expectedActor(state)).toBe(1);
    expect(allowedActions(state, 1)).toEqual([
      {
        type: 'bid',
        min: 55,
        max: 55,
        step: 5,
        canPass: false,
        canDemandRedeal: false,
        forced: true,
      },
    ]);

    // Exhaustive probe: among pass/redeal/all bid amounts, only bid 55 is legal.
    const legalAmounts: number[] = [];
    for (let amount = 0; amount <= 600; amount++) {
      if (!isRuleError(validateAction(state, 1, { type: 'bid', amount }))) {
        legalAmounts.push(amount);
      }
    }
    expect(legalAmounts).toEqual([55]);
    expect(isRuleError(validateAction(state, 1, { type: 'pass' }))).toBe(true);
    expect(isRuleError(validateAction(state, 1, { type: 'demandRedeal' }))).toBe(true);

    // The deal proceeds: everyone passes, the banned opener wins at 55.
    state = apply(state, 1, { type: 'bid', amount: 55 });
    state = apply(state, 2, { type: 'pass' });
    state = apply(state, 3, { type: 'pass' });
    state = apply(state, 0, { type: 'pass' });
    expect(state.deal?.declarer).toBe(1);
    expect(state.deal?.bid).toEqual({ seat: 1, amount: 55 });
    expect(state.deal?.phase).toEqual({ name: 'exchangeGive' });
  });
});
