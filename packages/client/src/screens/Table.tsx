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
  type Suit,
  sideOf,
} from '@hp/engine';
import type { SeatInfo } from '@hp/protocol';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CardBack, CardFace, CardStack } from '../components/CardFace';
import { EmoteBar } from '../components/EmoteBar';
import { LearnGuide } from '../components/LearnGuide';
import { emoteById } from '../emotes';
import { disconnect, sendAction, sendLobby } from '../socket';
import { type CompletedTrick, type EmoteBubble, type SpeechBubble, useStore } from '../store';
import {
  DealScoredOverlay,
  MatchEndedOverlay,
  RedealOverlay,
  StandingsOverlay,
} from './table/TableOverlays';
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
/** How long a reaction floats by its seat before fading out. */
const EMOTE_MS = 2_800;
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

/** A reaction floating by a seat (opponent panel or, with `me`, the felt foot). */
function EmoteFloat({ emote, me }: { emote: EmoteBubble; me?: boolean }): ReactElement {
  return (
    <div className={`emote${me === true ? ' emote--me' : ''}`} aria-hidden="true">
      <span className="emote__emoji">{emoteById[emote.emote].emoji}</span>
    </div>
  );
}

/** Countdown appears only once this few seconds remain (a late "act soon" nudge). */
const VISIBLE_SECONDS = 15;
/** …and becomes urgent (big, red, pulsing) at/under this many. */
const URGENT_SECONDS = 10;
/** The drain bar starts filling in this far out — well before the numeral shows. */
const DRAIN_SECONDS = 30;

/** Now, re-sampled ~4×/second (drives every countdown on this screen). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Whole seconds left until `deadline` (epoch ms). */
function useSecondsLeft(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - useNow()) / 1000));
}

/**
 * The acting player's countdown ("…3, 2, 1"), shown only on your own turn while
 * a deadline is live (i.e. autoplay is on) and ONLY in the final VISIBLE_SECONDS
 * — it stays hidden until you're running low, then appears (and goes urgent
 * under URGENT_SECONDS) so you act before a bot takes over. Rendered at the
 * felt's bottom-RIGHT, clear of both the trick's landing zone and the felt-foot
 * rail; taps pass through to the felt (pointer-events: none).
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

/**
 * The same deadline as a bar draining along the hand footer's top edge. A digit
 * at the edge of the felt is easy to miss mid-thought; a shrinking bar under
 * your own cards is read by peripheral vision without looking at it.
 * Decorative — `TurnCountdown` carries the accessible readout.
 */
function TurnDrain({ deadline }: { deadline: number }): ReactElement | null {
  const now = useNow();
  const left = (deadline - now) / 1000;
  if (left > DRAIN_SECONDS || left <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={`thand__drain${left <= URGENT_SECONDS ? ' thand__drain--urgent' : ''}`}
      style={{ '--left': Math.max(0, left / DRAIN_SECONDS) } as CSSProperties}
    />
  );
}

/**
 * Counts how many times the turn has ARRIVED at this device (false → true).
 * Used as a React key so the hand footer's gold sweep replays on every arrival
 * — without it, "your turn just landed" and "your turn is still waiting" look
 * identical (both are only the heartbeat).
 */
function useTurnArrivals(myTurn: boolean): number {
  const [arrivals, setArrivals] = useState(0);
  const prev = useRef(false);
  useEffect(() => {
    if (myTurn && !prev.current) setArrivals((n) => n + 1);
    prev.current = myTurn;
  }, [myTurn]);
  return arrivals;
}

/**
 * The felt-wide acknowledgement of a trump being set (a marriage declared, or a
 * whole/half ask that landed): a coloured wash sweeps out of the centre and the
 * suit's glyph blooms and settles. Keyed by the bubble that triggered it, so it
 * replays for every declaration. Purely decorative; the top-bar chip remains the
 * authoritative trump readout.
 */
