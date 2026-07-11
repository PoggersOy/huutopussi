/**
 * Full-screen overlays for the Table screen: the per-deal score breakdown
 * (auto-replaced when the server authors the next deal) and the match-ended
 * screen with the host's rematch button. Both are parametric on the game
 * mode: 4p shows the classic us/them pair columns, 2-3p one column per
 * player (each seat is its own side).
 */
import { type DealResult, SEATS, type Seat, type Side, sideCount, sideOf } from '@hp/engine';
import type { MatchRatingResult } from '@hp/protocol';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendLobby } from '../../socket';
import { useStore } from '../../store';

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/**
 * Redeal countdown: a seat demanded a redeal, so every table shows who did it
 * and ticks down to the server-authored fresh deal. Purely presentational — the
 * store clears it (and this overlay unmounts) the instant `dealStarted` lands,
 * so the number is a friendly estimate, not the authority on when cards return.
 */
export function RedealOverlay({
  seat,
  until,
  nameOf,
}: {
  seat: Seat;
  /** Epoch ms the fresh deal is expected (store's REDEAL_COUNTDOWN_MS ahead). */
  until: number;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.ceil((until - now) / 1000));

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2>{t('overlay.redealTitle')}</h2>
        <p className="tsheet__center">{t('overlay.redealBy', { name: nameOf(seat) })}</p>
        <p className="redeal__count" aria-live="polite">
          {secs > 0 ? t('overlay.redealIn', { n: secs }) : t('overlay.redealingNow')}
        </p>
      </div>
    </div>
  );
}

/** Column order: the viewer's side first, the rest by side index. */
function sideOrder(players: 2 | 3 | 4, mySide: Side): Side[] {
  const n = players === 4 ? 2 : players;
  const sides = Array.from({ length: n }, (_, i) => i as Side);
  return [...sides].sort((a, b) => ((a - mySide + n) % n) - ((b - mySide + n) % n));
}

export function DealScoredOverlay({
  result,
  scores,
  mySide,
  players,
  nameOf,
  onClose,
}: {
  result: DealResult;
  /** Running match totals (already include this deal's deltas). */
  scores: number[];
  mySide: Side;
  players: 2 | 3 | 4;
  nameOf: (seat: Seat) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const order = sideOrder(players, mySide);
  const sideLabel = (side: Side): string =>
    players === 4 ? (side === mySide ? t('table.us') : t('table.them')) : nameOf(side as Seat);
  const cols = order.map((side) => result.sides[side]).filter((s) => s !== undefined);
  if (cols.length !== order.length) return null;

  const hasDiscards = cols.some((s) => s.discardPoints > 0);
  const hasRounding = cols.some((s) => s.roundedTotal !== s.rawTotal);
  const hasPorvoo = cols.some((s) => s.porvoo);
  const rows: Array<[string, number[]]> = [
    ['overlay.cardPoints', cols.map((s) => s.cardPoints)],
    ['overlay.lastTrick', cols.map((s) => s.lastTrickBonus)],
    ['overlay.marriages', cols.map((s) => s.marriagePoints)],
    ...(hasDiscards
      ? [['overlay.koini', cols.map((s) => s.discardPoints)] as [string, number[]]]
      : []),
    ['overlay.total', cols.map((s) => s.rawTotal)],
    ...(hasRounding
      ? [['overlay.rounded', cols.map((s) => s.roundedTotal)] as [string, number[]]]
      : []),
    ['overlay.tricks', cols.map((s) => s.tricks)],
  ];

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2>{t('event.dealScored')}</h2>
        {result.declarer === null ? (
          <p className="dim tsheet__center">{t('overlay.contractless')}</p>
        ) : (
          result.contract !== null &&
          result.made !== null && (
            <p className={result.made ? 'overlay__made' : 'overlay__failed'}>
              {t(result.made ? 'overlay.contractMade' : 'overlay.contractFailed', {
                contract: result.contract,
                name: nameOf(result.declarer),
              })}
            </p>
          )
        )}
        <table className="score">
          <thead>
            <tr>
              <th />
              {order.map((side) => (
                <th key={side}>{sideLabel(side)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, values]) => (
              <tr key={key}>
                <th>{t(key)}</th>
                {values.map((value, i) => (
                  <td key={order[i]}>{value}</td>
                ))}
              </tr>
            ))}
            {hasPorvoo && (
              <tr>
                <th className="score__porvoo">{t('table.porvoo')}</th>
                {cols.map((s, i) => (
                  <td key={order[i]} className="score__porvoo">
                    {s.porvoo ? '×' : ''}
                  </td>
                ))}
              </tr>
            )}
            <tr className="score__delta">
              <th>{t('overlay.delta')}</th>
              {cols.map((s, i) => (
                <td key={order[i]} className={s.scoreDelta >= 0 ? 'delta--pos' : 'delta--neg'}>
                  {signed(s.scoreDelta)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <p className="tsheet__center">
          <strong>
            {players === 4
              ? t('overlay.standing', {
                  us: scores[mySide] ?? 0,
                  them: scores[mySide === 0 ? 1 : 0] ?? 0,
                })
              : order.map((side, i) => (
                  <span key={side}>
                    {i > 0 && ' · '}
                    {sideLabel(side)} {scores[side] ?? 0}
                  </span>
                ))}
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
  matchRating,
}: {
  winnerSide: Side;
  scores: number[];
  /** Viewer's seat; null = spectator. */
  seat: Seat | null;
  hostSeat: Seat | null;
  mySide: Side;
  players: 2 | 3 | 4;
  nameOf: (seat: Seat) => string;
  /** Post-match Elo outcome; null when the game had no rating payload. */
  matchRating?: MatchRatingResult | null;
}) {
  const { t } = useTranslation();
  const signedIn = useStore((s) => s.auth.user !== null);
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
  const sides = Array.from({ length: sideCount({ players }) }, (_, i) => i as Side);
  const ranked = [...sides].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));

  // The signed-in viewer's Elo change (present only if this match was rated).
  const myRating =
    seat !== null && matchRating?.rated
      ? matchRating.perSeat.find((p) => p.seat === seat)
      : undefined;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2 className={won ? 'overlay__win' : undefined}>{title}</h2>
        <p className="tsheet__center">{t('overlay.winners', { names: winners })}</p>
        {players === 4 ? (
          <>
            <p className="overlay__final">
              {scores[mySide] ?? 0} — {scores[otherSide] ?? 0}
            </p>
            <p className="dim tsheet__center">
              {t('table.us')} — {t('table.them')}
            </p>
          </>
        ) : (
          <p className="overlay__final">
            {ranked.map((side, i) => (
              <span key={side} className={side === winnerSide ? 'overlay__win' : undefined}>
                {i > 0 && ' · '}
                {nameOf(side as Seat)} {scores[side] ?? 0}
              </span>
            ))}
          </p>
        )}
        {myRating ? (
          <p className="overlay__elo">
            <span className="dim">{t('rating.yourChange')}</span> <strong>{myRating.after}</strong>{' '}
            <span className={myRating.delta >= 0 ? 'delta--pos' : 'delta--neg'}>
              {signed(myRating.delta)}
            </span>
          </p>
        ) : (
          signedIn &&
          matchRating &&
          !matchRating.rated && (
            <p className="dim tsheet__center">
              <strong>{t('rating.unrated')}</strong>
              <br />
              {t('rating.unratedHint')}
            </p>
          )
        )}
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
