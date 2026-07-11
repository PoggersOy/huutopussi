/**
 * Table — the core game screen (docs/plan.md §6). Portrait-first layout:
 * top bar (scores / contract / trump / deal#), felt with the three other
 * seats + current trick, hint-driven bottom sheet, own hand fan with
 * TWO-STEP play (tap raises, tap again plays, tap elsewhere lowers).
 *
 * UI legality comes ONLY from server-sent `turn.hints`; nothing is recomputed
 * locally and there are no optimistic game mutations — the raised card shows
 * a spinner until the confirming snapshot arrives. Speech bubbles and the
 * trick-winner flash are derived in the store from each update's event+diff.
 */
import '../styles/table.css';
import {
  type ActionHint,
  activeSeats,
  type Card,
  type DealView,
  type PlayerView,
  partnerOf,
  type Seat,
  type Side,
  sideOf,
} from '@hp/engine';
import type { SeatInfo } from '@hp/protocol';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CardBack, CardFace } from '../components/CardFace';
import { disconnect, sendAction, sendLobby } from '../socket';
import { type CompletedTrick, type SpeechBubble, useStore } from '../store';
import { DealScoredOverlay, MatchEndedOverlay, RedealOverlay } from './table/TableOverlays';
import {
  AnswerWholeSheet,
  BiddingSheet,
  ContractSheet,
  DeclarationSheet,
  DiscardSheet,
  ExchangeSheet,
  type PlayHint,
} from './table/TableSheets';
import { actorOf, feltSlot, SUIT_GLYPH, useNameOf } from './table/tableUtils';

const BUBBLE_MS = 5_000;
const TRICK_LINGER_MS = 1_300;
/**
 * After the FINAL trick of a deal, the score card is held back this long so the
 * last card played + who took the trick stay visible before it covers the felt.
 * The final trick's cards/flash linger on the felt for the same span.
 */
const SCORED_REVEAL_MS = 3_000;

/**
 * Renders a speech bubble's text. The trump announcement gets special treatment:
 * its suit glyph is wrapped in a `suit--*` span so the bubble can tint it red/
 * black (see `.bubble--trump` in table.css); everything else is a plain string.
 */
function BubbleText({ bubble }: { bubble: SpeechBubble }): ReactElement {
  const { t } = useTranslation();
  if (bubble.code === 'bubble.trump' && bubble.params) {
    return (
      <Trans
        i18nKey={bubble.code}
        values={bubble.params}
        components={{ suit: <span className={`suit--${bubble.params.suitCode}`} /> }}
      />
    );
  }
  return <>{t(bubble.code, bubble.params ?? {})}</>;
}

/** Countdown appears only once this few seconds remain (a late "act soon" nudge). */
const VISIBLE_SECONDS = 15;
/** …and becomes urgent (big, red, pulsing) at/under this many. */
const URGENT_SECONDS = 10;

/** Whole seconds left until `deadline` (epoch ms), re-computed ~4×/second. */
function useSecondsLeft(deadline: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * The acting player's countdown ("…3, 2, 1"), shown only on your own turn while
 * a deadline is live (i.e. autoplay is on) and ONLY in the final VISIBLE_SECONDS
 * — it stays hidden until you're running low, then appears (and goes urgent
 * under URGENT_SECONDS) so you act before a bot takes over. Rendered inside the
 * felt (bottom centre); taps pass through to the felt (pointer-events: none).
 */
function TurnCountdown({ deadline }: { deadline: number }): ReactElement | null {
  const { t } = useTranslation();
  const secs = useSecondsLeft(deadline);
  if (secs > VISIBLE_SECONDS) return null;
  const urgent = secs <= URGENT_SECONDS;
  return (
    <div
      className={`turn-timer${urgent ? ' turn-timer--urgent' : ''}`}
      role="timer"
      aria-label={t('table.timeLeft', { n: secs })}
    >
      <span className="turn-timer__num">{secs}</span>
      <span className="turn-timer__unit">{t('table.secondsShort')}</span>
    </div>
  );
}