function DeclarationFlash({ suit }: { suit: Suit }): ReactElement {
  return (
    <div className="declflash" aria-hidden="true">
      <span className="declflash__wash" />
      <span className={`declflash__glyph suit--${suit}`}>{SUIT_GLYPH[suit]}</span>
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
  const emotes = useStore((s) => s.ui.emotes);
  const dismissEmote = useStore((s) => s.dismissEmote);
  const completedTrick = useStore((s) => s.ui.completedTrick);
  const clearCompletedTrick = useStore((s) => s.clearCompletedTrick);
  const raisedCard = useStore((s) => s.ui.raisedCard);
  const raiseCard = useStore((s) => s.raiseCard);
  const pending = useStore((s) => s.ui.pendingActionId) !== null;
  const redeal = useStore((s) => s.ui.redeal);
  const matchRating = useStore((s) => s.ui.matchRating);
  const learn = useStore((s) => s.ui.learn);
  const nameOf = useNameOf();
  const myTurnNow = seat !== null && turn !== null && turn.seat === seat;
  const turnArrivals = useTurnArrivals(myTurnNow);

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

  // Reactions auto-expire EMOTE_MS after each first appears (same per-id-timer
  // approach as bubbles, so a fresh emote elsewhere never resets a live one).
  const emoteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = emoteTimers.current;
    const live = new Set(emotes.map((e) => e.id));
    for (const e of emotes) {
      if (timers.has(e.id)) continue;
      timers.set(
        e.id,
        setTimeout(() => {
          timers.delete(e.id);
          dismissEmote(e.id);
        }, EMOTE_MS),
      );
    }
    for (const [id, timer] of timers) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
  }, [emotes, dismissEmote]);
  useEffect(
    () => () => {
      for (const timer of emoteTimers.current.values()) clearTimeout(timer);
      emoteTimers.current.clear();
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
  /** The on-demand full-standings overlay ("Näytä tilanne") is open. */
  const [showStandings, setShowStandings] = useState(false);

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
  const myTurn = myTurnNow;
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
  // My own seat was handed to a fill-in bot (I idled past the turn timeout).
  // Offer an always-visible "I'm back" button to reclaim control instantly —
  // even off-turn, so the bot won't play my next turn either.
  const iAmAway = seat !== null && room.seats[seat]?.botControlled === true;

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
  const myEmote = seat !== null ? (emotes.find((e) => e.seat === seat) ?? null) : null;

  // A trump was just set (a marriage declared, or an ask that landed): the felt
  // acknowledges it once, keyed by the bubble that carried it so it never
  // replays. `suitCode` is the raw suit the bubble already carries for tinting.
  const trumpBubble = bubbles.filter((b) => b.code === 'bubble.trump').at(-1) ?? null;
  const declaredSuitCode = trumpBubble?.params?.suitCode;
  const declaredSuit =
    trumpBubble !== null && typeof declaredSuitCode === 'string'
      ? { id: trumpBubble.id, suit: declaredSuitCode as Suit }
      : null;

  function onFeltTap(): void {
    if (raisedCard !== null && !pending) raiseCard(null);
  }

  return (
    <div className="screen screen--table">
      {/* TopBar + host strip share one grid row so the felt keeps the 1fr track
          (the grid template has exactly four rows: header / felt / sheet / hand). */}
      <div className="ttop-wrap">
        <TopBar view={view} me={me} mySide={mySide} actor={actor} myTurn={myTurn} nameOf={nameOf} />
        {view.winnerSide === null && learn === null && (
          <div className="thostbar">
            {/* Left: on-demand full standings (the header now shows only YOUR
                score). Right: the host stops the game for everyone; anyone else
                can bail out to the menu (a bot fills their seat) so no one is
                stuck if the host goes silent. */}
            <button
              type="button"
              className="btn--ghost thostbar__btn"
              onClick={() => setShowStandings(true)}
            >
              {t('table.standings')}
            </button>
            <button
              type="button"
              className="btn--ghost thostbar__btn"
              onClick={() => (isHost ? setConfirmStop(true) : setConfirmLeave(true))}
            >
              {isHost ? t('table.stop') : t('table.leave')}
            </button>
          </div>
        )}
      </div>

      {learn !== null && <LearnGuide />}

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
                    tricks={deal.tricksWon[other] ?? 0}
                    isTurn={actor === other && view.winnerSide === null}
                    isDealer={view.dealer === other}
                    isDeclarer={deal.declarer === other}
                    bubble={bubbles.find((b) => b.seat === other) ?? null}
                    emote={emotes.find((e) => e.seat === other) ?? null}
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
            <TrickPile count={deal.tricksWon[me] ?? 0} mine />
            {declaredSuit !== null && (
              <DeclarationFlash key={declaredSuit.id} suit={declaredSuit.suit} />
            )}
            {myTurn && turn?.deadline != null && view.winnerSide === null && (
              <TurnCountdown deadline={turn.deadline} />
            )}
            {/* Your own bubble + reaction share one bottom-centre rail hugging the
                top edge of the sheet/hand, so they read as coming from YOU (they
                used to float unattached at 16%/23% of the felt) and can never
                overlap each other or the trick. */}
            {(myBubble !== null || myEmote !== null) && (
              <div className="felt-foot">
                {myEmote !== null && <EmoteFloat emote={myEmote} me />}
                {myBubble !== null && (
                  <div
                    className={`bubble bubble--me${myBubble.code === 'bubble.trump' ? ' bubble--trump' : ''}`}
                  >
                    <BubbleText bubble={myBubble} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {sheet}

      <footer className={`thand${myTurn && contractHint === null ? ' thand--turn' : ''}`}>
        {/* Re-keyed on every turn arrival so the gold sweep replays. */}
        {myTurn && <span key={turnArrivals} className="thand__sweep" aria-hidden="true" />}
        {myTurn && turn?.deadline != null && view.winnerSide === null && (
          <TurnDrain deadline={turn.deadline} />
        )}
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

      {deal !== null && !showMatchOverlay && learn === null && <EmoteBar />}

      {iAmAway && !showMatchOverlay && (
        <button
          type="button"
          className="table-reclaim"
          onClick={() => sendLobby({ type: 'reclaimSeat' })}
        >
          {t('table.imBack')}
        </button>
      )}

      {redeal !== null && !showMatchOverlay && (
        <RedealOverlay
          seat={redeal.seat}
          until={redeal.until}
          reason={redeal.reason}
          nameOf={nameOf}
        />
      )}
      {showScoredOverlay && scoredResult !== null && learn === null && (
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
      {showStandings && (
        <StandingsOverlay
          scores={view.scores}
          mySide={mySide}
          players={players}
          nameOf={nameOf}
          onClose={() => setShowStandings(false)}
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
  me,
  mySide,
  actor,
  myTurn,
  nameOf,
}: {
  view: PlayerView;
  /** The seat this device plays (spectators watch from seat 0). */
  me: Seat;
  mySide: Side;
  actor: Seat | null;
  myTurn: boolean;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const deal = view.deal;
  const trump = deal?.trump ?? null;
  // Only THIS device's own running total; the full standings for every side are
  // a tap away via "Näytä tilanne" in the strip below.
  const myScore = view.scores[mySide] ?? 0;

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

  return (
    <header className="ttop">
      {/* Grid `1fr auto 1fr`: the two side columns are equal, so the trump label
          in the middle sits dead-centre on the screen whatever the name/deal
          widths are. */}
      <div className="ttop__row ttop__row--main">
        <strong className="ttop__me-score">
          {nameOf(me)} {myScore}
        </strong>
        {/* key on `trump` remounts the chip when trump changes, restarting the
            attention flash (see `.ttop__trump--on` in table.css). */}
        <span
          key={trump ?? 'none'}
          className={`ttop__trump${trump !== null ? ` ttop__trump--on suit--${trump}` : ' ttop__trump--off dim'}`}
        >
          {trump !== null ? `${SUIT_GLYPH[trump]} ${t(`suit.${trump}`)}` : t('table.noTrump')}
        </span>
        <span className="ttop__deal dim">{t('table.deal', { n: view.dealIndex + 1 })}</span>
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

// ── Trick piles ──────────────────────────────────────────────────────────────

/**
 * A seat's captured tricks, as a growing heap of card backs. The felt used to
 * have nothing that accumulated — won tricks slid off and vanished — so a deal
 * gave no sense of progress and the trick-to-winner glide landed nowhere. The
 * element is keyed on the count by the caller, so a remount replays the bump.
 */
function TrickPile({ count, mine }: { count: number; mine?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <span
      key={count}
      className={`trick-pile trick-pile--grew${mine === true ? ' trick-pile--me' : ''}`}
      title={t('table.tricksWon', { n: count })}
    >
      <CardStack count={count} width="var(--card-w-opp)" maxLayers={4} />
      <span className="trick-pile__n">{count}</span>
    </span>
  );
}

// ── Opponent / partner panels ────────────────────────────────────────────────

function OpponentPanel({
  pos,
  info,
  name,
  count,
  tricks,
  isTurn,
  isDealer,
  isDeclarer,
  bubble,
  emote,
}: {
  pos: 'left' | 'top' | 'right';
  info: SeatInfo;
  name: string;
  count: number;
  /** Tricks this seat has captured in the current deal (their pile's height). */
  tricks: number;
  isTurn: boolean;
  isDealer: boolean;
  isDeclarer: boolean;
  bubble: SpeechBubble | null;
  emote: EmoteBubble | null;
}) {
  const { t } = useTranslation();
  const offline = info.kind === 'human' && !info.connected;
  const backs = Array.from({ length: count }, (_, i) => i);

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
      <div className="opp__hand">
        {/* A small fan, positioned by transform like your own hand, so playing a
            card makes the remaining backs glide into the gap instead of the
            count silently ticking down. `--i`/`--n` drive the geometry. */}
        <div className="opp__fan" style={{ '--n': count } as CSSProperties}>
          {backs.map((i) => (
            <span
              key={`back-${i}`}
              className="opp__back"
              style={{ '--i': i, '--n': count } as CSSProperties}
            >
              <CardBack width="var(--card-w-opp)" />
            </span>
          ))}
        </div>
        <span className="opp__count dim">{count}</span>
      </div>
      <TrickPile count={tricks} />
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
      {emote !== null && <EmoteFloat emote={emote} />}
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
          <CardStack count={deal.talonCount as number} width="var(--card-w-opp)" />
          <span className="dim">
            {t('table.talon')} {deal.talonCount}
          </span>
        </div>
      )}
      {showDummy && (
        <div className="felt-pile">
          <CardStack count={deal.dummyHandCount as number} width="var(--card-w-opp)" />
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
  const raisedIndex = raisedCard !== null ? hand.indexOf(raisedCard) : -1;
  return (
    <div className={`hand${density}`} style={{ '--n': hand.length } as CSSProperties}>
      {hand.map((card, i) => {
        const illegal =
          (playHint !== null && !playHint.legal.includes(card)) ||
          (selectCount !== null && selectLegal !== null && !selectLegal.includes(card));
        const raised = raisedCard === card;
        const picked = selectedCards.includes(card);
        // Neighbours part around the raised card — the "peek" of a real hand.
        const part = raisedIndex < 0 || raised ? 0 : i < raisedIndex ? -6 : 6;
        return (
          <button
            type="button"
            key={card}
            disabled={illegal}
            aria-pressed={raised || picked}
            style={{ '--i': i, '--n': hand.length, '--part': `${part}px` } as CSSProperties}
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
