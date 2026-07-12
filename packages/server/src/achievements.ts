/**
 * Server-side glue between the finished-match transaction and the pure
 * `@hp/achievements` package. Owns the clock/timezone and the db reads/writes;
 * the actual predicates live in the package (shared with the backfill).
 *
 * MUST be called inside the match-end db transaction, AFTER finishMatch +
 * applyRatingResults, so the per-user stats/rating it reads already include the
 * match being scored.
 */
import {
  type AchievementContext,
  newlyUnlockedIds,
  runningScoresFromDeals,
} from '@hp/achievements';
import type { RuleConfig, Seat, Side } from '@hp/engine';
import { sideCount, sideOf } from '@hp/engine';
import type { Db, RatingUpdate } from './db.js';

/** Wall-clock hour 0-23 in Helsinki for a given epoch ms (drives "Yöpöllö"). */
export function helsinkiHour(nowMs: number): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(nowMs));
  const hour = Number.parseInt(formatted, 10);
  return Number.isFinite(hour) ? hour : 12;
}

export interface MatchAchievementInput {
  matchId: string;
  config: RuleConfig;
  winnerSide: Side;
  /** Cumulative final score per side. */
  finalScores: number[];
  /** Signed-in humans, by seat. */
  participants: Array<{ seat: Seat; userId: string }>;
  /** Present only when the match was rated (drives rating-based achievements). */
  ratingUpdates: RatingUpdate[] | null;
  now: number;
}

/**
 * Record the match's participants and award any newly-earned achievements to
 * each signed-in player. Returns each user's freshly-unlocked ids (for logging
 * / a future push). Never throws on a per-user problem — a missing user row is
 * skipped so one bad seat can't abort the whole match-end commit.
 */
export function evaluateMatchAchievements(
  db: Db,
  input: MatchAchievementInput,
): Map<string, string[]> {
  const { matchId, config, winnerSide, finalScores, participants, ratingUpdates, now } = input;
  const players = config.players;
  const awarded = new Map<string, string[]>();
  if (participants.length === 0) return awarded;

  // Durable user↔match link (also for casual/bot games) — written first so the
  // per-user counters below already include this match.
  db.recordMatchParticipants(
    matchId,
    participants.map((p) => ({
      userId: p.userId,
      seat: p.seat,
      players,
      won: sideOf(p.seat, players) === winnerSide,
    })),
  );

  const deals = db.getMatchDealResults(matchId);
  const events = db.getMatchEvents(matchId);
  const runningScores = runningScoresFromDeals(deals, sideCount(config));
  const localHour = helsinkiHour(now);

  for (const p of participants) {
    const user = db.getUserById(p.userId);
    if (!user) continue;
    const side = sideOf(p.seat, players);
    const isWin = side === winnerSide;
    const stats = db.userMatchStats(p.userId);

    let rating: AchievementContext['rating'] = null;
    if (ratingUpdates) {
      const mine = ratingUpdates.find((u) => u.userId === p.userId);
      if (mine) {
        rating = {
          before: mine.ratingBefore,
          after: mine.ratingAfter,
          delta: mine.delta,
          opponentRatings: ratingUpdates
            .filter((u) => sideOf(u.seat, players) !== side)
            .map((u) => u.ratingBefore),
        };
      }
    }

    const ctx: AchievementContext = {
      config: {
        players,
        talonSize: config.talonSize,
        winTarget: config.winTarget,
        winCondition: config.winCondition,
      },
      seat: p.seat,
      side,
      stats: {
        totalGames: stats.totalGames,
        totalWins: stats.totalWins,
        ratedGames: user.gamesPlayed,
        rating: user.rating,
        bestStreak: user.bestStreak,
        lossStreak: db.currentLossStreak(p.userId),
        playedPlayerCounts: stats.playedPlayerCounts,
      },
      match: {
        winnerSide,
        finalScores,
        deals,
        dealsCount: deals.length,
        isWin,
        localHour,
      },
      rating,
      runningScores,
      events,
    };

    const newIds = newlyUnlockedIds(ctx, db.unlockedAchievementIds(p.userId));
    if (newIds.length > 0) {
      db.awardAchievements(
        p.userId,
        newIds.map((achievementId) => ({ achievementId, unlockedAt: now, matchId })),
      );
      awarded.set(p.userId, newIds);
    }
  }
  return awarded;
}

