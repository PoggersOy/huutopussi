/**
 * The achievements catalogue on the profile screen: every achievement rendered
 * as a badge, unlocked ones lit and locked ones muted, with a progress bar for
 * counter-style ones. Definitions come straight from `@hp/achievements` (one
 * source of truth); per-user unlocked state + progress come from /api/profile.
 */
import { ACHIEVEMENTS } from '@hp/achievements';
import { useTranslation } from 'react-i18next';

/** Achievement icon id → emoji glyph. Falls back to a medal. */
const ICONS: Record<string, string> = {
  cards: '🃏',
  star: '⭐',
  crown: '👑',
  fire: '🔥',
  trophy: '🏆',
  medal: '🎖️',
  dice: '🎲',
  clock: '🕐',
  ribbon: '🎗️',
  rocket: '🚀',
  sparkles: '✨',
  shield: '🛡️',
  king: '🤴',
  heart: '❤️',
  target: '🎯',
  bomb: '💣',
  skull: '💀',
  moon: '🌙',
};
const iconFor = (id: string): string => ICONS[id] ?? '🏅';

export interface AchievementProgress {
  current: number;
  target: number;
}

export function AchievementsPanel({
  unlocked,
  progress,
}: {
  unlocked: Set<string>;
  progress: Record<string, AchievementProgress>;
}) {
  const { t } = useTranslation();
  const unlockedCount = ACHIEVEMENTS.filter((a) => unlocked.has(a.id)).length;

  // Collapsed by default: the full catalogue is long, so it's tucked into an
  // accordion (same chrome as the "What is Elo?" explainer). The unlocked count
  // stays in the summary so progress reads at a glance without expanding.
  return (
    <details className="panel profile__explainer">
      <summary className="profile__explainer-q">
        <span className="ach-accordion__title">{t('achievements.heading')}</span>
        <span className="dim ach-accordion__count">
          {unlockedCount} / {ACHIEVEMENTS.length}
        </span>
      </summary>
      <ul className="ach-grid ach-accordion__grid">
        {ACHIEVEMENTS.map((a) => {
          const isUnlocked = unlocked.has(a.id);
          const prog = a.kind === 'counter' ? progress[a.id] : undefined;
          const pct = prog ? Math.min(100, Math.round((prog.current / prog.target) * 100)) : 0;
          return (
            <li
              key={a.id}
              className={`ach ach--${a.rarity} ${isUnlocked ? 'ach--unlocked' : 'ach--locked'}`}
            >
              <span className="ach__icon" aria-hidden="true">
                {iconFor(a.icon)}
              </span>
              <span className="ach__body">
                <span className="ach__name">{t(`${a.i18nKey}.name`)}</span>
                <span className="ach__desc dim">{t(`${a.i18nKey}.desc`)}</span>
                {!isUnlocked && prog && prog.target > 1 && (
                  <span className="ach__progress">
                    <span className="ach__bar">
                      <span className="ach__bar-fill" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="ach__progress-num dim">
                      {t('achievements.progress', {
                        current: Math.min(prog.current, prog.target),
                        target: prog.target,
                      })}
                    </span>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
