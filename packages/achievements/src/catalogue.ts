/**
 * The achievement catalogue — the single source of truth shared by the server
 * (live evaluation + backfill) and the client (rendering locked/unlocked badges
 * + progress). Each entry is metadata plus a pure predicate over an
 * `AchievementContext`.
 *
 * ⚠ `id` values are persisted in `user_achievements`. Never rename an id; retire
 *   one by removing it here (old rows stay harmless).
 *
 * Predicate cost by kind:
 *  - counter      — reads `stats` only (works in the stats-only profile context)
 *  - deal         — scans `match.deals` (side-level; backfillable)
 *  - matchDerived — uses `match`/`runningScores`/`rating` (backfillable)
 *  - seat         — scans `events`; guarded so backfill (events=null) is a no-op
 */
import { tricksPerDeal } from '@hp/engine';
import { eventsByDeal, seatTrumpSetCount } from './context.js';
import { counter, declarerSideOf, flag, maxOtherScore, someDeal } from './predicates.js';
import type { AchievementDef } from './types.js';

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // ── Ensiaskeleet (milestones) ──────────────────────────────────────────────
  {
    id: 'tervetuloa',
    i18nKey: 'achievements.tervetuloa',
    kind: 'counter',
    rarity: 'common',
    icon: 'cards',
    target: 1,
    predicate: (ctx) => counter(ctx.stats.totalGames, 1),
  },
  {
    id: 'ensivoitto',
    i18nKey: 'achievements.ensivoitto',
    kind: 'counter',
    rarity: 'common',
    icon: 'star',
    target: 1,
    predicate: (ctx) => counter(ctx.stats.totalWins, 1),
  },
  {
    id: 'poydan-kiertaja',
    i18nKey: 'achievements.poydan-kiertaja',
    kind: 'counter',
    rarity: 'uncommon',
    icon: 'dice',
    target: 3,
    predicate: (ctx) => counter(ctx.stats.playedPlayerCounts.length, 3),
  },
  {
    id: 'vakiokasvo',
    i18nKey: 'achievements.vakiokasvo',
    kind: 'counter',
    rarity: 'common',
    icon: 'cards',
    target: 25,
    predicate: (ctx) => counter(ctx.stats.totalGames, 25),
  },
  {
    id: 'kalkkis',
    i18nKey: 'achievements.kalkkis',
    kind: 'counter',
    rarity: 'uncommon',
    icon: 'clock',
    target: 100,
    predicate: (ctx) => counter(ctx.stats.totalGames, 100),
  },
  {
    id: 'voittajatyyppi',
    i18nKey: 'achievements.voittajatyyppi',
    kind: 'counter',
    rarity: 'uncommon',
    icon: 'trophy',
    target: 25,
    predicate: (ctx) => counter(ctx.stats.totalWins, 25),
  },
  {
    id: 'legenda',
    i18nKey: 'achievements.legenda',
    kind: 'counter',
    rarity: 'rare',
    icon: 'medal',
    target: 100,
    predicate: (ctx) => counter(ctx.stats.totalWins, 100),
  },

  // ── Putkessa (win streaks) ─────────────────────────────────────────────────
  {
    id: 'putki-3',
    i18nKey: 'achievements.putki-3',
    kind: 'counter',
    rarity: 'common',
    icon: 'fire',
    target: 3,
    predicate: (ctx) => counter(ctx.stats.bestStreak, 3),
  },
  {
    id: 'tulikuuma',
    i18nKey: 'achievements.tulikuuma',
    kind: 'counter',
    rarity: 'uncommon',
    icon: 'fire',
    target: 5,
    predicate: (ctx) => counter(ctx.stats.bestStreak, 5),
  },
  {
    id: 'voittamaton',
    i18nKey: 'achievements.voittamaton',
    kind: 'counter',
    rarity: 'rare',
    icon: 'shield',
    target: 10,
    prestigeTitleId: 'voittamaton',
    predicate: (ctx) => counter(ctx.stats.bestStreak, 10),
  },

  // ── Nousukiito (rating) ────────────────────────────────────────────────────
  {
    id: 'vakiinnutettu',
    i18nKey: 'achievements.vakiinnutettu',
    kind: 'counter',
    rarity: 'common',
    icon: 'ribbon',
    target: 10,
    predicate: (ctx) => counter(ctx.stats.ratedGames, 10),
  },
  {
    id: 'nousukiito',
    i18nKey: 'achievements.nousukiito',
    kind: 'counter',
    rarity: 'uncommon',
    icon: 'rocket',
    target: 1400,
    predicate: (ctx) => counter(ctx.stats.rating, 1400),
  },
  {
    id: 'eliittikerho',
    i18nKey: 'achievements.eliittikerho',
    kind: 'counter',
    rarity: 'rare',
    icon: 'sparkles',
    target: 1750,
    predicate: (ctx) => counter(ctx.stats.rating, 1750),
  },
  {
    id: 'kruunattu',
    i18nKey: 'achievements.kruunattu',
    kind: 'counter',
    rarity: 'legendary',
    icon: 'crown',
    target: 2100,
    predicate: (ctx) => counter(ctx.stats.rating, 2100),
  },
  {
    id: 'jattilaisen-kaataja',
    i18nKey: 'achievements.jattilaisen-kaataja',
    kind: 'matchDerived',
    rarity: 'rare',
    icon: 'target',
    predicate: (ctx) => {
      if (!ctx.match.isWin || ctx.rating === null || ctx.rating.opponentRatings.length === 0) {
        return flag(false);
      }
      const strongest = Math.max(...ctx.rating.opponentRatings);
      return flag(strongest - ctx.rating.before >= 200);
    },
  },

  // ── Pöytäurotyöt (per-deal feats) ──────────────────────────────────────────
  {
    id: 'lapari',
    i18nKey: 'achievements.lapari',
    kind: 'deal',
    rarity: 'legendary',
    icon: 'king',
    prestigeTitleId: 'laparimestari',
    predicate: (ctx) =>
      flag(someDeal(ctx, (d) => (d.sides[ctx.side]?.tricks ?? 0) === tricksPerDeal(ctx.config))),
  },
  {
    id: 'kuninkaalliset-haat',
    i18nKey: 'achievements.kuninkaalliset-haat',
    kind: 'deal',
    rarity: 'uncommon',
    icon: 'heart',
    predicate: (ctx) => flag(someDeal(ctx, (d) => (d.sides[ctx.side]?.marriagePoints ?? 0) >= 100)),
  },
  {
    id: 'uhkarohkea',
    i18nKey: 'achievements.uhkarohkea',
    kind: 'deal',
    rarity: 'rare',
    icon: 'dice',
    predicate: (ctx) =>
      flag(
        someDeal(
          ctx,
          (d) =>
            d.made === true &&
            (d.contract ?? 0) >= 200 &&
            declarerSideOf(d, ctx.config.players) === ctx.side,
        ),
      ),
  },
  {
    id: 'tayslaidallinen',
    i18nKey: 'achievements.tayslaidallinen',
    kind: 'deal',
    rarity: 'legendary',
    icon: 'bomb',
    predicate: (ctx) =>
      flag(
        someDeal(
          ctx,
          (d) => (d.bid ?? 0) >= 400 && declarerSideOf(d, ctx.config.players) === ctx.side,
        ),
      ),
  },
  {
    id: 'silakkakauppias',
    i18nKey: 'achievements.silakkakauppias',
    kind: 'deal',
    rarity: 'uncommon',
    icon: 'target',
    predicate: (ctx) =>
      flag(
        someDeal(ctx, (d) => {
          const mine = d.sides[ctx.side];
          if (!mine || mine.porvoo) return false;
          return d.sides.some((s, i) => i !== ctx.side && s.porvoo);
        }),
      ),
  },
  {
    id: 'viimeisen-tikin-sankari',
    i18nKey: 'achievements.viimeisen-tikin-sankari',
    kind: 'deal',
    rarity: 'uncommon',
    icon: 'star',
    predicate: (ctx) =>
      flag(
        someDeal(ctx, (d) => {
          if (d.made !== true || declarerSideOf(d, ctx.config.players) !== ctx.side) return false;
          const mine = d.sides[ctx.side];
          const contract = d.contract ?? 0;
          if (!mine || mine.lastTrickBonus <= 0) return false;
          // Decisive: without the last-trick bonus the raw total falls short.
          return mine.rawTotal - mine.lastTrickBonus < contract && contract <= mine.rawTotal;
        }),
      ),
  },

  // ── Draamaa (match arcs) ───────────────────────────────────────────────────
  {
    id: 'takaa-ajaja',
    i18nKey: 'achievements.takaa-ajaja',
    kind: 'matchDerived',
    rarity: 'rare',
    icon: 'rocket',
    predicate: (ctx) =>
      flag(
        ctx.match.isWin &&
          ctx.runningScores.some(
            (row) => maxOtherScore(row, ctx.side) - (row[ctx.side] ?? 0) >= 200,
          ),
      ),
  },
  {
    id: 'murskavoitto',
    i18nKey: 'achievements.murskavoitto',
    kind: 'matchDerived',
    rarity: 'uncommon',
    icon: 'bomb',
    predicate: (ctx) => {
      const mine = ctx.match.finalScores[ctx.side] ?? 0;
      const other = maxOtherScore(ctx.match.finalScores, ctx.side);
      return flag(ctx.match.isWin && Number.isFinite(other) && mine - other >= 300);
    },
  },
  {
    id: 'maratoonari',
    i18nKey: 'achievements.maratoonari',
    kind: 'matchDerived',
    rarity: 'uncommon',
    icon: 'clock',
    predicate: (ctx) => flag(ctx.match.isWin && ctx.match.dealsCount >= 15),
  },
  {
    id: 'salamasota',
    i18nKey: 'achievements.salamasota',
    kind: 'matchDerived',
    rarity: 'uncommon',
    icon: 'rocket',
    predicate: (ctx) =>
      flag(ctx.match.isWin && ctx.match.dealsCount > 0 && ctx.match.dealsCount <= 5),
  },
  {
    id: 'kirsikka',
    i18nKey: 'achievements.kirsikka',
    kind: 'matchDerived',
    rarity: 'rare',
    icon: 'sparkles',
    predicate: (ctx) => {
      if (!ctx.match.isWin) return flag(false);
      const { winTarget, winCondition, players } = ctx.config;
      const crossers = ctx.match.finalScores.filter((s) =>
        winCondition === 'exceed' ? s > winTarget : s >= winTarget,
      ).length;
      const last = ctx.match.deals[ctx.match.deals.length - 1];
      const declSide = last ? declarerSideOf(last, players) : null;
      return flag(crossers >= 2 && declSide === ctx.side);
    },
  },

  // ── Hassuttelu / häpeäpaidat ───────────────────────────────────────────────
  {
    id: 'porvoon-pikajuna',
    i18nKey: 'achievements.porvoon-pikajuna',
    kind: 'deal',
    rarity: 'uncommon',
    icon: 'skull',
    prestigeTitleId: 'porvoon-vakiokavija',
    predicate: (ctx) =>
      flag(
        someDeal(
          ctx,
          (d) =>
            declarerSideOf(d, ctx.config.players) === ctx.side &&
            (d.sides[ctx.side]?.porvoo ?? false),
        ),
      ),
  },
  {
    id: 'alamaki',
    i18nKey: 'achievements.alamaki',
    kind: 'matchDerived',
    rarity: 'uncommon',
    icon: 'skull',
    predicate: (ctx) => flag(ctx.stats.lossStreak >= 5),
  },
  {
    id: 'yopollo',
    i18nKey: 'achievements.yopollo',
    kind: 'matchDerived',
    rarity: 'uncommon',
    icon: 'moon',
    predicate: (ctx) => flag(ctx.match.localHour >= 2 && ctx.match.localHour < 5),
  },
  {
    id: 'kurja-kasi',
    i18nKey: 'achievements.kurja-kasi',
    kind: 'seat',
    rarity: 'rare',
    icon: 'dice',
    predicate: (ctx) => {
      if (!ctx.events) return flag(false);
      return flag(ctx.events.some((e) => e.type === 'redealDemanded' && e.seat === ctx.seat));
    },
  },

  // ── Peliaikaiset kikat (seat-level, going-forward) ─────────────────────────
  {
    id: 'hertta-huulilla',
    i18nKey: 'achievements.hertta-huulilla',
    kind: 'seat',
    rarity: 'uncommon',
    icon: 'heart',
    predicate: (ctx) => {
      if (!ctx.events) return flag(false);
      return flag(
        ctx.events.some(
          (e) => e.type === 'trumpSet' && e.seat === ctx.seat && e.suit === 'H' && e.points >= 100,
        ),
      );
    },
  },
  {
    id: 'valtinvaihtaja',
    i18nKey: 'achievements.valtinvaihtaja',
    kind: 'seat',
    rarity: 'rare',
    icon: 'crown',
    predicate: (ctx) => {
      if (!ctx.events) return flag(false);
      return flag(eventsByDeal(ctx.events).some((seg) => seatTrumpSetCount(seg, ctx.seat) >= 2));
    },
  },
  {
    id: 'koinikuningas',
    i18nKey: 'achievements.koinikuningas',
    kind: 'deal',
    rarity: 'uncommon',
    icon: 'king',
    predicate: (ctx) => flag(someDeal(ctx, (d) => (d.sides[ctx.side]?.discardPoints ?? 0) > 0)),
  },
] as const;

/** id → definition, for award lookups. */
export const ACHIEVEMENTS_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(
  ACHIEVEMENTS.map((a) => [a.id, a]),
);
