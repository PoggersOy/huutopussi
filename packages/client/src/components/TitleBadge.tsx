/**
 * The rating-derived title (arvonimi) shown next to a name. Pure client-side —
 * computed from a seat's rating + provisional flag, so it renders for opponents
 * at the table/lobby with no extra server data. Renders nothing for guests/bots.
 */
import { titleForRating } from '@hp/achievements';
import { useTranslation } from 'react-i18next';

export function TitleBadge({
  rating,
  provisional,
}: {
  rating: number | null | undefined;
  provisional?: boolean | undefined;
}) {
  const { t } = useTranslation();
  if (rating == null) return null;
  const tier = titleForRating(rating, provisional ?? false);
  return <span className="title-badge">{t(tier.i18nKey)}</span>;
}
