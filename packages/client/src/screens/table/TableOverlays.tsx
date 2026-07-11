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
import { DealBreakdownTable, DealContractLine } from '../../components/DealBreakdownTable';
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

/**
 * Client-side estimate of the pause before a multi-human game auto-advances —
 * mirrors the server's nextDealDelayMs minus the score-reveal hold (the overlay
 * only appears once the final trick has been shown). Cosmetic: the overlay
 * really unmounts when the fresh `dealStarted` lands.
 */
const NEXT_DEAL_COUNTDOWN_MS = 17_000;

/** Live countdown to the server's auto-advance (multi-human games only). */
function NextDealCountdown() {
  const { t } = useTranslation();
  const [deadline] = useState(() => Date.now() + NEXT_DEAL_COUNTDOWN_MS);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <p className="dim tsheet__center" aria-live="polite">
      {secs > 0 ? t('overlay.nextDealIn', { n: secs }) : t('overlay.nextDealSoon')}
    </p>
  );
}

/**
 * How the deal-results overlay moves on: a solo-vs-bots game is player-paced
 * (the seated human clicks "Jatka" — no timer); a multi-human game shows a
 * countdown to the server's auto-advance and no button (nothing to see while
 * waiting).
 */
function NextDealPrompt({ solo, seated }: { solo: boolean; seated: boolean }) {
  const { t } = useTranslation();
  if (!solo) return <NextDealCountdown />;
  if (!seated) return <p className="dim tsheet__center">{t('overlay.nextDealSoon')}</p>;
  return (
    <button
      type="button"
      className="btn--primary tsheet__big"
      onClick={() => sendLobby({ type: 'nextDeal' })}
    >
      {t('overlay.continue')}
    </button>
  );
}

export function DealScoredOverlay({
  result,
  scores,
  mySide,
  players,
  nameOf,
  solo,
  seated,
}: {
  result: DealResult;
  /** Running match totals (already include this deal's deltas). */
  scores: number[];
  mySide: Side;
  players: 2 | 3 | 4;
  nameOf: (seat: Seat) => string;
  /** Solo-vs-bots game → player-paced "Jatka"; else a next-deal countdown. */
  solo: boolean;
  /** This viewer holds a seat (only a seated player can press "Jatka"). */
  seated: boolean;
}) {
  const { t } = useTranslation();
  const order = sideOrder(players, mySide);
  const sideLabel = (side: Side): string =>
    players === 4 ? (side === mySide ? t('table.us') : t('table.them')) : nameOf(side as Seat);

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2>{t('overlay.dealResults')}</h2>
        <DealContractLine result={result} nameOf={nameOf} />
        <DealBreakdownTable result={result} scores={scores} order={order} sideLabel={sideLabel} />
        <NextDealPrompt solo={solo} seated={seated} />
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
  onLeave,
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
  /** Tear down the connection and return to the home screen. */
  onLeave: () => void;
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
        {/* Always an escape hatch: if the host never starts a rematch (e.g. left
            and a bot is filling in), nobody should be stranded on this screen. */}
        <button type="button" className="btn--ghost" onClick={onLeave}>
          {t('overlay.backToMenu')}
        </button>
      </div>
    </div>
  );
}
