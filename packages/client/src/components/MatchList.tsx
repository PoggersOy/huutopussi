/** Match-summary list shared by the History screen and the lobby's
 *  past-matches panel. Pure presentational: entries in, rows out. */
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryEntry } from '../history';

export function MatchList({ entries, showRoom }: { entries: HistoryEntry[]; showRoom: boolean }) {
  const { t, i18n } = useTranslation();
  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <ul className="list">
      {entries.map(({ roomCode, match }) => (
        <li key={`${roomCode}:${match.finishedAt}`} className="match-row">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{t('history.result', { side: match.winnerSide + 1 })}</strong>
            {/* One score per side: 4p is 2 columns, 2-3p is 2 or 3. */}
            <span>
              {match.finalScores
                .map((score, side) => ({ score, side }))
                .map(({ score, side }) => (
                  <Fragment key={side}>
                    {side > 0 && ' — '}
                    <span className={match.winnerSide === side ? 'score--winner' : undefined}>
                      {score}
                    </span>
                  </Fragment>
                ))}
            </span>
          </div>
          <div className="row dim" style={{ justifyContent: 'space-between' }}>
            <span>
              {showRoom && (
                <>
                  <span className="room-code">{roomCode}</span>
                  {' · '}
                </>
              )}
              {t('history.deals', { count: match.deals })}
            </span>
            <span>{dateFmt.format(match.finishedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
