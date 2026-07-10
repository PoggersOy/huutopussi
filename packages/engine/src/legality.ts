/**
 * Trick legality — the three pakko rules (plan.md fixed algorithm):
 * 1. Empty trick → whole hand.
 * 2. Hold led suit → must follow; within led suit must beat the current winner
 *    if possible (if the trick is already trumped no led-suit card can beat →
 *    any led-suit card). May NOT trump while holding the led suit.
 * 3. Void in led suit + trump exists → must trump; must overtrump if possible,
 *    else forced under-trump.
 * 4. Otherwise → any card.
 */
import { beats, makeCard, suitOf, winningPlay } from './deck.js';
import type { Card, Suit, TrickPlay } from './types.js';
import { SUITS } from './types.js';

/** The subset of `hand` legally playable to the trick-in-progress `plays`. */
export function legalPlays(
  hand: readonly Card[],
  plays: readonly TrickPlay[],
  trump: Suit | null,
): Card[] {
  const first = plays[0];
  if (!first) return [...hand];
  const led = suitOf(first.card);
  const winner = winningPlay(plays, trump).card;

  const ledCards = hand.filter((c) => suitOf(c) === led);
  if (ledCards.length > 0) {
    const heading = ledCards.filter((c) => beats(c, winner, led, trump));
    return heading.length > 0 ? heading : ledCards;
  }

  if (trump !== null) {
    const trumps = hand.filter((c) => suitOf(c) === trump);
    if (trumps.length > 0) {
      const over = trumps.filter((c) => beats(c, winner, led, trump));
      return over.length > 0 ? over : trumps;
    }
  }

  return [...hand];
}

/**
 * Suits whose marriage (K+Q both in `hand`) is still declarable, i.e. not in
 * `declaredSuits` (each suit may be declared trump at most once per deal).
 */
export function declarableSuits(hand: readonly Card[], declaredSuits: readonly Suit[]): Suit[] {
  return SUITS.filter(
    (s) =>
      !declaredSuits.includes(s) &&
      hand.includes(makeCard(s, 'K')) &&
      hand.includes(makeCard(s, 'Q')),
  );
}
