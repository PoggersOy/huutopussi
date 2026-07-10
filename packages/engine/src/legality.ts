/**
 * Trick legality — the three pakko rules (plan.md fixed algorithm):
 * 1. Empty trick → whole hand (first-trick 'aceShow' leads: an ace if held,
 *    else a spade if held, else anything).
 * 2. Hold led suit → must follow; within led suit must beat the current winner
 *    if possible (if the trick is already trumped no led-suit card can beat →
 *    any led-suit card). May NOT trump while holding the led suit.
 *    First-trick 'aceShow': when the led card is not an ace, the holder of the
 *    led suit's ace must play exactly it ("ässän pitää näkyä").
 * 3. Void in led suit + trump exists → must trump; must overtrump if possible,
 *    else forced under-trump.
 * 4. Otherwise → any card.
 *
 * `firstTrickRules` must be 'aceShow' ONLY for plays into the very first trick
 * of a deal (no trump can exist then, so the rules never interact).
 */
import { beats, makeCard, rankOf, suitOf, winningPlay } from './deck.js';
import type { Card, Suit, TrickPlay } from './types.js';
import { SUITS } from './types.js';

/** The subset of `hand` legally playable to the trick-in-progress `plays`. */
export function legalPlays(
  hand: readonly Card[],
  plays: readonly TrickPlay[],
  trump: Suit | null,
  firstTrickRules: 'aceShow' | 'free' = 'free',
): Card[] {
  const first = plays[0];
  if (!first) {
    if (firstTrickRules === 'aceShow') {
      const aces = hand.filter((c) => rankOf(c) === 'A');
      if (aces.length > 0) return aces;
      const spades = hand.filter((c) => suitOf(c) === 'S');
      if (spades.length > 0) return spades;
    }
    return [...hand];
  }
  const led = suitOf(first.card);

  if (firstTrickRules === 'aceShow' && rankOf(first.card) !== 'A') {
    const ledAce = makeCard(led, 'A');
    if (hand.includes(ledAce)) return [ledAce];
  }

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