export function Table() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const view = useStore((s) => s.server.view);
  const room = useStore((s) => s.server.room);
  const seat = useStore((s) => s.server.seat);
  const turn = useStore((s) => s.server.turn);
  const bubbles = useStore((s) => s.ui.bubbles);
  const dismissBubble = useStore((s) => s.dismissBubble);
  const completedTrick = useStore((s) => s.ui.completedTrick);
  const clearCompletedTrick = useStore((s) => s.clearCompletedTrick);
  const raisedCard = useStore((s) => s.ui.raisedCard);
  const raiseCard = useStore((s) => s.raiseCard);
  const pending = useStore((s) => s.ui.pendingActionId) !== null;
  const redeal = useStore((s) => s.ui.redeal);
  const matchRating = useStore((s) => s.ui.matchRating);
  const nameOf = useNameOf();

  // Primitives the reveal/linger effects key off (computed before the early
  // return so the hooks below always run). `dealScored` = the final trick has
  // been played and the deal is now scored.
  const dealScored = view?.deal?.phase.name === 'scored';
  const dealIndex = view?.dealIndex ?? null;

  // Speech bubbles auto-dismiss a fixed span after EACH first appears. Timers
  // are keyed by bubble id in a ref so an unrelated bubble arriving — frequent
  // in bot games, where every action rebuilds the `bubbles` array — never
  // resets a live bubble's clock (the old array-keyed effect did, so bubbles
  // could linger far past BUBBLE_MS whenever updates kept flowing).
  const bubbleTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = bubbleTimers.current;
    const live = new Set(bubbles.map((b) => b.id));
    for (const b of bubbles) {
      if (timers.has(b.id)) continue;
      timers.set(
        b.id,
        setTimeout(() => {
          timers.delete(b.id);
          dismissBubble(b.id);
        }, BUBBLE_MS),
      );
    }
    // Drop timers for bubbles that already vanished (replaced / deal boundary).
    for (const [id, timer] of timers) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
  }, [bubbles, dismissBubble]);
  // Clear every pending bubble timer on unmount.
  useEffect(
    () => () => {
      for (const timer of bubbleTimers.current.values()) clearTimeout(timer);
      bubbleTimers.current.clear();
    },
    [],
  );

  // The completed trick lingers briefly (winner flash), then the felt clears.
  // The FINAL trick lingers longer (SCORED_REVEAL_MS) so it stays on the felt
  // for the whole beat the score card is held back.
  useEffect(() => {
    if (completedTrick === null) return;
    const linger = dealScored ? SCORED_REVEAL_MS : TRICK_LINGER_MS;
    const timer = setTimeout(() => clearCompletedTrick(completedTrick.id), linger);
    return () => clearTimeout(timer);
  }, [completedTrick, clearCompletedTrick, dealScored]);

  /**
   * Hold the score card back for a beat after the FINAL trick so the last card
   * played + the trick-winner flash are seen before it covers the felt. We hold
   * ONLY when the deal transitions into `scored` by live play — a snapshot that
   * arrives already-scored (reconnect/resync) reveals at once. `scoredHeldFor`
   * is the deal index currently being withheld (null = reveal now).
   */
  const [scoredHeldFor, setScoredHeldFor] = useState<number | null>(null);
  const prevScoredRef = useRef<{ dealIndex: number | null; scored: boolean }>({
    dealIndex: null,
    scored: false,
  });
  useEffect(() => {
    const prev = prevScoredRef.current;
    prevScoredRef.current = { dealIndex, scored: dealScored };
    const justScoredByPlay =
      dealScored && !prev.scored && prev.dealIndex === dealIndex && dealIndex !== null;
    if (!justScoredByPlay) {
      if (!dealScored) setScoredHeldFor(null);
      return;
    }
    setScoredHeldFor(dealIndex);
    const timer = setTimeout(() => setScoredHeldFor(null), SCORED_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [dealScored, dealIndex]);

  /** Host's "Stop game" confirmation dialog is open. */
  const [confirmStop, setConfirmStop] = useState(false);
  /** A non-host's "Leave game" confirmation dialog is open. */
  const [confirmLeave, setConfirmLeave] = useState(false);

  /** Tear down the connection and go home (used by leave / match-over exit). */
  const leaveToHome = (): void => {
    disconnect();
    navigate('/');
  };

  if (view === null || room === null) {
    return (
      <div className="screen">
        <div
          className="screen__main stack"
          style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}
        >
          <p className="dim">{t('common.loading')}</p>
          <button type="button" className="btn--ghost" onClick={leaveToHome}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  const deal = view.deal;
  const players = view.config.players;
  const me: Seat = seat ?? 0; // spectators watch from seat 0's angle
  const mySide = sideOf(me, players);
  const myTurn = seat !== null && turn !== null && turn.seat === seat;
  const hints: ActionHint[] = (myTurn && turn !== null ? turn.hints : null) ?? [];

  const playHint = hints.find((h): h is PlayHint => h.type === 'playCard') ?? null;
  const bidHint = hints.find((h) => h.type === 'bid') ?? null;
  const contractHint = hints.find((h) => h.type === 'setContract') ?? null;
  const declHint = hints.find((h) => h.type === 'declaration') ?? null;
  const answerHint = hints.find((h) => h.type === 'answerWhole') ?? null;
  const giveHint = hints.find((h) => h.type === 'giveCards') ?? null;
  const returnHint = hints.find((h) => h.type === 'returnCards') ?? null;
  const discardHint = hints.find((h) => h.type === 'discardCards') ?? null;
  /** Redeal during the exchange window (illisoft redealWindow 'bidAndExchange'). */
  const canRedealNow = hints.some((h) => h.type === 'demandRedeal');
  const selectCount = giveHint?.count ?? returnHint?.count ?? discardHint?.count ?? null;
  /** Multi-select legality (koini discard: no aces or tens) — from the hint only. */
  const selectLegal = discardHint?.legal ?? null;

  const actor: Seat | null = turn?.seat ?? (deal !== null ? actorOf(deal, players) : null);
  const actorName = actor !== null ? nameOf(actor) : '';

  const isHost = seat !== null && room.hostSeat === seat;
  const scoredResult = deal !== null && deal.phase.name === 'scored' ? deal.phase.result : null;
  const showMatchOverlay = view.winnerSide !== null;
  /** The score/match card is held back this render while the final trick shows. */
  const holding = scoredHeldFor === view.dealIndex;
  const showScoredOverlay = !showMatchOverlay && !holding && scoredResult !== null;
  // Solo-vs-bots (one human, rest bots): the deal-results overlay is player-
  // paced ("Jatka"); a multi-human game shows a next-deal countdown instead.
  const soloVsBots = room.seats.filter((s) => s.kind === 'human').length === 1;

  let sheet: ReactElement | null = null;
  if (deal !== null && !showMatchOverlay) {
    switch (deal.phase.name) {
      case 'bidding':
        sheet = (
          <BiddingSheet phase={deal.phase} hint={bidHint} actorName={actorName} nameOf={nameOf} />
        );
        break;
      case 'exchangeGive':
      case 'exchangeReturn': {
        const isGive = deal.phase.name === 'exchangeGive';
        const target =
          deal.declarer === null ? null : isGive ? deal.declarer : partnerOf(deal.declarer);
        sheet = (
          <ExchangeSheet
            mode={isGive ? 'give' : 'return'}
            count={selectCount}
            targetName={target !== null ? nameOf(target) : ''}
            actorName={actorName}
            canDemandRedeal={canRedealNow}
          />
        );
        break;
      }
      case 'exchangeDiscard':
        sheet = (
          <DiscardSheet
            hint={discardHint}
            actorName={actorName}
            dealIndex={view.dealIndex}
            canDemandRedeal={canRedealNow}
          />
        );
        break;
      case 'exchangeContract':
        sheet = (
          <ContractSheet hint={contractHint} actorName={actorName} canDemandRedeal={canRedealNow} />
        );
        break;
      case 'awaitWholeAnswer':
        sheet = <AnswerWholeSheet hint={answerHint} actorName={actorName} config={view.config} />;
        break;
      case 'lead':
        if (declHint !== null) {
          sheet = <DeclarationSheet hint={declHint} config={view.config} />;
        }
        break;
      default:
        break;
    }
  }

  const myBubble = seat !== null ? (bubbles.find((b) => b.seat === seat) ?? null) : null;

  function onFeltTap(): void {
    if (raisedCard !== null && !pending) raiseCard(null);
  }

  return (
    <div className="screen screen--table">
      {/* TopBar + host strip share one grid row so the felt keeps the 1fr track
          (the grid template has exactly four rows: header / felt / sheet / hand). */}
      <div className="ttop-wrap">
        <TopBar view={view} mySide={mySide} actor={actor} myTurn={myTurn} nameOf={nameOf} />
        {view.winnerSide === null && (
          <div className="thostbar">
            {/* The host stops the game for everyone; anyone else can bail out to
                the menu (a bot fills their seat) so no one is stuck if the host
                goes silent. */}
            <button
              type="button"
              className="btn--ghost thostbar__stop"
              onClick={() => (isHost ? setConfirmStop(true) : setConfirmLeave(true))}
            >
              {isHost ? t('table.stop') : t('table.leave')}
            </button>
          </div>
        )}
      </div>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: tap-anywhere-to-lower is a touch affordance; keyboard users act via the card buttons */}
      <main className="felt" onClick={onFeltTap}>
        {deal === null ? (
          <p className="felt__idle dim">{t('common.loading')}</p>
        ) : (
          <>
            {activeSeats(players)
              .filter((other) => other !== me)
              .map((other) => {
                const info = room.seats[other];
                if (info === undefined) return null;
                const slot = feltSlot(me, other, players);
                return (
                  <OpponentPanel
                    key={other}
                    pos={slot === 1 ? 'left' : slot === 3 ? 'right' : 'top'}
                    info={info}
                    name={nameOf(other)}
                    count={deal.handCounts[other]}
                    isTurn={actor === other && view.winnerSide === null}
                    isDealer={view.dealer === other}
                    isDeclarer={deal.declarer === other}
                    bubble={bubbles.find((b) => b.seat === other) ?? null}
                  />
                );
              })}
            <FeltPiles deal={deal} />
            {deal.talonSeen !== null && <TalonStrip cards={deal.talonSeen} />}
            <TrickArea
              deal={deal}
              me={me}
              players={players}
              completedTrick={completedTrick}
              nameOf={nameOf}
            />
            <LastTrickPeek deal={deal} hidden={completedTrick !== null} nameOf={nameOf} />
            {myTurn && turn?.deadline != null && view.winnerSide === null && (
              <TurnCountdown deadline={turn.deadline} />
            )}
            {myBubble !== null && (
              <div
                className={`bubble bubble--me${myBubble.code === 'bubble.trump' ? ' bubble--trump' : ''}`}
              >
                <BubbleText bubble={myBubble} />
              </div>
            )}
          </>
        )}
      </main>

      {sheet}

      <footer className={`thand${myTurn && contractHint === null ? ' thand--turn' : ''}`}>
        {raisedCard !== null && playHint !== null && !pending && (
          <p className="thand__hint dim">{t('table.tapAgain')}</p>
        )}
        <HandFan
          hand={deal?.hand ?? []}
          playHint={playHint}
          selectCount={selectCount}
          selectLegal={selectLegal}
        />
      </footer>

      {redeal !== null && !showMatchOverlay && (
        <RedealOverlay seat={redeal.seat} until={redeal.until} nameOf={nameOf} />
      )}
      {showScoredOverlay && scoredResult !== null && (
        <DealScoredOverlay
          result={scoredResult}
          scores={view.scores}
          mySide={mySide}
          players={players}
          nameOf={nameOf}
          solo={soloVsBots}
          seated={seat !== null}
        />
      )}
      {showMatchOverlay && !holding && view.winnerSide !== null && (
        <MatchEndedOverlay
          winnerSide={view.winnerSide}
          scores={view.scores}
          seat={seat}
          hostSeat={room.hostSeat}
          mySide={mySide}
          players={players}
          nameOf={nameOf}
          matchRating={matchRating}
          onLeave={leaveToHome}
        />
      )}
      {confirmStop && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="overlay__panel stack">
            <h2>{t('table.stopTitle')}</h2>
            <p className="tsheet__center">{t('table.stopConfirm')}</p>
            <button
              type="button"
              className="btn--danger"
              onClick={() => {
                // Ask the server to abandon the match + close the room (drops the
                // other players), then leave straight to Home. We navigate on our
                // own instead of waiting for the server's WS close: that close
                // code (4000) can be rewritten to 1006 by a proxy, in which case
                // the socket layer would reconnect forever and strand the host on
                // the "reconnecting…" banner.
                sendLobby({ type: 'stopMatch' });
                setConfirmStop(false);
                leaveToHome();
              }}
            >
              {t('table.stop')}
            </button>
            <button type="button" className="btn--ghost" onClick={() => setConfirmStop(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {confirmLeave && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="overlay__panel stack">
            <h2>{t('table.leaveTitle')}</h2>
            <p className="tsheet__center">{t('table.leaveConfirm')}</p>
            <button
              type="button"
              className="btn--danger"
              onClick={() => {
                // Just this player leaves — no server command needed; the server
                // sees the drop and a bot fills the seat. We navigate ourselves
                // rather than wait on the WS close (a proxy can turn it into an
                // endless "reconnecting…").
                setConfirmLeave(false);
                leaveToHome();
              }}
            >
              {t('table.leave')}
            </button>
            <button type="button" className="btn--ghost" onClick={() => setConfirmLeave(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Top bar ──────────────────────────────────────────────────────────────────

function TopBar({
  view,
  mySide,
  actor,
  myTurn,
  nameOf,
}: {
  view: PlayerView;
  mySide: Side;
  actor: Seat | null;
  myTurn: boolean;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const deal = view.deal;
  const players = view.config.players;
  const trump = deal?.trump ?? null;
  const otherSide = mySide === 0 ? 1 : 0;
  const usScore = view.scores[mySide] ?? 0;
  const themScore = view.scores[otherSide] ?? 0;

  let contractLabel: string | null = null;
  if (deal !== null) {
    if (deal.contract !== null && deal.declarer !== null) {
      contractLabel = `${t('table.contract')} ${deal.contract} — ${nameOf(deal.declarer)}`;
    } else if (deal.bid !== null) {
      contractLabel = `${t('table.bid')} ${deal.bid.amount} — ${nameOf(deal.bid.seat)}`;
    } else if (deal.phase.name === 'bidding' && deal.phase.highBid !== null) {
      contractLabel = `${t('table.bid')} ${deal.phase.highBid.amount} — ${nameOf(deal.phase.highBid.seat)}`;
    } else if (deal.phase.name !== 'bidding' && deal.declarer === null) {
      // Contract-less deal (illisoft: everyone said "Ohi").
      contractLabel = t('table.contractless');
    }
  }

  // 4p: us/them. 2-3p: every seat is its own side — per-player labels, me first.
  const mySeatFirst =
    players === 4
      ? []
      : [...activeSeats(players)].sort(
          (a, b) => ((a - mySide + players) % players) - ((b - mySide + players) % players),
        );

  return (
    <header className="ttop">
      <div className="ttop__row">
        <span>
          {players === 4 ? (
            <>
              <strong>
                {t('table.us')} {usScore}
              </strong>
              <span className="dim">
                {' · '}
                {t('table.them')} {themScore}
              </span>
            </>
          ) : (
            mySeatFirst.map((seat, i) => (
              <span key={seat} className={seat === (mySide as Seat) ? undefined : 'dim'}>
                {i > 0 && ' · '}
                {nameOf(seat)} {view.scores[sideOf(seat, players)] ?? 0}
              </span>
            ))
          )}
        </span>
        {/* key on `trump` remounts the chip when trump changes, restarting the
            attention flash (see `.ttop__trump` in table.css). */}
        <span
          key={trump ?? 'none'}
          className={trump !== null ? `ttop__trump suit--${trump}` : 'dim'}
        >
          {trump !== null ? `${SUIT_GLYPH[trump]} ${t(`suit.${trump}`)}` : t('table.noTrump')}
        </span>
        <span className="dim">{t('table.deal', { n: view.dealIndex + 1 })}</span>
      </div>
      <div className="ttop__row">
        <span className="dim">{contractLabel ?? t('sheet.noBids')}</span>
        <span className={myTurn ? 'ttop__me' : 'dim'}>
          {view.winnerSide === null &&
            actor !== null &&
            (myTurn ? t('table.yourTurn') : nameOf(actor))}
        </span>
      </div>
    </header>
  );
}

// ── Opponent / partner panels ────────────────────────────────────────────────

function OpponentPanel({
  pos,
  info,
  name,
  count,
  isTurn,
  isDealer,
  isDeclarer,
  bubble,
}: {
  pos: 'left' | 'top' | 'right';
  info: SeatInfo;
  name: string;
  count: number;
  isTurn: boolean;
  isDealer: boolean;
  isDeclarer: boolean;
  bubble: SpeechBubble | null;
}) {
  const { t } = useTranslation();
  const offline = info.kind === 'human' && !info.connected;
  const backs = Array.from({ length: count }, (_, i) => `back-${i}`);

  return (
    <div className={`opp opp--${pos}${isTurn ? ' opp--turn' : ''}`}>
      <div className="opp__name">
        <span className={`dot${offline ? ' dot--off' : ''}`} aria-hidden="true" />
        <span className="opp__nick">{name}</span>
        {isDealer && (
          <span className="chip chip--gold" title={t('table.dealer')}>
            {t('table.dealerChip')}
          </span>
        )}
      </div>
      <div className="opp__fan">
        {backs.map((id) => (
          <CardBack key={id} width="var(--card-w-opp)" />
        ))}
        <span className="opp__count dim">{count}</span>
      </div>
      <div className="opp__badges">
        {info.kind === 'bot' && <span className="chip">{t('lobby.bot')}</span>}
        {info.botControlled && <span className="chip chip--warn">{t('lobby.botControlled')}</span>}
        {offline && <span className="chip chip--off">{t('lobby.disconnected')}</span>}
        {isDeclarer && <span className="chip chip--gold">{t('table.declarer')}</span>}
      </div>
      {bubble !== null && (
        <div className={`bubble${bubble.code === 'bubble.trump' ? ' bubble--trump' : ''}`}>
          <BubbleText bubble={bubble} />
        </div>
      )}
    </div>
  );
}

// ── Center: current trick (positioned per relative seat) ────────────────────

function TrickArea({
  deal,
  me,
  players,
  completedTrick,
  nameOf,
}: {
  deal: DealView;
  me: Seat;
  players: 2 | 3 | 4;
  completedTrick: CompletedTrick | null;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const livePlays = deal.phase.name === 'follow' ? deal.phase.plays : [];
  const plays = completedTrick !== null ? completedTrick.plays : livePlays;
  const winner = completedTrick?.winner ?? null;

  let label: string | null = null;
  if (winner !== null) {
    label = t('table.trickWonBy', { name: nameOf(winner) });
  } else if (deal.phase.name === 'lead') {
    label =
      deal.phase.leader === me
        ? t('table.youLead')
        : t('table.leadsNow', { name: nameOf(deal.phase.leader) });
  }

  // When the trick is won, the whole card group slides toward the winner's felt
  // slot (`trick--to-p{n}`) after the gold winner-flash — see `.trick__cards` in
  // table.css. The `trick__cards` wrapper lets the group translate as one while
  // each card keeps its own entrance + winner flash, and the label stays put.
  const winSlot = winner !== null ? feltSlot(me, winner, players) : null;

  return (
    <div className={`trick${winSlot !== null ? ` trick--won trick--to-p${winSlot}` : ''}`}>
      <div className="trick__cards">
        {plays.map((play) => (
          <div
            key={`${play.seat}-${play.card}`}
            className={`trick__card trick__card--p${feltSlot(me, play.seat, players)}${
              winner === play.seat ? ' trick__card--win' : ''
            }`}
          >
            <CardFace card={play.card} width="var(--card-w-md)" />
          </div>
        ))}
      </div>
      {label !== null && <span className="trick__label dim">{label}</span>}
    </div>
  );
}

// ── 2-3p felt fixtures: koinipakka / dummy piles + the open-talon strip ──────

function FeltPiles({ deal }: { deal: DealView }) {
  const { t } = useTranslation();
  const showTalon = deal.talonCount !== null && deal.talonCount > 0;
  const showDummy = deal.dummyHandCount !== null;
  if (!showTalon && !showDummy) return null;
  return (
    <div className="felt-piles">
      {showTalon && (
        <div className="felt-pile">
          <CardBack width="var(--card-w-opp)" />
          <span className="dim">
            {t('table.talon')} {deal.talonCount}
          </span>
        </div>
      )}
      {showDummy && (
        <div className="felt-pile">
          <CardBack width="var(--card-w-opp)" />
          <span className="dim">
            {t('table.dummy')} {deal.dummyHandCount}
          </span>
        </div>
      )}
    </div>
  );
}

/** Avoin koini: everyone sees the koinipakka faces during the whole first trick. */
function TalonStrip({ cards }: { cards: Card[] }) {
  const { t } = useTranslation();
  return (
    <div className="talon-strip">
      <span className="talon-strip__label dim">{t('table.openTalon')}</span>
      <div className="talon-strip__cards">
        {cards.map((card) => (
          <CardFace key={card} card={card} width="var(--card-w-sm)" />
        ))}
      </div>
    </div>
  );
}

// ── Last-trick peek ──────────────────────────────────────────────────────────

function LastTrickPeek({
  deal,
  hidden,
  nameOf,
}: {
  deal: DealView;
  hidden: boolean;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const last = deal.lastTrick;
  if (last === null || hidden) return null;

  return (
    <>
      <button type="button" className="peek" onClick={() => setOpen((o) => !o)}>
        {t('table.lastTrickBtn')}
      </button>
      {open && (
        <button type="button" className="peek__panel" onClick={() => setOpen(false)}>
          {last.plays.map((play) => (
            <span key={`${play.seat}-${play.card}`} className="peek__card">
              <CardFace card={play.card} width="var(--card-w-sm)" />
              <span className={play.seat === last.winner ? 'peek__win' : 'dim'}>
                {nameOf(play.seat)}
              </span>
            </span>
          ))}
        </button>
      )}
    </>
  );
}

// ── Bottom: own hand fan (two-step play / exchange multi-select) ─────────────

function HandFan({
  hand,
  playHint,
  selectCount,
  selectLegal,
}: {
  hand: Card[];
  playHint: PlayHint | null;
  selectCount: number | null;
  /** Cards eligible for the multi-select (koini discard); null = all. */
  selectLegal: Card[] | null;
}) {
  const { t } = useTranslation();
  const raisedCard = useStore((s) => s.ui.raisedCard);
  const raiseCard = useStore((s) => s.raiseCard);
  const pending = useStore((s) => s.ui.pendingActionId) !== null;
  const selectedCards = useStore((s) => s.ui.selectedCards);
  const toggleSelectedCard = useStore((s) => s.toggleSelectedCard);

  function onTap(card: Card): void {
    if (selectCount !== null) {
      if (selectLegal !== null && !selectLegal.includes(card)) return;
      toggleSelectedCard(card, selectCount);
      return;
    }
    if (playHint === null || pending) return;
    if (!playHint.legal.includes(card)) return;
    if (raisedCard === card) {
      // Second tap: play. The card stays raised with a spinner until the
      // confirming update clears raisedCard + pendingActionId in the store.
      sendAction({ type: 'playCard', card });
      return;
    }
    raiseCard(card);
  }

  const density =
    hand.length > 12 ? ' hand--dense hand--xdense' : hand.length > 9 ? ' hand--dense' : '';
  return (
    <div className={`hand${density}`}>
      {hand.map((card) => {
        const illegal =
          (playHint !== null && !playHint.legal.includes(card)) ||
          (selectCount !== null && selectLegal !== null && !selectLegal.includes(card));
        const raised = raisedCard === card;
        const picked = selectedCards.includes(card);
        return (
          <button
            type="button"
            key={card}
            disabled={illegal}
            aria-pressed={raised || picked}
            className={`hand__card${raised ? ' hand__card--raised' : ''}${
              picked ? ' hand__card--picked' : ''
            }${illegal ? ' hand__card--dim' : ''}`}
            onClick={() => onTap(card)}
          >
            <CardFace card={card} />
            {pending && raised && (
              <span role="status" className="hand__spinner" aria-label={t('table.pending')} />
            )}
          </button>
        );
      })}
    </div>
  );
}
