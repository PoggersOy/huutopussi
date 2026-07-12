import type { DealResult, RuleConfig, SideBreakdown } from '@hp/engine';
import { DEFAULT_RULES } from '@hp/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillAchievements, evaluateMatchAchievements } from '../src/achievements.js';
import { Db, type RatingUpdate } from '../src/db.js';

const CONFIG_2P: RuleConfig = { ...DEFAULT_RULES, players: 2, talonSize: 3 };

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

/** A slam by side 0, declared and made a 260 contract; side 1 shut out (Porvoo). */
function slamDeal(): DealResult {
  return {
    declarer: 0,
    contract: 260,
    bid: 240,
    made: true,
    // tricksPerDeal(2p, talon 3) === 11.
    sides: [
      side({ tricks: 11, scoreDelta: 520 }),
      side({ tricks: 0, porvoo: true, scoreDelta: -100 }),
    ],
  };
}

let db: Db;
beforeEach(() => {
  db = new Db(':memory:');
  db.upsertUserByGoogleSub({ id: 'A', googleSub: 'a', name: 'A', picture: null });
  db.upsertUserByGoogleSub({ id: 'B', googleSub: 'b', name: 'B', picture: null });
});

function finishedSlamMatch(matchId: string): void {
  db.createMatch({ id: matchId, roomId: 'r1', config: CONFIG_2P, firstDealer: 0 });
  db.recordDealResult(matchId, 0, 0, slamDeal());
  db.finishMatch(matchId, 0, [520, 100], ['A', 'B']);
}

describe('live match-end evaluation', () => {
  it('awards the expected achievements to each side', () => {
    finishedSlamMatch('m1');
    const awarded = evaluateMatchAchievements(db, {
      matchId: 'm1',
      config: CONFIG_2P,
      winnerSide: 0,
      finalScores: [520, 100],
      participants: [
        { seat: 0, userId: 'A' },
        { seat: 1, userId: 'B' },
      ],
      ratingUpdates: null,
      now: 1_000_000,
    });

    const a = new Set(awarded.get('A') ?? []);
    expect(a).toContain('lapari'); // slam
    expect(a).toContain('tervetuloa'); // first game
    expect(a).toContain('ensivoitto'); // first win
    expect(a).toContain('uhkarohkea'); // made a 200 contract
    expect(a).toContain('silakkakauppias'); // shut the opponent out
    expect(a).toContain('murskavoitto'); // 420-point margin

    const b = new Set(awarded.get('B') ?? []);
    expect(b).toContain('tervetuloa');
    expect(b).not.toContain('ensivoitto'); // B lost
    expect(b).not.toContain('lapari');
  });

  it('records participants so casual games count toward stats', () => {
    finishedSlamMatch('m1');
    evaluateMatchAchievements(db, {
      matchId: 'm1',
      config: CONFIG_2P,
      winnerSide: 0,
      finalScores: [520, 100],
      participants: [
        { seat: 0, userId: 'A' },
        { seat: 1, userId: 'B' },
      ],
      ratingUpdates: null,
      now: 1_000_000,
    });
    expect(db.userMatchStats('A')).toEqual({
      totalGames: 1,
      totalWins: 1,
      playedPlayerCounts: [2],
    });
    expect(db.userMatchStats('B')).toEqual({
      totalGames: 1,
      totalWins: 0,
      playedPlayerCounts: [2],
    });
  });

  it('is idempotent — a re-run awards nothing new', () => {
    finishedSlamMatch('m1');
    const input = {
      matchId: 'm1',
      config: CONFIG_2P,
      winnerSide: 0 as const,
      finalScores: [520, 100],
      participants: [
        { seat: 0 as const, userId: 'A' },
        { seat: 1 as const, userId: 'B' },
      ],
      ratingUpdates: null,
      now: 1_000_000,
    };
    evaluateMatchAchievements(db, input);
    const second = evaluateMatchAchievements(db, input);
    expect(second.size).toBe(0);
  });
});

describe('awardAchievements idempotency', () => {
  it('INSERT OR IGNORE never re-awards or moves unlocked_at', () => {
    const first = db.awardAchievements('A', [
      { achievementId: 'lapari', unlockedAt: 1, matchId: 'm1' },
    ]);
    expect(first).toEqual(['lapari']);
    const second = db.awardAchievements('A', [
      { achievementId: 'lapari', unlockedAt: 999, matchId: 'm2' },
    ]);
    expect(second).toEqual([]);
    const rows = db.getUserAchievements('A');
    expect(rows).toEqual([{ achievementId: 'lapari', unlockedAt: 1, matchId: 'm1' }]);
  });
});

describe('backfill', () => {
  function ratedSlam(): void {
    finishedSlamMatch('m1');
    const updates: RatingUpdate[] = [
      {
        matchId: 'm1',
        userId: 'A',
        seat: 0,
        ratingBefore: 1000,
        ratingAfter: 1450,
        delta: 450,
        newStreak: 1,
        isWin: true,
        createdAt: 1_000,
      },
      {
        matchId: 'm1',
        userId: 'B',
        seat: 1,
        ratingBefore: 1000,
        ratingAfter: 900,
        delta: -100,
        newStreak: 0,
        isWin: false,
        createdAt: 1_000,
      },
    ];
    db.applyRatingResults(updates);
  }

  it('awards backfillable achievements from rated history', () => {
    ratedSlam();
    const { awarded } = backfillAchievements(db);
    expect(awarded).toBeGreaterThan(0);
    const a = new Set(db.getUserAchievements('A').map((r) => r.achievementId));
    expect(a).toContain('lapari');
    expect(a).toContain('ensivoitto');
    expect(a).toContain('nousukiito'); // rating reached 1450
    // Seat-level feats are skipped in backfill (events=null).
    expect(a).not.toContain('punaiset-haat');
  });

  it('re-running backfill is a no-op', () => {
    ratedSlam();
    backfillAchievements(db);
    const { awarded } = backfillAchievements(db);
    expect(awarded).toBe(0);
  });
});

describe('GDPR erasure', () => {
  it('clears achievements and participants for the deleted user', () => {
    finishedSlamMatch('m1');
    evaluateMatchAchievements(db, {
      matchId: 'm1',
      config: CONFIG_2P,
      winnerSide: 0,
      finalScores: [520, 100],
      participants: [{ seat: 0, userId: 'A' }],
      ratingUpdates: null,
      now: 1_000_000,
    });
    expect(db.getUserAchievements('A').length).toBeGreaterThan(0);
    db.deleteUserAccount('A');
    expect(db.getUserAchievements('A')).toEqual([]);
    expect(db.userMatchStats('A')).toEqual({ totalGames: 0, totalWins: 0, playedPlayerCounts: [] });
  });
});
