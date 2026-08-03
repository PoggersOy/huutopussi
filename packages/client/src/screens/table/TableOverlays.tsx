/**
 * Full-screen overlays for the Table screen: the per-deal score breakdown
 * (auto-replaced when the server authors the next deal) and the match-ended
 * screen with the host's rematch button. Both are parametric on the game
 * mode: 4p shows the classic us/them pair columns, 2-3p one column per
 * player (each seat is its own side).
 */
import {
  type DealResult,
  type RedealReason,
  SEATS,
  type Seat,
  type Side,
  sideCount,
  sideOf,
} from '@hp/engine';
import type { MatchRatingResult } from '@hp/protocol';
import { type CSSProperties, type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Confetti } from '../../components/Confetti';
import { DealBreakdownTable, DealContractLine } from '../../components/DealBreakdownTable';
import { useCountUp } from '../../countUp';
import { sendLobby } from '../../socket';
import { useStore } from '../../store';

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Per-row delay; mirrors the `--stagger` token the row slide-in uses. */
const STAGGER_MS = 55;

/** A standings figure that ticks up as its row arrives. */
function RankScore({ value, delay }: { value: number; delay: number }): ReactElement {
  return <span className="count-up">{useCountUp(value, delay)}</span>;
}

/**
 * Redeal countdown: a seat demanded a redeal, so every table shows who did it
 * and ticks down to the server-authored fresh deal. Purely presentational — the
 * store clears it (and this overlay unmounts) the instant `dealStarted` lands,
 * so the number is a friendly estimate, not the authority on when cards return.
 */
/** The exact condition each redeal reason met → its i18n clause key. */
const REDEAL_REASON_KEY: Record<RedealReason, string> = {
  fourSixes: 'overlay.redealReasonFourSixes',
  threeSixes: 'overlay.redealReasonThreeSixes',
  noneAboveJack: 'overlay.redealReasonNoneAboveJack',
};

