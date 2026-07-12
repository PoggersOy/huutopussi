/**
 * Titles (arvonimet). The primary title is DERIVED from a player's rating (no
 * storage) so every client can render it from `SeatInfo.rating`/`provisional`
 * alone — including next to opponents at the table, with no protocol change.
 * Prestige titles are collectibles granted by specific achievements; a player
 * picks which earned title to display.
 *
 * Rating-tier boundaries are a product choice; the top tier's 2100 aligns with
 * the engine's HIGH_RATING_TIER. Keep ids stable (persisted as the selection).
 */
import type { PrestigeTitle, TitleTier } from './types.js';

/** Rating tiers, ordered HIGH → LOW for resolution. `aloittelija` is the floor. */
export const RATING_TITLES: readonly TitleTier[] = [
  { id: 'huutopussikuningas', i18nKey: 'titles.huutopussikuningas', minRating: 2100 },
  { id: 'suurmestari', i18nKey: 'titles.suurmestari', minRating: 1800 },
  { id: 'pussimestari', i18nKey: 'titles.pussimestari', minRating: 1650 },
  { id: 'kortiniekka', i18nKey: 'titles.kortiniekka', minRating: 1500 },
  { id: 'konkari', i18nKey: 'titles.konkari', minRating: 1350 },
  { id: 'vakiokavija', i18nKey: 'titles.vakiokavija', minRating: 1200 },
  { id: 'harrastelija', i18nKey: 'titles.harrastelija', minRating: 1050 },
  { id: 'aloittelija', i18nKey: 'titles.aloittelija', minRating: 0 },
] as const;

/** Shown to players still under PROVISIONAL_GAMES rated games (the `?` state). */
export const TULOKAS: TitleTier = { id: 'tulokas', i18nKey: 'titles.tulokas', minRating: 0 };

/** Prestige titles unlocked by an achievement. */
export const PRESTIGE_TITLES: readonly PrestigeTitle[] = [
  { id: 'voittamaton', i18nKey: 'titles.voittamaton', achievementId: 'voittamaton' },
  { id: 'laparimestari', i18nKey: 'titles.laparimestari', achievementId: 'lapari' },
  {
    id: 'porvoon-vakiokavija',
    i18nKey: 'titles.porvoonVakiokavija',
    achievementId: 'porvoon-pikajuna',
  },
] as const;

/** The derived title for a rating (provisional players are always Tulokas). */
export function titleForRating(rating: number, provisional: boolean): TitleTier {
  if (provisional) return TULOKAS;
  for (const tier of RATING_TITLES) {
    if (rating >= tier.minRating) return tier;
  }
  // RATING_TITLES ends at minRating 0, so this is unreachable; satisfy the types.
  return RATING_TITLES[RATING_TITLES.length - 1] ?? TULOKAS;
}

/**
 * Every title a player is allowed to display: their reached rating tiers (or
 * Tulokas while provisional) plus each prestige title whose achievement they
 * have unlocked. Used both to populate the title picker and to validate a
 * player's chosen title server-side.
 */
export function earnedTitles(
  rating: number,
  provisional: boolean,
  unlockedAchievementIds: ReadonlySet<string>,
): TitleTier[] {
  const out: TitleTier[] = [];
  if (provisional) {
    out.push(TULOKAS);
  } else {
    for (const tier of RATING_TITLES) {
      if (rating >= tier.minRating) out.push(tier);
    }
  }
  for (const p of PRESTIGE_TITLES) {
    if (unlockedAchievementIds.has(p.achievementId)) {
      out.push({ id: p.id, i18nKey: p.i18nKey, minRating: 0 });
    }
  }
  return out;
}

/**
 * The title id to actually show: the player's selection if it is still earned,
 * otherwise the derived rating title. (A prestige selection stays valid; a
 * rating tier the player has since dropped below is replaced by the current
 * derived one.)
 */
export function effectiveTitleId(
  selectedId: string | null,
  rating: number,
  provisional: boolean,
  unlockedAchievementIds: ReadonlySet<string>,
): string {
  if (selectedId !== null) {
    const earned = earnedTitles(rating, provisional, unlockedAchievementIds);
    if (earned.some((t) => t.id === selectedId)) return selectedId;
  }
  return titleForRating(rating, provisional).id;
}
