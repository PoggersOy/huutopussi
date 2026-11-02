/** evaluate.ts: the math behind calibrated bidding and contracts. */
import { type Card, ILLISOFT_RULES } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import {
  bestContract,
  bidValues,
  contractEv,
  FEATURE_NAMES,
  fitLinear,
  handFeatures,
  normCdf,
} from '../src/evaluate.js';
import { mulberry32 } from '../src/prng.js';

describe('evaluate', () => {
  it('normCdf matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
  });

  it('contract EV is +C when certain and −C when hopeless', () => {
    expect(contractEv(100, 500, 10)).toBeCloseTo(100, 3);
    expect(contractEv(100, -300, 10)).toBeCloseTo(-100, 3);
  });

  it('bestContract trades contract size against make probability', () => {
    const tight = bestContract(160, 5, 60, 420, 5);
    const loose = bestContract(160, 40, 60, 420, 5);
    expect(tight.amount).toBeGreaterThan(loose.amount);
    expect(tight.amount).toBeLessThanOrEqual(160);
    expect(bestContract(40, 30, 60, 420, 5).amount).toBe(60); // never below the floor
  });

  it('fitLinear recovers a known linear relation', () => {
    const rng = mulberry32(3);
    const xs: number[][] = [];
    const ys: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = rng() * 10;
      const b = rng() * 10;
      xs.push([1, a, b]);
      ys.push(5 + 2 * a - 3 * b + (rng() - 0.5));
    }
    const m = fitLinear(xs, ys, 0);
    expect(m.w[0]).toBeCloseTo(5, 1);
    expect(m.w[1]).toBeCloseTo(2, 1);
    expect(m.w[2]).toBeCloseTo(-3, 1);
    expect(m.sigma).toBeLessThan(0.5);
  });

  it('handFeatures are aligned with FEATURE_NAMES', () => {
    const hand: Card[] = ['HA', 'H10', 'HK', 'HQ', 'DK', 'C7', 'S7', 'S8', 'S9'];
    const f = handFeatures(hand, ILLISOFT_RULES);
    const at = (n: (typeof FEATURE_NAMES)[number]) => f[FEATURE_NAMES.indexOf(n)];
    expect(f).toHaveLength(FEATURE_NAMES.length);
    expect(at('marriagePts')).toBe(100);
    expect(at('halfPts')).toBe(80);
    expect(at('aceTens')).toBe(1);
    expect(at('voids')).toBe(0);
    expect(at('cards')).toBe(9);
  });

  it('declaring is worth more with a stronger hand and less at a higher price', () => {
    // NB: under illisoft's contract-less all-pass deals even a monster gains
    // little by declaring (passing keeps every point uncapped), so the test
    // pins monotonicity, not a sign.
    const monster: Card[] = ['HA', 'H10', 'HK', 'HQ', 'DA', 'D10', 'DK', 'DQ', 'SA'];
    const junk: Card[] = ['H6', 'H7', 'D6', 'D7', 'C6', 'C7', 'S6', 'S7', 'C8'];
    const m = bidValues(monster, ILLISOFT_RULES, 60);
    const j = bidValues(junk, ILLISOFT_RULES, 60);
    if (!m || !j) throw new Error('no calibration');
    expect(m.declare).toBeGreaterThan(j.declare + 200);
    expect(j.declare).toBeLessThan(j.pass);
    // A higher price never makes declaring more attractive.
    const pricey = bidValues(monster, ILLISOFT_RULES, 250);
    expect(pricey && m && pricey.declare <= m.declare).toBe(true);
  });
});
