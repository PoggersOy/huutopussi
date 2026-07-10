/**
 * Frozen engine contract — see CLAUDE.md.
 * Card primitives: deck construction, ordering, point values, trick resolution.
 * Pure functions only; no randomness (shuffles happen outside the engine and
 * arrive as the `deck` payload of the dealStarted event).
 */
import type { RuleConfig } from './config.js';
import { RANKS, SUITS } from './types.js';
import type { Card, Rank, Suit, TrickPlay } from './types.js';

export function suitOf(card: Card): Suit {
  return card[0] as Suit;
}

export function rankOf(card: Card): Rank {
  return card.slice(1) as Rank;
}

export function makeCard(suit: Suit, rank: Rank): Card {
  return `${suit}${rank}`;
}

/** All 36 cards in a canonical order (suit-major, high→low). */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(makeCard(s, r));
  return deck;
}

/** Lower index = stronger. A=0, 10=1, K=2, Q=3, J=4, 9=5 … 6=8. */
export function rankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

/** True if `a` outranks `b` within the same suit. */
export function outranks(a: Card, b: Card): boolean {
  return rankIndex(rankOf(a)) < rankIndex(rankOf(b));
}

export function cardPoints(card: Card, config: RuleConfig): number {
  const r = rankOf(card);
  if (config.cardPoints === 'A') {
    switch (r) {
      case 'A':
        return 11;
      case '10':
        return 10;
      case 'K':
        return 4;
      case 'Q':
        return 3;
      case 'J':
        return 2;
      default:
        return 0;
    }
  }
  switch (r) {
    case 'A':
    case '10':
      return 10;
    case 'K':
    case 'Q':
    case 'J':
      return 5;
    default:
      return 0;
  }
}

export function sumCardPoints(cards: readonly Card[], config: RuleConfig): number {
  return cards.reduce((acc, c) => acc + cardPoints(c, config), 0);
}

export function marriageValue(suit: Suit, config: RuleConfig): number {
  const heartsHigh: Record<Suit, number> = { H: 100, D: 80, C: 60, S: 40 };
  const bridge: Record<Suit, number> = { S: 100, H: 80, D: 60, C: 40 };
  return (config.trumpValues === 'heartsHigh' ? heartsHigh : bridge)[suit];
}

/**
 * True if card `a` beats card `b` in a trick, given the led suit and trump.
 * A trump beats any non-trump; within a suit, rank decides; off-suit
 * non-trump cards beat nothing.
 */
export function beats(a: Card, b: Card, ledSuit: Suit, trump: Suit | null): boolean {
  const sa = suitOf(a);
  const sb = suitOf(b);
  if (trump !== null) {
    if (sa === trump && sb !== trump) return true;
    if (sa !== trump && sb === trump) return false;
    if (sa === trump && sb === trump) return outranks(a, b);
  }
  if (sa !== sb) return false; // neither is trump here; off-lead cards never win
  if (sa !== ledSuit) return false;
  return outranks(a, b);
}

/** The play currently winning a (non-empty) trick. */
export function winningPlay(plays: readonly TrickPlay[], trump: Suit | null): TrickPlay {
  if (plays.length === 0) throw new Error('winningPlay: empty trick');
  const first = plays[0] as TrickPlay;
  const ledSuit = suitOf(first.card);
  let best = first;
  for (const p of plays.slice(1)) {
    if (beats(p.card, best.card, ledSuit, trump)) best = p;
  }
  return best;
}

/** Sort for hand display: suit-major (H D C S), high→low within suit. */
export function sortHand(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const si = SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b));
    if (si !== 0) return si;
    return rankIndex(rankOf(a)) - rankIndex(rankOf(b));
  });
}
