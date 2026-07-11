/** Small Elo pill; a provisional rating shows a trailing `?`. Renders nothing
 *  for guests/bots (null rating). */
import { useTranslation } from 'react-i18next';

export function RatingBadge({
  rating,
  provisional,
}: {
  rating: number | null | undefined;
  provisional?: boolean | undefined;
}) {
  const { t } = useTranslation();
  if (rating == null) return null;
  return (
    <span
      className="rating-badge"
      title={provisional ? t('profile.provisional') : t('profile.rating')}
    >
      {rating}
      {provisional ? '?' : ''}
    </span>
  );
}
