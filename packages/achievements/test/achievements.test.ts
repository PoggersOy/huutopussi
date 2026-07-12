import type { DealResult, GameEvent, SideBreakdown } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import {
  type AchievementContext,
  counterProgress,
  earnedTitles,
  effectiveTitleId,
  evaluateAchievements,
  newlyUnlockedIds,
  runningScoresFromDeals,
  type StatsContext,
  titleForRating,
} from '../src/index.js';

// ── fixtures ───────────────────────────────────────────────────────────────

function side(p: Partial<SideBreakdown> = {}): SideBreakdown {
  return {
    cardPoints: 0,
    lastTrickBonus: 0,
    marriagePoints: 0,
    discardPoints: 0,
    rawTotal: 0,
    roundedTotal: 0,
    tricks: 0,
    porvoo: false,
    scoreDelta: 0,
    ...p,
  };
}

function deal(p: Partial<DealResult> & { sides: SideBreakdown[] }): DealResult {
  return { declarer: null, contract: null, bid: null, made: null, ...p };
}

const baseStats: StatsContext = {
  totalGames: 0,
  totalWins: 0,
  ratedGames: 0,
  rating: 1000,
  bestStreak: 0,
  lossStreak: 0,
  playedPlayerCounts: [],
};

function ctx(over: {
  stats?: Partial<StatsContext>;
  match?: Partial<AchievementContext['match']>;
  rating?: AchievementContext['rating'];
  events?: GameEvent[] | null;
  seat?: 0 | 1 | 2 | 3;
  side?: 0 | 1 | 2;
  config?: Partial<AchievementContext['config']>;
}): AchievementContext {
  const stats = { ...baseStats, ...over.stats };
  const match = {
    winnerSide: 0 as const,
    finalScores: [0, 0],
    deals: [] as DealResult[],
    dealsCount: 0,
    isWin: false,
    localHour: 12,
    ...over.match,
  };
  const c: AchievementContext = {
    config: { players: 4, talonSize: 3, winTarget: 500, winCondition: 'exceed', ...over.config },
    seat: over.seat ?? 0,
    side: over.side ?? 0,
    stats,
    match,
    rating: over.rating ?? null,
    runningScores: runningScoresFromDeals(match.deals, match.finalScores.length),
    events: over.events ?? null,
  };
  return c;
}

const unlocked = (c: AchievementContext) => new Set(newlyUnlockedIds(c, new Set()));

// ── counters ─────────────────────────────────────────────────────────────────

describe('counter achievements', () => {
  it('unlock at their threshold and expose progress', () => {
    expect(unlocked(ctx({ stats: { totalGames: 1 } })).has('tervetuloa')).toBe(true);
    expect(unlocked(ctx({ stats: { totalGames: 24 } })).has('vakiokasvo')).toBe(false);
    expect(unlocked(ctx({ stats: { totalGames: 25 } })).has('vakiokasvo')).toBe(true);

    const prog = counterProgress({ ...baseStats, totalGames: 12 });
    expect(prog.vakiokasvo).toEqual({ current: 12, target: 25 });
  });

  it('poydan-kiertaja needs all three table sizes', () => {
    expect(unlocked(ctx({ stats: { playedPlayerCounts: [2, 4] } })).has('poydan-kiertaja')).toBe(
      false,
    );
    expect(unlocked(ctx({ stats: { playedPlayerCounts: [2, 3, 4] } })).has('poydan-kiertaja')).toBe(
      true,
    );
  });

  it('rating tiers unlock from stats.rating', () => {
    expect(unlocked(ctx({ stats: { rating: 1399 } })).has('nousukiito')).toBe(false);
    expect(unlocked(ctx({ stats: { rating: 1400 } })).has('nousukiito')).toBe(true);
    expect(unlocked(ctx({ stats: { rating: 2100 } })).has('kruunattu')).toBe(true);
  });
});

// ── deal feats ───────────────────────────────────────────────────────────────

describe('per-deal feats', () => {
  it('lapari fires when a side takes every trick (tricksPerDeal)', () => {
    // 4p → 9 tricks.
    const slam = ctx({
      match: { deals: [deal({ sides: [side({ tricks: 9 }), side({ tricks: 0 })] })] },
    });
    expect(unlocked(slam).has('lapari')).toBe(true);
    const notSlam = ctx({
      match: { deals: [deal({ sides: [side({ tricks: 8 }), side({ tricks: 1 })] })] },
    });
    expect(unlocked(notSlam).has('lapari')).toBe(false);
  });

  it('uhkarohkea needs a made 200+ contract by the viewer side', () => {
    const d = deal({
      declarer: 0,
      contract: 220,
      bid: 200,
      made: true,
      sides: [side(), side()],
    });
    expect(unlocked(ctx({ side: 0, match: { deals: [d] } })).has('uhkarohkea')).toBe(true);
    // Same deal, but the viewer is on the OTHER side → not theirs.
    expect(unlocked(ctx({ side: 1, match: { deals: [d] } })).has('uhkarohkea')).toBe(false);
  });

  it('silakkakauppias needs an opponent shut out while we scored a trick', () => {
    const d = deal({ sides: [side({ tricks: 9 }), side({ tricks: 0, porvoo: true })] });
    expect(unlocked(ctx({ side: 0, match: { deals: [d] } })).has('silakkakauppias')).toBe(true);
    expect(unlocked(ctx({ side: 1, match: { deals: [d] } })).has('silakkakauppias')).toBe(false);
  });

  it('porvoon-pikajuna is the declarer going trickless', () => {
    const d = deal({
      declarer: 0,
      contract: 100,
      bid: 100,
      made: false,
      sides: [side({ porvoo: true }), side()],
    });
    expect(unlocked(ctx({ side: 0, match: { deals: [d] } })).has('porvoon-pikajuna')).toBe(true);
  });
});