export function RedealOverlay({
  seat,
  until,
  reason,
  nameOf,
}: {
  seat: Seat;
  /** Epoch ms the fresh deal is expected (store's REDEAL_COUNTDOWN_MS ahead). */
  until: number;
  /** The specific condition the demanding hand met, straight from the event. */
  reason: RedealReason;
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
        <p className="tsheet__center">
          {t('overlay.redealByReason', {
            name: nameOf(seat),
            reason: t(REDEAL_REASON_KEY[reason]),
          })}
        </p>
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

/**
 * On-demand current standings ("Näytä tilanne"): the running match total for
 * every side, best first, with the viewer's own row highlighted. The top bar
 * now shows only this device's own score, so this is where you check everyone
 * else. 4p rows are the pair ("Anni & Ben"); 2-3p each seat is its own side.
 */
export function StandingsOverlay({
  scores,
  mySide,
  players,
  nameOf,
  onClose,
}: {
  /** Running match totals (index === side). */
  scores: number[];
  mySide: Side;
  players: 2 | 3 | 4;
  nameOf: (seat: Seat) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const sideMembers = (side: Side): string =>
    SEATS.slice(0, players)
      .filter((s) => sideOf(s, players) === side)
      .map((s) => nameOf(s))
      .join(' & ');
  const sides = Array.from({ length: sideCount({ players }) }, (_, i) => i as Side);
  const ranked = [...sides].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const MEDALS = ['🥇', '🥈', '🥉'];

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <h2>{t('overlay.standingsTitle')}</h2>
        <ul className="overlay__standings">
          {ranked.map((side, i) => (
            <li
              key={side}
              style={{ '--r': i } as CSSProperties}
              className={`overlay__rank${side === mySide ? ' overlay__rank--you' : ''}`}
            >
              <span className="overlay__rank-medal" aria-hidden="true">
                {MEDALS[i] ?? ''}
              </span>
              <span className="overlay__rank-name">{sideMembers(side)}</span>
              {/* No count-up here: you opened this panel to READ the numbers. */}
              <span className="overlay__rank-score">{scores[side] ?? 0}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
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

  // Läpäri: one side took every trick of the deal. Derived from the result (no
  // config needed — a side's tricks equalling the deal's total is a clean sweep).
  const totalTricks = result.sides.reduce((a, s) => a + s.tricks, 0);
  const sweepSide = totalTricks > 0 ? result.sides.findIndex((s) => s.tricks === totalTricks) : -1;
  const laapari = sweepSide >= 0;
  const laapariMine = laapari && (sweepSide as Side) === mySide;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        {laapari && (
          <div className={`laapari${laapariMine ? ' laapari--mine' : ''}`}>
            <Confetti count={50} />
            <span className="laapari__word">
              <span className="laapari__shock" aria-hidden="true" />
              {t('overlay.laapari')}
            </span>
            <span className="laapari__by dim">
              {t('overlay.laapariBy', { name: sideLabel(sweepSide as Side) })}
            </span>
          </div>
        )}
        <h2>{t('overlay.dealResults')}</h2>
        <DealContractLine result={result} nameOf={nameOf} />
        <DealBreakdownTable
          result={result}
          scores={scores}
          order={order}
          sideLabel={sideLabel}
          animate
        />
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
  /** 4p plays in pairs ("us/them"); 2-3p is every player for themselves. */
  const isTeam = players === 4;

  // The members of a side, joined: a pair like "Anni & Ben" in 4p, or a single
  // name in 2-3p (where each seat is its own side).
  const sideMembers = (side: Side): string =>
    SEATS.slice(0, players)
      .filter((s) => sideOf(s, players) === side)
      .map((s) => nameOf(s))
      .join(' & ');

  const won = seat !== null && winnerSide === mySide;
  const title =
    seat === null
      ? t('overlay.matchOver')
      : isTeam
        ? won
          ? t('overlay.winTeam') // "Te voititte!"
          : t('overlay.loseTeam') // "Te hävisitte!"
        : won
          ? t('overlay.winSolo') // "Sinä voitit!"
          : t('overlay.loseSolo'); // "Sinä hävisit!"
  const isHost = seat !== null && seat === hostSeat;

  // Final standings, best score first — but the actual winner (decided by the
  // engine's tiebreak, not by raw points) always takes gold, even on an exact tie.
  const sides = Array.from({ length: sideCount({ players }) }, (_, i) => i as Side);
  const ranked = [...sides].sort((a, b) => {
    if (a === winnerSide) return -1;
    if (b === winnerSide) return 1;
    return (scores[b] ?? 0) - (scores[a] ?? 0);
  });
  const MEDALS = ['🥇', '🥈', '🥉'];

  // Name the winners only where the title doesn't already: the 4p winning pair,
  // and for a spectator (for whom nobody is "you"). In 2-3p the singular title
  // plus the gold medal below say it all.
  const showWinners = isTeam || seat === null;

  // The signed-in viewer's Elo change (present only if this match was rated).
  const myRating =
    seat !== null && matchRating?.rated
      ? matchRating.perSeat.find((p) => p.seat === seat)
      : undefined;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        {won && <Confetti count={90} />}
        <h2 className={won ? 'overlay__win' : undefined}>{title}</h2>
        {showWinners && (
          <p className="tsheet__center">
            {t('overlay.winners', { names: sideMembers(winnerSide) })}
          </p>
        )}
        <ul className="overlay__standings">
          {ranked.map((side, i) => (
            <li
              key={side}
              style={{ '--r': i } as CSSProperties}
              className={`overlay__rank${side === winnerSide ? ' overlay__rank--winner' : ''}`}
            >
              <span className="overlay__rank-medal" aria-hidden="true">
                {MEDALS[i] ?? ''}
              </span>
              <span className="overlay__rank-name">{sideMembers(side)}</span>
              <span className="overlay__rank-score">
                <RankScore value={scores[side] ?? 0} delay={i * STAGGER_MS} />
              </span>
            </li>
          ))}
        </ul>
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
