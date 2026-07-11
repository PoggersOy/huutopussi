/**
 * Pure Elo rating math for Huutopussi — chess.com-flavoured.
 *
 * This module is deliberately dependency-free (plain numbers in/out, no engine
 * or db imports) so it is trivially unit-testable. All game-specific mapping
 * (seats → sides → users, rated-eligibility) lives in the server; this file
 * only answers "given these sides and their members, how does each member's
 * rating move?".
 *
 * ## The unified model (one algorithm for 2p / 3p / 4p)
 *
 * A match has `n` **sides** (`sideCount`: 2p→2, 4p→2, 3p→3). A side has one
 * member (2p/3p) or two members (4p pairs). We treat every match as a set of
 * pairwise Elo games between sides, scaled so the total K-budget per side is
 * exactly one game's worth regardless of mode:
 *
 *   E(i,j) = 1 / (1 + 10^((Rj − Ri) / 400))          // side ratings Ri,Rj
 *   raw_m  = Σ_{j≠i} K(m) · (1/(n−1)) · (S(i,j) − E(i,j))
 *
 * where a **side rating** is the mean of its members' ratings and K is
 * per-member (a provisional player on a team still moves fast while their
 * established partner moves slowly). For n=2 this reduces to textbook Elo.
 *
 * ## Actual score S is anchored to the OFFICIAL winner
 *
 * The engine's winner is not always the top scorer (`winTiebreak:'declarer'`
 * can crown a lower-scoring declarer). Ranking purely by final score would then
 * charge the winner a rating loss — indefensible, and it would break streaks.
 * So the winning side's sort key is +∞ (it beats every side, S=1); the
 * non-winning sides are still ranked among themselves by their final score
 * (meaningful in 3p). Equal keys → draw (S=0.5).
 *
 * ## Streak bonus (a house rule on top of Elo)
 *
 * The winner's members get a small, capped bonus that grows with their prior
 * win streak. It is gains-only (never shrinks a loss), winner-only, and capped
 * at +STREAK_BONUS_CAP, so it can't runaway-inflate. This does inject a bounded
 * amount of rating (the system is not strictly zero-sum) — an explicit product
 * choice; chess.com's real ladder isn't strictly zero-sum either.
 */

// ── Tunable constants ────────────────────────────────────────────────────────

/** Rating assigned to a brand-new account. */
export const STARTING_RATING = 1000;
/** Below this many rated games a player is "provisional" (faster K, `?` badge). */
export const PROVISIONAL_GAMES = 10;
/** K for provisional players (< PROVISIONAL_GAMES games). */
export const K_PROVISIONAL = 40;
/** K for established players below the high-rating tier. */
export const K_ESTABLISHED = 20;
/** K for established players at/above HIGH_RATING_TIER. */
export const K_HIGH = 10;
/** Established players at/above this rating use the slowest K. */
export const HIGH_RATING_TIER = 2100;
/** Ratings can never fall below this. No ceiling. */
export const RATING_FLOOR = 100;
/** Elo added per prior consecutive win. */
export const STREAK_BONUS_STEP = 2;
/** Prior wins beyond this stop adding to the bonus. */
export const STREAK_MAX_STEPS = 5;
/** Maximum streak bonus (= STREAK_BONUS_STEP · STREAK_MAX_STEPS). */
export const STREAK_BONUS_CAP = STREAK_BONUS_STEP * STREAK_MAX_STEPS;

// ── Public shapes ────────────────────────────────────────────────────────────

export interface MemberInput {
  /** Current rating before this match. */
  rating: number;
  /** Rated games played before this match (drives the K schedule). */
  gamesPlayed: number;
  /** Consecutive rated wins before this match (drives the streak bonus). */
  streakBefore: number;
}

export interface SideInput {
  /** 1 member (2p/3p) or 2 members (4p pairs). */
  members: MemberInput[];
  /** This side's cumulative match score (may be negative). */
  finalScore: number;
  /** True for exactly one side — the engine's official winner. */
  isWinner: boolean;
}

export interface MemberResult {
  /** Signed rating change (already rounded). */
  delta: number;
  /** rating + delta, clamped to RATING_FLOOR. */
  newRating: number;
  /** Consecutive-win counter after this match. */
  newStreak: number;
}

// ── Building blocks (exported for tests) ─────────────────────────────────────

/** Standard 400-point logistic expectation of A scoring against B. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/** K-factor from the chess.com-like schedule. */
export function kFactor(rating: number, gamesPlayed: number): number {
  if (gamesPlayed < PROVISIONAL_GAMES) return K_PROVISIONAL;
  return rating >= HIGH_RATING_TIER ? K_HIGH : K_ESTABLISHED;
}

/** Capped, gains-only win-streak bonus given the streak BEFORE this win. */
export function streakBonus(streakBefore: number): number {
  const steps = Math.min(Math.max(streakBefore, 0), STREAK_MAX_STEPS);
  return steps * STREAK_BONUS_STEP;
}

// ── The one function the server calls ────────────────────────────────────────

/**
 * Compute each member's rating change. Returns a parallel structure:
 * `result[sideIndex][memberIndex]`, aligned with the input `sides`.
 *
 * Pure and deterministic. The caller is responsible for having already decided
 * the match is rated (all distinct signed-in humans, no bots).
 */
export function computeRatingChanges(sides: SideInput[]): MemberResult[][] {
  const n = sides.length;
  // Degenerate inputs never rate: no movement.
  if (n < 2) {
    return sides.map((side) =>
      side.members.map((m) => ({
        delta: 0,
        newRating: m.rating,
        newStreak: m.streakBefore,
      })),
    );
  }

  const sideRating = sides.map(
    (side) => side.members.reduce((sum, m) => sum + m.rating, 0) / side.members.length,
  );
  // Winner beats everyone; losers ranked among themselves by final score.
  const sortKey = sides.map((side) => (side.isWinner ? Number.POSITIVE_INFINITY : side.finalScore));
  const opponentDivisor = n - 1;

  return sides.map((side, i) => {
    // i, j always index within [0, n); the `?? 0` only satisfies the compiler's
    // noUncheckedIndexedAccess — the arrays have exactly n entries.
    const ratingI = sideRating[i] ?? 0;
    const keyI = sortKey[i] ?? 0;
    return side.members.map((member) => {
      let raw = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const expected = expectedScore(ratingI, sideRating[j] ?? 0);
        const keyJ = sortKey[j] ?? 0;
        const actual = keyI > keyJ ? 1 : keyI < keyJ ? 0 : 0.5;
        raw += kFactor(member.rating, member.gamesPlayed) * (actual - expected);
      }
      raw /= opponentDivisor;

      const bonus = side.isWinner ? streakBonus(member.streakBefore) : 0;
      const rawDelta = Math.round(raw + bonus);
      const newRating = Math.max(RATING_FLOOR, member.rating + rawDelta);
      // Report the delta that actually happened, so newRating === rating + delta
      // always holds (matters when the floor clamps a loss).
      const delta = newRating - member.rating;
      const newStreak = side.isWinner ? member.streakBefore + 1 : 0;
      return { delta, newRating, newStreak };
    });
  });
}
