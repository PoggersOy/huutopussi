/** Small Elo pill; a provisional rating flags itself via the hover title only.
 *  Renders nothing for guests/bots (null rating). Pass `label` (e.g. "ELO") to
 *  prefix the value as its own field, "ELO: 1000" — inline lists omit it and
 *  show the bare number. */
import { useTranslation } from 'react-i18next';

export function RatingBadge({
  rating,
  provisional,
  label,
}: {
  rating: number | null | undefined;
  provisional?: boolean | undefined;
  label?: string | undefined;
}) {
  const { t } = useTranslation();
  if (rating == null) return null;
  return (
    <span
      className="rating-badge"
      title={provisional ? t('profile.provisional') : t('profile.rating')}
    >
      {label != null ? `${label}: ` : ''}
      {rating}
    </span>
  );
}
