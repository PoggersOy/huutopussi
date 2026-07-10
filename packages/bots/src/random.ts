/**
 * RandomLegalBot — the fuzzing workhorse. Picks uniformly among the options
 * offered by the hints, with just enough bidding shape to exercise auctions:
 * it passes when allowed, makes the minimum bid when forced, and occasionally
 * (~20%) raises minimally when not forced. Consumes ONLY PlayerView + hints.
 */
import type { ActionHint, Card, PlayerAction, PlayerView } from '@hp/engine';
import type { Actor } from './actor.js';
import { type Prng, pick, pickIndex, sample } from './prng.js';

/** Chance to raise minimally instead of passing when a raise is possible. */
const RAISE_PROB = 0.2;
/** Chance to demand a redeal when the hand qualifies (exercises the path). */
const REDEAL_PROB = 0.25;

type BidHint = Extract<ActionHint, { type: 'bid' }>;
type ContractHint = Extract<ActionHint, { type: 'setContract' }>;

export class RandomLegalBot implements Actor {
  private readonly rng: Prng;

  constructor(rng: Prng) {
    this.rng = rng;
  }

  onTurn(view: PlayerView, hints: ActionHint[]): PlayerAction {
    const hand: readonly Card[] = view.deal?.hand ?? [];

    for (const hint of hints) {
      switch (hint.type) {
        case 'bid':
          return this.bidAction(hint);
        case 'giveCards':
          return { type: 'giveCards', cards: sample(this.rng, hand, hint.count) };
        case 'setContract':
          return { type: 'setContract', amount: this.contractAmount(hint) };
        case 'returnCards':
          return { type: 'returnCards', cards: sample(this.rng, hand, hint.count) };
        case 'answerWhole':
          return { type: 'answerWhole', suit: pick(this.rng, hint.suits) };
        default:
          break;
      }
    }

    // Lead/follow turn: uniform over declaration options + legal cards.
    const options: PlayerAction[] = [];
    for (const hint of hints) {
      if (hint.type === 'declaration') {
        for (const suit of hint.ownSuits) options.push({ type: 'declareOwn', suit });
        if (hint.canAskWhole) options.push({ type: 'askWhole' });
        for (const ha of hint.halfAsks) {
          options.push({ type: 'askHalf', suit: ha.suit, rankHeld: ha.rankHeld });
        }
      } else if (hint.type === 'playCard') {
        for (const card of hint.legal) options.push({ type: 'playCard', card });
      }
    }
    if (options.length === 0) {
      throw new Error(`RandomLegalBot: no options in hints ${JSON.stringify(hints)}`);
    }
    return pick(this.rng, options);
  }

  private bidAction(hint: BidHint): PlayerAction {
    if (hint.canDemandRedeal && this.rng() < REDEAL_PROB) return { type: 'demandRedeal' };
    const canBid = hint.min <= hint.max; // min > max signals "no legal bid" (bid ban)
    if (!hint.canPass) return { type: 'bid', amount: hint.min };
    if (canBid && this.rng() < RAISE_PROB) return { type: 'bid', amount: hint.min };
    return { type: 'pass' };
  }

  /** Mostly the minimum (bids are usually honoured as-is); sometimes higher. */
  private contractAmount(hint: ContractHint): number {
    const span = Math.floor((hint.max - hint.min) / hint.step);
    let steps = 0;
    if (span > 0) {
      const r = this.rng();
      if (r >= 0.95) {
        steps = pickIndex(this.rng, span + 1); // occasionally anywhere in range
      } else if (r >= 0.7) {
        steps = 1 + pickIndex(this.rng, Math.min(4, span)); // small raise
      }
    }
    return hint.min + steps * hint.step;
  }
}
