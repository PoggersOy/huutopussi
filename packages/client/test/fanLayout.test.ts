/**
 * Hand-fan geometry: every card keeps a readable, tappable strip at any hand
 * size on the narrowest supported phone, and the fan uses the width it has.
 */
import type { Card } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import {
  layoutFan,
  MAX_STEP,
  MIN_STEP,
  MIN_STEP_PX,
  splitIndex,
} from '../src/screens/table/fanLayout';

const SUITS = ['H', 'D', 'C', 'S'] as const;
const RANKS = ['A', '10', 'K', 'Q', 'J', '9', '8', '7', '6'] as const;
/** A sorted hand of `n` cards spread over the suits, like a real deal. */
function hand(n: number): Card[] {
  const all = SUITS.flatMap((s) => RANKS.map((r) => `${s}${r}` as Card));
  const picked = all.filter((_, i) => i % 3 !== 2).slice(0, n);
  return picked.length === n ? picked : all.slice(0, n);
}

/** Visible strip width of each card: distance to the next card on top of it in the same row. */
function strips(cards: Card[], width: number, cardW: number): number[] {
  const { slots } = layoutFan(cards, width, cardW);
  const out: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const next = slots[i + 1];
    if (s === undefined) continue;
    out.push(next !== undefined && next.row === s.row ? next.x - s.x : cardW);
  }
  return out;
}

describe('layoutFan', () => {
  // (container width, resolved --card-w) pairs for 320 / 390 / 430 px phones.
  const PHONES: [number, number][] = [
    [304, 54],
    [374, 66],
    [414, 73],
  ];

  for (const [width, cardW] of PHONES) {
    for (const n of [1, 5, 9, 10, 12, 13, 14]) {
      it(`${n} cards in ${width}px: every strip is readable and the fan fits`, () => {
        const cards = hand(n);
        const min = Math.max(cardW * MIN_STEP, MIN_STEP_PX);
        for (const w of strips(cards, width, cardW)) expect(w).toBeGreaterThanOrEqual(min - 0.01);
        for (const s of layoutFan(cards, width, cardW).slots) {
          expect(Math.abs(s.x) + cardW / 2).toBeLessThanOrEqual(width / 2 + 0.01);
        }
      });
    }
  }

  it('never spreads beyond the natural overlap on a wide screen', () => {
    const { step, rows } = layoutFan(hand(9), 1200, 100);
    expect(rows).toBe(1);
    expect(step).toBeCloseTo(100 * MAX_STEP);
  });

  it('keeps a nine-card hand in one row on a 320px phone', () => {
    expect(layoutFan(hand(9), 304, 54).rows).toBe(1);
  });

  it('splits a 14-card hand into two rows on a 320px phone, front row on top', () => {
    const layout = layoutFan(hand(14), 304, 54);
    expect(layout.rows).toBe(2);
    const back = layout.slots.filter((s) => s.row === 1);
    const front = layout.slots.filter((s) => s.row === 0);
    expect(back.length + front.length).toBe(14);
    expect(Math.max(...back.map((s) => s.y))).toBeLessThan(Math.min(...front.map((s) => s.y)));
    expect(Math.min(...front.map((s) => s.z))).toBeGreaterThan(Math.max(...back.map((s) => s.z)));
  });

  it('paints later cards on top within a row', () => {
    const zs = layoutFan(hand(9), 374, 66).slots.map((s) => s.z);
    expect([...zs].sort((a, b) => a - b)).toEqual(zs);
  });
});

describe('splitIndex', () => {
  it('splits on a suit boundary near the middle', () => {
    const cards: Card[] = ['HA', 'HK', 'HQ', 'H9', 'H8', 'H7', 'DA', 'DK', 'CA', 'CK', 'C9', 'SA'];
    expect(splitIndex(cards)).toBe(6);
  });

  it('falls back to the middle when no suit boundary is close', () => {
    const cards: Card[] = ['HA', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6', 'DA', 'DK'];
    expect(splitIndex(cards)).toBe(5);
  });
});
