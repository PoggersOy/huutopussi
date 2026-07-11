/**
 * Elo math: the unified pairwise model across 2p (1v1), 4p (2v2 pairs) and 3p
 * (3-way free-for-all), the chess.com-like K schedule, the capped win-streak
 * bonus, the rating floor, and the zero-sum / round-once invariants.
 */
import { describe, expect, test } from 'vitest';
import {
  computeRatingChanges,
  expectedScore,
  K_ESTABLISHED,
  K_HIGH,
  K_PROVISIONAL,
  kFactor,
  type MemberResult,
  type SideInput,
  streakBonus,
} from '../src/elo.js';

/** Established member (K=20) at a given rating with no streak. */
function m(rating: number, gamesPlayed = 40, streakBefore = 0) {
  return { rating, gamesPlayed, streakBefore };
}
/** Safe accessor for result[side][member] under noUncheckedIndexedAccess. */
function at(res: MemberResult[][], side: number, k = 0): MemberResult {
  const r = res[side]?.[k];
  if (!r) throw new Error(`no member result at [${side}][${k}]`);
  return r;
}
/** Sum of every member's delta — must be 0 when no streak/floor is in play. */
function totalDelta(res: MemberResult[][]): number {
  return res.flat().reduce((s, r) => s + r.delta, 0);
}

describe('building blocks', () => {
  test('expectedScore is symmetric and centred at 0.5', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 10);
    expect(expectedScore(1400, 1000)).toBeCloseTo(10 / 11, 10);
  });

  test('kFactor schedule: provisional / established / high-tier boundaries', () => {
    expect(kFactor(1000, 5)).toBe(K_PROVISIONAL); // < 30 games
    expect(kFactor(1000, 29)).toBe(K_PROVISIONAL);
    expect(kFactor(1000, 30)).toBe(K_ESTABLISHED); // boundary → established
    expect(kFactor(2099, 40)).toBe(K_ESTABLISHED);
    expect(kFactor(2100, 40)).toBe(K_HIGH); // boundary → high tier
    expect(kFactor(2100, 5)).toBe(K_PROVISIONAL); // provisional overrides rating
  });

  test('streakBonus is capped and non-negative', () => {
    expect(streakBonus(0)).toBe(0);
    expect(streakBonus(1)).toBe(2);
    expect(streakBonus(3)).toBe(6);
    expect(streakBonus(5)).toBe(10);
    expect(streakBonus(10)).toBe(10); // capped
    expect(streakBonus(-3)).toBe(0); // guarded
  });
});

describe('2 players (1v1)', () => {
  test('equal established: ±K/2', () => {
    const res = computeRatingChanges([
      { members: [m(1000)], finalScore: 130, isWinner: true },
      { members: [m(1000)], finalScore: 100, isWinner: false },
    ]);
    expect(at(res, 0)).toEqual({ delta: 10, newRating: 1010, newStreak: 1 });
    expect(at(res, 1)).toEqual({ delta: -10, newRating: 990, newStreak: 0 });
  });

  test('reduces exactly to textbook Elo', () => {
    const rW = 1234;
    const rL = 1111;
    const res = computeRatingChanges([
      { members: [m(rW)], finalScore: 200, isWinner: true },
      { members: [m(rL)], finalScore: 50, isWinner: false },
    ]);
    expect(at(res, 0).delta).toBe(Math.round(K_ESTABLISHED * (1 - expectedScore(rW, rL))));
    expect(at(res, 1).delta).toBe(Math.round(K_ESTABLISHED * (0 - expectedScore(rL, rW))));
  });

  test('provisional winner moves faster than established loser', () => {
    const res = computeRatingChanges([
      { members: [m(1000, 5)], finalScore: 130, isWinner: true }, // K40
      { members: [m(1000, 50)], finalScore: 90, isWinner: false }, // K20
    ]);
    expect(at(res, 0).delta).toBe(20);
    expect(at(res, 1).delta).toBe(-10);
  });

  test('upset (low beats high) swings hard', () => {
    const res = computeRatingChanges([
      { members: [m(1000)], finalScore: 130, isWinner: true },
      { members: [m(1400)], finalScore: 120, isWinner: false },
    ]);
    expect(at(res, 0).delta).toBe(18);
    expect(at(res, 1).delta).toBe(-18);
  });

  test('favourite (high beats low) barely moves', () => {
    const res = computeRatingChanges([
      { members: [m(1400)], finalScore: 130, isWinner: true },
      { members: [m(1000)], finalScore: 120, isWinner: false },
    ]);
    expect(at(res, 0).delta).toBe(2);
    expect(at(res, 1).delta).toBe(-2);
  });

  test('zero-sum for equal K, no streak/floor', () => {
    const res = computeRatingChanges([
      { members: [m(1050)], finalScore: 130, isWinner: true },
      { members: [m(980)], finalScore: 120, isWinner: false },
    ]);
    expect(totalDelta(res)).toBe(0);
  });
});

