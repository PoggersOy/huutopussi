/**
 * Profile scorecard: a modal opened from a "recent ranked games" row on the
 * Profile screen. It answers "who did I play, and what was the final result?"
 * from the signed-in player's own seat — a win/loss verdict, each side's roster
 * and final score (winner in gold, the player's own side highlighted), plus this
 * match's rating change. Reads only the compact `match` info the server embeds
 * in the rating event; no per-deal detail (that's the History deal-browser).
 */
import { partnerOf, type Seat, type Side, sideOf } from '@hp/engine';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { summaryNames, useBotNames } from '../botNames';
import type { RatingEvent } from '../screens/Profile';

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function ProfileScorecard({ event, onClose }: { event: RatingEvent; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const botNames = useBotNames();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const m = event.match;
  if (m === null) return null; // caller only opens rows that carry a scorecard

  const { players, winnerSide, finalScores, names, deals } = m;
  const sideCount = players === 4 ? 2 : players;
  const mySide = sideOf(event.seat, players);
  const won = mySide === winnerSide;

  // Bot seats stored no name; give them their localized bot name, matching the
  // live table. A truly unknown seat falls back to a generic seat label.
  const display = summaryNames(names ?? undefined, botNames, t('lobby.bot'));
  const nameOf = (seat: Seat): string => display[seat] ?? t('table.seat', { seat: seat + 1 });
  const seatsOfSide = (side: Side): Seat[] =>
    players === 4 ? [side as Seat, partnerOf(side as Seat)] : [side as Seat];

  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const sides = Array.from({ length: sideCount }, (_, i) => i as Side);

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2 style={{ margin: 0 }}>{t('profile.scorecardTitle')}</h2>

        <p className={`scorecard__verdict ${won ? 'delta--pos' : 'delta--neg'}`}>
          {won ? t('profile.youWon') : t('profile.youLost')}
        </p>

        <ul className="scorecard__sides">
          {sides.map((side) => {
            const isMine = side === mySide;
            const isWinner = side === winnerSide;
            return (
              <li key={side} className={`scorecard__side${isMine ? ' scorecard__side--me' : ''}`}>
                <span className="scorecard__players">
                  {seatsOfSide(side).map(nameOf).join(' & ')}
                  {isMine && <span className="scorecard__you">{t('profile.you')}</span>}
                </span>
                <span className={`scorecard__score${isWinner ? ' score--winner' : ''}`}>
                  {finalScores[side] ?? 0}
                  {isWinner && ' ★'}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="scorecard__meta dim">
          <span>{t('history.deals', { count: deals })}</span>
          <span>{dateFmt.format(event.createdAt)}</span>
        </div>

        <div className="scorecard__rating">
          <span className="scorecard__rating-label dim">{t('profile.ratingChange')}</span>
          <span className={`match-row__delta ${event.delta >= 0 ? 'delta--pos' : 'delta--neg'}`}>
            {event.delta >= 0 ? '▲' : '▼'} {signed(event.delta)}
          </span>
          <span className="match-row__after">{event.ratingAfter}</span>
        </div>

        <button type="button" className="btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
