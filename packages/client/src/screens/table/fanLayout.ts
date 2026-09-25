/**
 * Hand-fan geometry (docs/MOTION.md §3.2), computed from the MEASURED width of
 * the footer rather than from fixed per-density CSS steps.
 *
 * The goal is that every card always shows at least its corner index and owns a
 * strip wide enough to hit with a thumb:
 *  - the fan spreads to use all the width it has (up to a natural overlap),
 *  - suit groups get a small gap between them while there is room for it,
 *  - and when a single row would squeeze the strips below MIN_STEP the hand
 *    splits into TWO rows (the back row peeking out above the front one), split
 *    on a suit boundary when one sits near the middle.
 *
 * Pure: no DOM, no React — unit-tested in test/fanLayout.test.ts.
 */
import { type Card, suitOf } from '@hp/engine';

/** One card's resting place. `x`/`y` are px offsets of the card's centre from
 *  the fan's bottom-centre anchor; `rot` is degrees. */
export interface FanSlot {
  x: number;
  y: number;
  rot: number;
  /** 0 = the only / front row, 1 = the back (upper) row. */
  row: 0 | 1;
  /** Paint order: later cards on top, the front row above the back row. */
  z: number;
}

export interface FanLayout {
  slots: FanSlot[];
  rows: 1 | 2;
  /** Horizontal distance between neighbouring cards' left edges, px. */
  step: number;
  /** Total height the fan needs (cards + arc + back-row offset), px. */
  height: number;
}

/** Natural overlap: a relaxed fan never spreads wider than this (× card width). */
export const MAX_STEP = 0.62;
/** Narrowest acceptable strip (× card width) — clears the corner index. */
export const MIN_STEP = 0.4;
/** …and never below this many px, whatever the card size (thumb target). */
export const MIN_STEP_PX = 26;
/** Extra space at a suit boundary, as a fraction of the step. */
const SUIT_GAP = 0.45;
/** How far the back row sits above the front one (× card height). */
const ROW_OFFSET = 0.44;
/** Rotation at the outermost card, and how much of it each card adds. */
const MAX_EDGE_DEG = 9;
const DEG_PER_CARD = 2.2;
/** How far the middle of the arc rises above the ends (× card height). */
const ARC_RISE = 0.07;

/** Breathing room at each side, so the tilted outer cards' corners never touch
 *  the screen edge (× card width). */
const SIDE_MARGIN = 0.12;

const CARD_RATIO = 1.4;

interface RowFit {
  step: number;
  gaps: boolean;
}

function suitBreaks(cards: readonly Card[]): number {
  let n = 0;
  for (let i = 1; i < cards.length; i++) {
    if (suitOf(cards[i] as Card) !== suitOf(cards[i - 1] as Card)) n++;
  }
  return n;
}

/** Widest step that fits `cards` in `width`, with suit gaps if they still leave
 *  a comfortable strip. */
function fitRow(cards: readonly Card[], width: number, cardW: number, minStep: number): RowFit {
  const maxStep = cardW * MAX_STEP;
  if (cards.length <= 1) return { step: maxStep, gaps: false };
  const free = Math.max(0, width - cardW);
  const plain = Math.min(maxStep, free / (cards.length - 1));
  const breaks = suitBreaks(cards);
  if (breaks > 0) {
    const gapped = Math.min(maxStep, free / (cards.length - 1 + breaks * SUIT_GAP));
    if (gapped >= minStep) return { step: gapped, gaps: true };
  }
  return { step: plain, gaps: false };
}

/** Where to split a two-row hand: a suit boundary near the middle if there is
 *  one (so a suit is never torn across rows), else the middle. The back row
 *  gets the larger half. */
export function splitIndex(cards: readonly Card[]): number {
  const mid = Math.ceil(cards.length / 2);
  let best = mid;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 1; i < cards.length; i++) {
    if (suitOf(cards[i] as Card) === suitOf(cards[i - 1] as Card)) continue;
    const d = Math.abs(i - cards.length / 2);
    if (d <= 1 && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

function layRow(
  cards: readonly Card[],
  step: number,
  gaps: boolean,
  cardH: number,
  row: 0 | 1,
  y0: number,
  z0: number,
): FanSlot[] {
  // Left edges along the row, gaps opened at suit boundaries.
  const lefts: number[] = [];
  let at = 0;
  for (let i = 0; i < cards.length; i++) {
    if (i > 0) {
      at += step;
      if (gaps && suitOf(cards[i] as Card) !== suitOf(cards[i - 1] as Card)) at += step * SUIT_GAP;
    }
    lefts.push(at);
  }
  const half = at / 2;
  const edgeDeg = Math.min(MAX_EDGE_DEG, (DEG_PER_CARD * (cards.length - 1)) / 2);
  const rise = cardH * ARC_RISE * (edgeDeg / MAX_EDGE_DEG);
  return lefts.map((left, i) => {
    const x = left - half;
    const t = half > 0 ? x / half : 0;
    return {
      x,
      // The outer cards sit on the baseline and the middle rides up, so the fan
      // never dips below the footer's bottom edge.
      y: y0 - (1 - t * t) * rise,
      rot: t * edgeDeg,
      row,
      z: z0 + i,
    };
  });
}

export function layoutFan(cards: readonly Card[], width: number, cardW: number): FanLayout {
  // jsdom / first paint before measurement: assume a typical phone.
  const cw = cardW > 0 ? cardW : 62;
  const w = (width > 0 ? width : 360) - 2 * cw * SIDE_MARGIN;
  const ch = cw * CARD_RATIO;
  const minStep = Math.max(cw * MIN_STEP, MIN_STEP_PX);
  const arcRoom = ch * ARC_RISE;

  const one = fitRow(cards, w, cw, minStep);
  if (one.step >= minStep || cards.length < 6) {
    return {
      slots: layRow(cards, one.step, one.gaps, ch, 0, 0, 1),
      rows: 1,
      step: one.step,
      height: ch + arcRoom,
    };
  }

  const s = splitIndex(cards);
  const back = cards.slice(0, s);
  const front = cards.slice(s);
  const fb = fitRow(back, w, cw, minStep);
  const ff = fitRow(front, w, cw, minStep);
  // One shared step so the two rows line up as one hand.
  const step = Math.min(fb.step, ff.step);
  const gaps = fb.gaps && ff.gaps;
  const lift = -ch * ROW_OFFSET;
  return {
    slots: [
      ...layRow(back, step, gaps, ch, 1, lift, 1),
      ...layRow(front, step, gaps, ch, 0, 0, 1 + cards.length),
    ],
    rows: 2,
    step,
    height: ch + arcRoom + ch * ROW_OFFSET,
  };
}