describe('4 players (2v2 pairs)', () => {
  test('team rating uses the average; both members get the full side delta', () => {
    // side0 avg = 1200 (1000 & 1400), side1 avg = 1200 → E = 0.5.
    const res = computeRatingChanges([
      { members: [m(1000), m(1400)], finalScore: 130, isWinner: true },
      { members: [m(1200), m(1200)], finalScore: 110, isWinner: false },
    ]);
    // Both winners get the same +10 despite different personal ratings
    // (proves the side average, not the individual rating, drives E/S).
    expect(at(res, 0, 0).delta).toBe(10);
    expect(at(res, 0, 1).delta).toBe(10);
    expect(at(res, 1, 0).delta).toBe(-10);
    expect(at(res, 1, 1).delta).toBe(-10);
  });

  test('mixed K within a team: same sign, provisional partner moves more', () => {
    const res = computeRatingChanges([
      { members: [m(1000, 5), m(1000, 60)], finalScore: 130, isWinner: true }, // K40 & K20
      { members: [m(1000), m(1000)], finalScore: 110, isWinner: false },
    ]);
    expect(at(res, 0, 0).delta).toBe(20); // provisional
    expect(at(res, 0, 1).delta).toBe(10); // established
    expect(Math.sign(at(res, 0, 0).delta)).toBe(Math.sign(at(res, 0, 1).delta));
  });

  test('zero-sum across four equal-K players', () => {
    const res = computeRatingChanges([
      { members: [m(1000), m(1100)], finalScore: 130, isWinner: true },
      { members: [m(1050), m(1200)], finalScore: 120, isWinner: false },
    ]);
    expect(totalDelta(res)).toBe(0);
  });
});

describe('3 players (free-for-all)', () => {
  const threeWay = (scores: [number, number, number], winner: 0 | 1 | 2): SideInput[] =>
    scores.map((finalScore, i) => ({ members: [m(1000)], finalScore, isWinner: i === winner }));

  test('winner beats both; middle scorer is neutral; last drops', () => {
    const res = computeRatingChanges(threeWay([70, 50, 30], 0));
    expect(at(res, 0).delta).toBe(10); // winner
    expect(at(res, 1).delta).toBe(0); // middle by score
    expect(at(res, 2).delta).toBe(-10); // last by score
    expect(at(res, 0).newStreak).toBe(1);
    expect(at(res, 2).newStreak).toBe(0);
  });

  test('tied losers draw against each other', () => {
    const res = computeRatingChanges(threeWay([70, 40, 40], 0));
    expect(at(res, 0).delta).toBe(10);
    expect(at(res, 1).delta).toBe(-5);
    expect(at(res, 2).delta).toBe(-5);
  });

  test('declarer-tiebreak: winner gains even with the LOWEST score', () => {
    // winner (side0) scored only 20 but is the official winner.
    const res = computeRatingChanges(threeWay([20, 100, 10], 0));
    expect(at(res, 0).delta).toBe(10); // still beats everyone
    expect(at(res, 1).delta).toBe(0); // top loser
    expect(at(res, 2).delta).toBe(-10); // bottom loser
  });

  test('negative scores rank correctly (−50 above −120)', () => {
    const res = computeRatingChanges(threeWay([10, -50, -120], 0));
    expect(at(res, 1).delta).toBeGreaterThan(at(res, 2).delta);
  });

  test('zero-sum for equal-K three-way', () => {
    expect(totalDelta(computeRatingChanges(threeWay([70, 50, 30], 0)))).toBe(0);
  });
});

describe('streak bonus', () => {
  test('boosts a win by the capped bonus and advances the streak', () => {
    const res = computeRatingChanges([
      { members: [m(1000, 40, 3)], finalScore: 130, isWinner: true },
      { members: [m(1000)], finalScore: 100, isWinner: false },
    ]);
    expect(at(res, 0).delta).toBe(16); // base 10 + bonus 6
    expect(at(res, 0).newStreak).toBe(4);
  });

  test('never boosts a loss and resets the streak', () => {
    const res = computeRatingChanges([
      { members: [m(1000)], finalScore: 130, isWinner: true },
      { members: [m(1000, 40, 5)], finalScore: 100, isWinner: false },
    ]);
    expect(at(res, 1).delta).toBe(-10); // no bonus applied
    expect(at(res, 1).newStreak).toBe(0);
  });

  test('bonus is capped', () => {
    const res = computeRatingChanges([
      { members: [m(1000, 40, 10)], finalScore: 130, isWinner: true },
      { members: [m(1000)], finalScore: 100, isWinner: false },
    ]);
    expect(at(res, 0).delta).toBe(20); // base 10 + capped bonus 10
  });
});

describe('rating floor', () => {
  test('a loss cannot push a rating below the floor; delta reflects the clamp', () => {
    const res = computeRatingChanges([
      { members: [m(105, 5)], finalScore: 130, isWinner: true },
      { members: [m(105, 5)], finalScore: 100, isWinner: false }, // K40 → would lose 20
    ]);
    expect(at(res, 1).newRating).toBe(100); // clamped from 85
    expect(at(res, 1).delta).toBe(-5); // 100 − 105, so newRating === rating + delta
  });
});
