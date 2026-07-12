/**
 * Public shapes for the achievements + titles system.
 *
 * This package is PURE (like the engine): zero I/O, no clock, no randomness,
 * no db. It may depend on `@hp/engine` for pure helpers/types, never on the
 * server. Every predicate is a pure function over an `AchievementContext` that
 * the SERVER assembles (it owns the clock/db); both live match-end evaluation
 * and the historical backfill call the exact same predicates. The client
 * imports the catalogue metadata to render locked/unlocked badges + progress.
 */
import type { DealResult, GameEvent, Seat, Side } from '@hp/engine';

/**
 * How an achievement is detected — also tells the client whether to draw a
 * progress bar (`counter`) or a plain locked/unlocked badge (the rest).
 */
export type AchievementKind = 'counter' | 'deal' | 'matchDerived' | 'seat';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface AchievementProgress {
  current: number;
  target: number;
}

export interface PredicateResult {
  unlocked: boolean;
  /** Present for counter-style achievements so the UI can draw a progress bar. */
  progress?: AchievementProgress;
}

// ── The context a predicate sees ─────────────────────────────────────────────

/** Just the RuleConfig bits predicates need (kept minimal + serialisable). */
export interface AchievementConfig {
  players: 2 | 3 | 4;
  talonSize: 3 | 6;
  winTarget: number;
  winCondition: 'exceed' | 'reach';
}

/** Per-player lifetime aggregates. Counts marked "all types" include casual/bot
 *  matches (via `match_participants`); rated-only fields drive Elo-flavoured
 *  achievements. */
export interface StatsContext {
  /** Finished matches as a signed-in participant, ALL types (rated+casual+bots). */
  totalGames: number;
  /** Wins across ALL types. */
  totalWins: number;
  /** Rated games only (users.games_played) — drives the provisional threshold. */
  ratedGames: number;
  /** Current Elo rating. */
  rating: number;
  /** Best rated win streak (users.best_streak). */
  bestStreak: number;
  /** Current consecutive rated losses (0 if the last rated match was a win). */
  lossStreak: number;
  /** Distinct player-counts (2|3|4) the user has finished a match in. */
  playedPlayerCounts: number[];
}

/** This match's outcome from the viewer's seat. */
export interface MatchContext {
  winnerSide: Side;
  /** One total per side (length === sideCount). */
  finalScores: number[];
  /** Per-deal breakdowns in deal order (may be shorter than `dealsCount` if a
   *  legacy summary row was lost — see docs/db `rebuildDealsIfDrifted`). */
  deals: DealResult[];
  /** Authoritative number of deals played (matches.deals). */
  dealsCount: number;
  /** Did the viewer's side win this match. */
  isWin: boolean;
  /** Wall-clock hour 0-23 (Europe/Helsinki) the match finished. */
  localHour: number;
}

/** Rating movement for a rated match; null for casual/bot (unrated) matches. */
export interface RatingContext {
  before: number;
  after: number;
  delta: number;
  /** Ratings of players on the OTHER sides, at match start. */
  opponentRatings: number[];
}

export interface AchievementContext {
  config: AchievementConfig;
  seat: Seat;
  side: Side;
  stats: StatsContext;
  match: MatchContext;
  /** null for unrated (casual/bot) matches. */
  rating: RatingContext | null;
  /** [dealIndex][side] cumulative running scores derived from `match.deals`. */
  runningScores: number[][];
  /** This match's full event stream; null during backfill → seat predicates skip. */
  events: GameEvent[] | null;
}

export type Predicate = (ctx: AchievementContext) => PredicateResult;

export interface AchievementDef {
  /** Stable id, persisted in `user_achievements`. Never rename. */
  id: string;
  /** i18n base key; the client resolves `${i18nKey}.name` and `${i18nKey}.desc`. */
  i18nKey: string;
  kind: AchievementKind;
  rarity: Rarity;
  /** Icon id, mapped to an inline SVG client-side. */
  icon: string;
  /** Goal for progress display (counter achievements only). */
  target?: number;
  /** Unlocking this grants the named prestige title (see titles.ts). */
  prestigeTitleId?: string;
  predicate: Predicate;
}

// ── Titles ───────────────────────────────────────────────────────────────────

export interface TitleTier {
  id: string;
  i18nKey: string;
  /** Lowest rating that earns this tier (rating titles); 0 for prestige. */
  minRating: number;
}

export interface PrestigeTitle {
  id: string;
  i18nKey: string;
  /** The achievement whose unlock grants this title. */
  achievementId: string;
}

/** One awarded achievement, evaluated for a single match/user. */
export interface EvaluatedAchievement {
  id: string;
  unlocked: boolean;
  progress?: AchievementProgress;
}