/**
 * One-time historical backfill. Walks each user's RATED match history oldest →
 * newest (rating_events is the only durable user↔match link that predates the
 * `match_participants` table), seeding participant rows and awarding every
 * backfillable achievement they earned. Seat-level feats are skipped
 * (`events: null`) — they only exist in the 30-day event log and count forward.
 * Idempotent: awarding uses INSERT OR IGNORE, so it is always safe to re-run.
 */
export function backfillAchievements(db: Db): { users: number; awarded: number } {
  const userIds = db.allUserIds();
  let awardedTotal = 0;
  db.transaction(() => {
    for (const userId of userIds) {
      // Running stats reconstructed as of each match (so e.g. a past loss streak
      // or a rating peak that has since receded is still detected).
      let cumGames = 0;
      let cumWins = 0;
      let lossStreak = 0;
      let bestStreak = 0;
      const playedCounts = new Set<number>();

      for (const m of db.ratedMatchHistory(userId)) {
        if (m.config === null || m.winnerSide === null || m.finalScores === null) continue;
        const players = m.config.players;
        const side = sideOf(m.seat, players);
        const isWin = side === m.winnerSide;

        // Seed the durable participant link for this rated match.
        db.recordMatchParticipants(m.matchId, [{ userId, seat: m.seat, players, won: isWin }]);

        cumGames += 1;
        if (isWin) cumWins += 1;
        playedCounts.add(players);
        lossStreak = m.streakAfter > 0 ? 0 : lossStreak + 1;
        bestStreak = Math.max(bestStreak, m.streakAfter);

        const deals = db.getMatchDealResults(m.matchId);
        const seatRatings = db.matchSeatRatingsBefore(m.matchId);
        const ctx: AchievementContext = {
          config: {
            players,
            talonSize: m.config.talonSize,
            winTarget: m.config.winTarget,
            winCondition: m.config.winCondition,
          },
          seat: m.seat,
          side,
          stats: {
            totalGames: cumGames,
            totalWins: cumWins,
            ratedGames: cumGames,
            rating: m.ratingAfter,
            bestStreak,
            lossStreak,
            playedPlayerCounts: [...playedCounts],
          },
          match: {
            winnerSide: m.winnerSide,
            finalScores: m.finalScores,
            deals,
            dealsCount: m.deals,
            isWin,
            localHour: helsinkiHour(m.finishedAt ?? m.createdAt),
          },
          rating: {
            before: m.ratingBefore,
            after: m.ratingAfter,
            delta: m.ratingAfter - m.ratingBefore,
            opponentRatings: seatRatings
              .filter((sr) => sideOf(sr.seat, players) !== side)
              .map((sr) => sr.ratingBefore),
          },
          runningScores: runningScoresFromDeals(deals, sideCount(m.config)),
          events: null,
        };

        const newIds = newlyUnlockedIds(ctx, db.unlockedAchievementIds(userId));
        if (newIds.length > 0) {
          db.awardAchievements(
            userId,
            newIds.map((achievementId) => ({
              achievementId,
              unlockedAt: m.finishedAt ?? m.createdAt,
              matchId: m.matchId,
            })),
          );
          awardedTotal += newIds.length;
        }
      }
    }
  });
  return { users: userIds.length, awarded: awardedTotal };
}

/** Backfill marker key (bump the suffix to force a fresh re-scan on deploy). */
export const BACKFILL_META_KEY = 'achievements_backfill_v1';

/** Run the backfill once per db (guarded by a meta marker). Safe on every boot. */
export function backfillAchievementsOnce(db: Db): void {
  if (db.metaGet(BACKFILL_META_KEY) !== null) return;
  const { users, awarded } = backfillAchievements(db);
  db.metaSet(BACKFILL_META_KEY, String(Date.now()));
  console.log(`[achievements] backfill complete: ${awarded} awarded across ${users} users`);
}
