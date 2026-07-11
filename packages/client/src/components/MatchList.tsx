/** Match-summary list shared by the History screen and the lobby's
 *  past-matches panel. Rows with persisted per-deal detail are tappable and
 *  open the deal-by-deal browser; older summaries (no `dealResults`) render as
 *  plain, non-interactive rows. */
import { partnerOf, type Seat } from '@hp/engine';
import type { MatchSummary } from '@hp/protocol';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { summaryNames, useBotNames } from '../botNames';
import type { HistoryEntry } from '../history';
import { DealHistoryBrowser } from './DealHistoryBrowser';

export function MatchList({ entries, showRoom }: { entries: HistoryEntry[]; showRoom: boolean }) {
  const { t, i18n } = useTranslation();
  const botNames = useBotNames();
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  // Title naming the winner(s): "Matti voitti" (2-3p, one seat per side) or
  // "Matti & Maija voittivat" (the 4p winning pair). Bot seats stored no name,
  // so they get their localized bot name. Pre-deal-browser summaries lack
  // names/players entirely, so those fall back to the plain "Puoli N voitti".
  const winnerLine = (match: MatchSummary): string => {
    const { players, names, winnerSide } = match;
    if (players === undefined || names === undefined) {
      return t('history.result', { side: winnerSide + 1 });
    }
    const display = summaryNames(names, botNames, t('lobby.bot'));
    const nameOf = (seat: Seat): string => display[seat] ?? t('table.seat', { seat: seat + 1 });
    if (players === 4) {
      const pair = `${nameOf(winnerSide as Seat)} & ${nameOf(partnerOf(winnerSide as Seat))}`;
      return t('history.resultWonTeam', { names: pair });
    }
    return t('history.resultWon', { name: nameOf(winnerSide as Seat) });
  };

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
                <strong>{winnerLine(match)}</strong>
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
