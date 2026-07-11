/** Match-summary list shared by the History screen and the lobby's
 *  past-matches panel. Rows with persisted per-deal detail are tappable and
 *  open the deal-by-deal browser; older summaries (no `dealResults`) render as
 *  plain, non-interactive rows. */
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryEntry } from '../history';
import { DealHistoryBrowser } from './DealHistoryBrowser';

export function MatchList({ entries, showRoom }: { entries: HistoryEntry[]; showRoom: boolean }) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <>
      <ul className="list">
        {entries.map(({ roomCode, match }) => {
          const canBrowse =
            match.players !== undefined &&
            Array.isArray(match.dealResults) &&
            match.dealResults.length > 0;
          const content = (
            <>
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
                  {canBrowse && <span className="match-row__chev"> ›</span>}
                </span>
                <span>{dateFmt.format(match.finishedAt)}</span>
              </div>
            </>
          );
          return (
            <li key={`${roomCode}:${match.finishedAt}`} className="match-row">
              {canBrowse ? (
                <button
                  type="button"
                  className="match-row__btn"
                  onClick={() => setSelected({ roomCode, match })}
                  aria-label={t('history.browseDeals')}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>
      {selected && (
        <DealHistoryBrowser
          match={selected.match}
          roomCode={selected.roomCode}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
