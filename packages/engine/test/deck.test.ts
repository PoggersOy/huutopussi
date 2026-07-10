import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type RuleConfig } from '../src/config.js';
import {
  beats,
  makeDeck,
  marriageValue,
  sortHand,
  sumCardPoints,
  winningPlay,
} from '../src/deck.js';
import type { Card, Suit, TrickPlay } from '../src/types.js';

const configA: RuleConfig = { ...DEFAULT_RULES, cardPoints: 'A', trumpValues: 'heartsHigh' };
const configB: RuleConfig = { ...DEFAULT_RULES, cardPoints: 'B', trumpValues: 'bridge' };

describe('makeDeck', () => {
  it('produces exactly 36 unique cards', () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(36);
    expect(new Set(deck).size).toBe(36);
  });
});

describe('card point totals over the full deck', () => {
  it('sums to 120 with system A', () => {
    expect(sumCardPoints(makeDeck(), configA)).toBe(120);
  });

  it('sums to 140 with system B', () => {
    expect(sumCardPoints(makeDeck(), configB)).toBe(140);
  });
});

describe('marriageValue', () => {
  it('follows heartsHigh ordering (♥100 ♦80 ♣60 ♠40)', () => {
    const expected: Record<Suit, number> = { H: 100, D: 80, C: 60, S: 40 };
    for (const [suit, value] of Object.entries(expected)) {
      expect(marriageValue(suit as Suit, configA)).toBe(value);
    }
  });

  it('follows bridge ordering (♠100 ♥80 ♦60 ♣40)', () => {
    const expected: Record<Suit, number> = { S: 100, H: 80, D: 60, C: 40 };
    for (const [suit, value] of Object.entries(expected)) {
      expect(marriageValue(suit as Suit, configB)).toBe(value);
    }
  });
});

describe('beats', () => {
  it('ranks the 10 above the king within a suit', () => {
    expect(beats('H10', 'HK', 'H', null)).toBe(true);
    expect(beats('HK', 'H10', 'H', null)).toBe(false);
    expect(beats('HA', 'H10', 'H', null)).toBe(true);
  });

  it('lets any trump beat any non-trump', () => {
    expect(beats('S6', 'HA', 'H', 'S')).toBe(true);
    expect(beats('HA', 'S6', 'H', 'S')).toBe(false);
  });

  it('compares trumps by rank when both are trump', () => {
    expect(beats('S10', 'SK', 'H', 'S')).toBe(true);
    expect(beats('S7', 'SJ', 'H', 'S')).toBe(false);
  });

  it('never lets an off-lead non-trump card win', () => {
    expect(beats('DA', 'H6', 'H', null)).toBe(false);
    expect(beats('DA', 'H6', 'H', 'C')).toBe(false);
  });
});

describe('winningPlay', () => {
  const trick = (...cards: Card[]): TrickPlay[] =>
    cards.map((card, i) => ({ seat: (i % 4) as TrickPlay['seat'], card }));

  it('awards the trick to the highest led-suit card without trump', () => {
    const plays = trick('HK', 'H10', 'DA', 'H9');
    expect(winningPlay(plays, null).card).toBe('H10');
  });

  it('lets the lowest trump beat the ace of the led suit', () => {
    const plays = trick('HA', 'S6', 'H10', 'HK');
    expect(winningPlay(plays, 'S').card).toBe('S6');
  });

  it('picks the highest trump when several are played', () => {
    const plays = trick('H9', 'S7', 'S10', 'SA');
    expect(winningPlay(plays, 'S').card).toBe('SA');
  });

  it('throws on an empty trick', () => {
    expect(() => winningPlay([], null)).toThrow();
  });
});

describe('sortHand', () => {
  it('sorts suit-major (H D C S) and high→low within each suit', () => {
    const hand: Card[] = ['S6', 'HK', 'D9', 'H10', 'CA', 'HA', 'SQ', 'C7', 'D10'];
    expect(sortHand(hand)).toEqual(['HA', 'H10', 'HK', 'D10', 'D9', 'CA', 'C7', 'SQ', 'S6']);
  });

  it('does not mutate its input', () => {
    const hand: Card[] = ['S6', 'HA'];
    sortHand(hand);
    expect(hand).toEqual(['S6', 'HA']);
  });
});