// ── match arcs ───────────────────────────────────────────────────────────────

describe('match-derived feats', () => {
  it('murskavoitto needs a 300+ winning margin', () => {
    expect(
      unlocked(ctx({ side: 0, match: { isWin: true, finalScores: [520, 210] } })).has(
        'murskavoitto',
      ),
    ).toBe(true);
    expect(
      unlocked(ctx({ side: 0, match: { isWin: true, finalScores: [520, 300] } })).has(
        'murskavoitto',
      ),
    ).toBe(false);
  });

  it('takaa-ajaja needs having trailed by 200 then won', () => {
    // running scores: side 0 falls to -210 vs +0, then recovers to win.
    const deals = [
      deal({ sides: [side({ scoreDelta: -210 }), side({ scoreDelta: 40 })] }),
      deal({ sides: [side({ scoreDelta: 600 }), side({ scoreDelta: 0 })] }),
    ];
    expect(
      unlocked(ctx({ side: 0, match: { isWin: true, deals, finalScores: [390, 40] } })).has(
        'takaa-ajaja',
      ),
    ).toBe(true);
  });

  it('jattilaisen-kaataja needs beating a 200+ higher opponent', () => {
    const c = ctx({
      match: { isWin: true },
      rating: { before: 1000, after: 1020, delta: 20, opponentRatings: [1250] },
    });
    expect(unlocked(c).has('jattilaisen-kaataja')).toBe(true);
    const close = ctx({
      match: { isWin: true },
      rating: { before: 1000, after: 1020, delta: 20, opponentRatings: [1150] },
    });
    expect(unlocked(close).has('jattilaisen-kaataja')).toBe(false);
  });

  it('yopollo only in the small hours', () => {
    expect(unlocked(ctx({ match: { localHour: 3 } })).has('yopollo')).toBe(true);
    expect(unlocked(ctx({ match: { localHour: 12 } })).has('yopollo')).toBe(false);
  });
});

// ── seat feats + backfill no-op ─────────────────────────────────────────────

describe('seat feats', () => {
  const heartsMarriage: GameEvent[] = [
    { type: 'dealStarted', dealIndex: 0, dealer: 0, deck: [] },
    { type: 'trumpSet', suit: 'H', seat: 0, side: 0, how: 'own', points: 100 },
  ];

  it('hertta-huulilla fires from a hearts trumpSet by the seat', () => {
    expect(unlocked(ctx({ seat: 0, events: heartsMarriage })).has('hertta-huulilla')).toBe(true);
    expect(unlocked(ctx({ seat: 1, events: heartsMarriage })).has('hertta-huulilla')).toBe(false);
  });

  it('seat feats are a no-op during backfill (events=null)', () => {
    expect(unlocked(ctx({ seat: 0, events: null })).has('hertta-huulilla')).toBe(false);
  });

  it('valtinvaihtaja needs 2 trumpSets in one deal', () => {
    const two: GameEvent[] = [
      { type: 'dealStarted', dealIndex: 0, dealer: 0, deck: [] },
      { type: 'trumpSet', suit: 'H', seat: 0, side: 0, how: 'own', points: 100 },
      { type: 'trumpSet', suit: 'S', seat: 0, side: 0, how: 'own', points: 40 },
    ];
    expect(unlocked(ctx({ seat: 0, events: two })).has('valtinvaihtaja')).toBe(true);
  });
});

// ── evaluate semantics ──────────────────────────────────────────────────────

describe('evaluateAchievements', () => {
  it('skips already-unlocked episodic achievements', () => {
    const slam = ctx({ match: { deals: [deal({ sides: [side({ tricks: 9 }), side()] })] } });
    const evaluated = evaluateAchievements(slam, new Set(['lapari']));
    expect(evaluated.find((e) => e.id === 'lapari')).toBeUndefined();
  });

  it('re-reports counters even when already unlocked (for progress)', () => {
    const c = ctx({ stats: { totalGames: 30 } });
    const evaluated = evaluateAchievements(c, new Set(['vakiokasvo']));
    expect(evaluated.find((e) => e.id === 'vakiokasvo')?.progress).toEqual({
      current: 30,
      target: 25,
    });
  });
});

// ── titles ───────────────────────────────────────────────────────────────────

describe('titles', () => {
  it('titleForRating respects tier boundaries and provisional', () => {
    expect(titleForRating(2100, false).id).toBe('huutopussikuningas');
    expect(titleForRating(1349, false).id).toBe('vakiokavija');
    expect(titleForRating(1350, false).id).toBe('konkari');
    expect(titleForRating(999, false).id).toBe('aloittelija');
    expect(titleForRating(2500, true).id).toBe('tulokas');
  });

  it('earnedTitles include reached tiers and unlocked prestige', () => {
    const earned = earnedTitles(1600, false, new Set(['lapari']));
    const ids = earned.map((t) => t.id);
    expect(ids).toContain('kortiniekka');
    expect(ids).toContain('aloittelija');
    expect(ids).not.toContain('huutopussikuningas');
    expect(ids).toContain('laparimestari');
  });

  it('effectiveTitleId falls back to derived when the selection is not earned', () => {
    expect(effectiveTitleId('laparimestari', 1600, false, new Set())).toBe('kortiniekka');
    expect(effectiveTitleId('laparimestari', 1600, false, new Set(['lapari']))).toBe(
      'laparimestari',
    );
  });
});
