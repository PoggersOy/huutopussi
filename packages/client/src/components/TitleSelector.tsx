/**
 * Title picker on the profile screen: the player chooses which earned title to
 * display. Earned titles = the reached rating tiers + any unlocked prestige
 * titles (computed by `@hp/achievements`); `activeId` is the effective title.
 */
import { earnedTitles } from '@hp/achievements';
import { useTranslation } from 'react-i18next';

export function TitleSelector({
  rating,
  provisional,
  unlocked,
  activeId,
  onSelect,
}: {
  rating: number;
  provisional: boolean;
  unlocked: Set<string>;
  activeId: string;
  onSelect: (titleId: string) => void;
}) {
  const { t } = useTranslation();
  const earned = earnedTitles(rating, provisional, unlocked);

  return (
    <div className="panel stack">
      <h2>{t('titles.heading')}</h2>
      <p className="dim">{t('titles.derivedHint')}</p>
      <div className="title-chips">
        {earned.map((tier) => (
          <button
            key={tier.id}
            type="button"
            className={`title-chip ${tier.id === activeId ? 'title-chip--active' : ''}`}
            onClick={() => onSelect(tier.id)}
          >
            {t(tier.i18nKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
