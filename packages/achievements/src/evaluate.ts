/**
 * The one entry point the server calls for both live match-end evaluation and
 * the historical backfill. Pure: given a context and the set already unlocked,
 * it says which achievements are (now) unlocked and their progress.
 */
import { ACHIEVEMENTS } from './catalogue.js';
import type {
  AchievementContext,
  AchievementProgress,
  EvaluatedAchievement,
  StatsContext,
} from './types.js';

/**
 * Evaluate the whole catalogue against `ctx`. Episodic (non-counter)
 * achievements already unlocked are skipped (they can't un-earn), so the result
 * only re-reports counters and not-yet-earned episodic ones.
 */
export function evaluateAchievements(
  ctx: AchievementContext,
  alreadyUnlocked: ReadonlySet<string>,
): EvaluatedAchievement[] {
  const out: EvaluatedAchievement[] = [];
  for (const def of ACHIEVEMENTS) {
    if (def.kind !== 'counter' && alreadyUnlocked.has(def.id)) continue;
    const res = def.predicate(ctx);
    out.push(
      res.progress
        ? { id: def.id, unlocked: res.unlocked, progress: res.progress }
        : { id: def.id, unlocked: res.unlocked },
    );
  }
  return out;
}

/** Ids that became unlocked in `ctx` and were not already unlocked (to award). */
export function newlyUnlockedIds(
  ctx: AchievementContext,
  alreadyUnlocked: ReadonlySet<string>,
): string[] {
  return evaluateAchievements(ctx, alreadyUnlocked)
    .filter((e) => e.unlocked && !alreadyUnlocked.has(e.id))
    .map((e) => e.id);
}

/**
 * A neutral context for computing counter progress from stats alone (the
 * profile screen): stats are real, everything else is inert. Counter predicates
 * read only `stats`, so their progress is exact; other kinds return locked.
 */
export function profileContext(stats: StatsContext): AchievementContext {
  return {
    config: { players: 4, talonSize: 3, winTarget: 0, winCondition: 'reach' },
    seat: 0,
    side: 0,
    stats,
    match: {
      winnerSide: 0,
      finalScores: [],
      deals: [],
      dealsCount: 0,
      isWin: false,
      localHour: 12,
    },
    rating: null,
    runningScores: [],
    events: null,
  };
}

/** Progress for every counter achievement, derived from stats (profile screen). */
export function counterProgress(stats: StatsContext): Record<string, AchievementProgress> {
  const ctx = profileContext(stats);
  const out: Record<string, AchievementProgress> = {};
  for (const def of ACHIEVEMENTS) {
    if (def.kind !== 'counter') continue;
    const res = def.predicate(ctx);
    if (res.progress) out[def.id] = res.progress;
  }
  return out;
}
