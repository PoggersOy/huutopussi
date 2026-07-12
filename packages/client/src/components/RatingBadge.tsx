/** Small Elo pill; a provisional rating flags itself via the hover title only.
 *  Renders nothing for guests/bots (null rating). Pass `label` (e.g. "ELO") to
 *  prefix the value as its own field, "ELO: 1000"; pass `icon` to prefix it with
 *  a glyph (e.g. a crown) instead — inline lists pass neither and show the bare
 *  number. */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function RatingBadge({
  rating,
  provisional,
  label,
  icon,
}: {
  rating: number | null | undefined;
  provisional?: boolean | undefined;
  label?: string | undefined;
  icon?: ReactNode | undefined;
}) {
  const { t } = useTranslation();
  if (rating == null) return null;
  return (
    <span
      className="rating-badge"
      title={provisional ? t('profile.provisional') : t('profile.rating')}
    >
      {icon != null ? (
        <span className="rating-badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : label != null ? (
        `${label}: `
      ) : (
        ''
      )}
      {rating}
    </span>
  );
}
