/** Match-summary list shared by the History screen and the lobby's
 *  past-matches panel. Pure presentational: entries in, rows out. */
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
            <span>
              <span className={match.winnerSide === 0 ? 'score--winner' : undefined}>
                {match.finalScores[0]}
              </span>
              {' — '}
              <span className={match.winnerSide === 1 ? 'score--winner' : undefined}>
                {match.finalScores[1]}
              </span>
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
