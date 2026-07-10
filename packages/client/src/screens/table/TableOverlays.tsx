/**
 * Full-screen overlays for the Table screen: the per-deal score breakdown
 * (auto-replaced when the server authors the next deal) and the match-ended
 * screen with the host's rematch button.
 */
import { type DealResult, SEATS, type Seat, type Side, sideOf } from '@hp/engine';
import { useTranslation } from 'react-i18next';
import { sendLobby } from '../../socket';

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function DealScoredOverlay({
  result,
  scores,
  mySide,
  nameOf,
  onClose,
}: {
  result: DealResult;
  /** Running match totals (already include this deal's deltas). */
  scores: number[];
  mySide: Side;
  nameOf: (seat: Seat) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const otherSide: Side = mySide === 0 ? 1 : 0;
  const us = result.sides[mySide];
  const them = result.sides[otherSide];
  if (us === undefined || them === undefined) return null;
  const rows: Array<[string, number, number]> = [
    ['overlay.cardPoints', us.cardPoints, them.cardPoints],
    ['overlay.lastTrick', us.lastTrickBonus, them.lastTrickBonus],
    ['overlay.marriages', us.marriagePoints, them.marriagePoints],
    ['overlay.total', us.rawTotal, them.rawTotal],
    ['overlay.tricks', us.tricks, them.tricks],
  ];

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2>{t('event.dealScored')}</h2>
        {result.declarer !== null && result.contract !== null && result.made !== null && (
          <p className={result.made ? 'overlay__made' : 'overlay__failed'}>
            {t(result.made ? 'overlay.contractMade' : 'overlay.contractFailed', {
              contract: result.contract,
              name: nameOf(result.declarer),
            })}
          </p>
        )}
        <table className="score">
          <thead>
            <tr>
              <th />
              <th>{t('table.us')}</th>
              <th>{t('table.them')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, usValue, themValue]) => (
              <tr key={key}>
                <th>{t(key)}</th>
                <td>{usValue}</td>
                <td>{themValue}</td>
              </tr>
            ))}
            {(us.porvoo || them.porvoo) && (
              <tr>
                <th className="score__porvoo">{t('table.porvoo')}</th>
                <td className="score__porvoo">{us.porvoo ? '×' : ''}</td>
                <td className="score__porvoo">{them.porvoo ? '×' : ''}</td>
              </tr>
            )}
            <tr className="score__delta">
              <th>{t('overlay.delta')}</th>
              <td className={us.scoreDelta >= 0 ? 'delta--pos' : 'delta--neg'}>
                {signed(us.scoreDelta)}
              </td>
              <td className={them.scoreDelta >= 0 ? 'delta--pos' : 'delta--neg'}>
                {signed(them.scoreDelta)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="tsheet__center">
          <strong>
            {t('overlay.standing', { us: scores[mySide] ?? 0, them: scores[otherSide] ?? 0 })}
          </strong>
        </p>
        <p className="dim tsheet__center">{t('overlay.nextDeal')}</p>
        <button type="button" className="btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

export function MatchEndedOverlay({
  winnerSide,
  scores,
  seat,
  hostSeat,
  mySide,
  players,
  nameOf,
}: {
  winnerSide: Side;
  scores: number[];
  /** Viewer's seat; null = spectator. */
  seat: Seat | null;
  hostSeat: Seat | null;
  mySide: Side;
  players: 2 | 3 | 4;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const otherSide: Side = mySide === 0 ? 1 : 0;
  const winners = SEATS.slice(0, players)
    .filter((s) => sideOf(s, players) === winnerSide)
    .map((s) => nameOf(s))
    .join(' & ');
  const won = seat !== null && winnerSide === mySide;
  const title =
    seat === null
      ? t('table.matchOver', { side: winnerSide + 1 })
      : won
        ? t('overlay.victory')
        : t('overlay.defeat');
  const isHost = seat !== null && seat === hostSeat;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2 className={won ? 'overlay__win' : undefined}>{title}</h2>
        <p className="tsheet__center">{t('overlay.winners', { names: winners })}</p>
        <p className="overlay__final">
          {scores[mySide] ?? 0} — {scores[otherSide] ?? 0}
        </p>
        <p className="dim tsheet__center">
          {t('table.us')} — {t('table.them')}
        </p>
        {isHost ? (
          <button
            type="button"
            className="btn--primary tsheet__big"
            onClick={() => sendLobby({ type: 'rematch' })}
          >
            {t('lobby.rematch')}
          </button>
        ) : (
          <p className="dim tsheet__center">{t('overlay.waitRematch')}</p>
        )}
      </div>
    </div>
  );
}
