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
  type Card,
  type DealView,
  type PlayerView,
  partnerOf,
  type Seat,
  type Side,
  sideOf,
} from '@hp/engine';
import type { SeatInfo } from '@hp/protocol';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CardBack, CardFace } from '../components/CardFace';
import { sendAction } from '../socket';
import { type CompletedTrick, type SpeechBubble, useStore } from '../store';
import { DealScoredOverlay, MatchEndedOverlay } from './table/TableOverlays';
import {
  AnswerWholeSheet,
  BiddingSheet,
  ContractSheet,
  DeclarationSheet,
  ExchangeSheet,
  type PlayHint,
} from './table/TableSheets';
import { actorOf, relSeat, SUIT_GLYPH, useNameOf } from './table/tableUtils';

const BUBBLE_MS = 4_000;
const TRICK_LINGER_MS = 1_300;

export function Table() {
  const { t } = useTranslation();
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
  const nameOf = useNameOf();

  // Speech bubbles auto-dismiss.
  useEffect(() => {
    const timers = bubbles.map((b) => setTimeout(() => dismissBubble(b.id), BUBBLE_MS));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [bubbles, dismissBubble]);

  // The completed trick lingers briefly (winner flash), then the felt clears.
  useEffect(() => {
    if (completedTrick === null) return;
    const timer = setTimeout(() => clearCompletedTrick(completedTrick.id), TRICK_LINGER_MS);
    return () => clearTimeout(timer);
  }, [completedTrick, clearCompletedTrick]);

  /** "Just lead" hides the declaration sheet for this lead opportunity only. */
  const [declDismissedKey, setDeclDismissedKey] = useState<string | null>(null);
  /** Deal index whose scored overlay the user closed early. */
  const [scoredClosedFor, setScoredClosedFor] = useState<number | null>(null);

  if (view === null || room === null) {
    return (
      <div className="screen">
        <div className="screen__main" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <p className="dim">{t('common.loading')}</p>
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
  const selectCount = giveHint?.count ?? returnHint?.count ?? null;

  const actor: Seat | null = turn?.seat ?? (deal !== null ? actorOf(deal, players) : null);
  const actorName = actor !== null ? nameOf(actor) : '';

  const declKey = deal === null ? '' : `${view.dealIndex}:${deal.tricksPlayed}`;
  const declSheetOpen = declHint !== null && declDismissedKey !== declKey;

  const scoredResult = deal !== null && deal.phase.name === 'scored' ? deal.phase.result : null;
  const showMatchOverlay = view.winnerSide !== null;
  const showScoredOverlay =
    !showMatchOverlay && scoredResult !== null && scoredClosedFor !== view.dealIndex;

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
          />
        );
        break;
      }
      case 'exchangeContract':
        sheet = <ContractSheet hint={contractHint} actorName={actorName} />;
        break;
      case 'awaitWholeAnswer':
        sheet = <AnswerWholeSheet hint={answerHint} actorName={actorName} config={view.config} />;
        break;
      case 'lead':
        if (declSheetOpen && declHint !== null) {
          sheet = (
            <DeclarationSheet
              hint={declHint}
              config={view.config}
              onDismiss={() => setDeclDismissedKey(declKey)}
            />
          );
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
      <TopBar view={view} mySide={mySide} actor={actor} myTurn={myTurn} nameOf={nameOf} />

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: tap-anywhere-to-lower is a touch affordance; keyboard users act via the card buttons */}
      <main className="felt" onClick={onFeltTap}>
        {deal === null ? (
          <p className="felt__idle dim">{t('common.loading')}</p>
        ) : (
          <>
            {([1, 2, 3] as const).map((rel) => {
              const other = ((me + rel) % 4) as Seat;
              return (
                <OpponentPanel
                  key={other}
                  pos={rel === 1 ? 'left' : rel === 2 ? 'top' : 'right'}
                  info={room.seats[other]}
                  name={nameOf(other)}
                  count={deal.handCounts[other]}
                  isTurn={actor === other && view.winnerSide === null}
                  isDealer={view.dealer === other}
                  isDeclarer={deal.declarer === other}
                  bubble={bubbles.find((b) => b.seat === other) ?? null}
                />
              );
            })}
            <TrickArea deal={deal} me={me} completedTrick={completedTrick} nameOf={nameOf} />
            <LastTrickPeek deal={deal} hidden={completedTrick !== null} nameOf={nameOf} />
            {myBubble !== null && (
              <div className="bubble bubble--me">{t(myBubble.code, myBubble.params ?? {})}</div>
            )}
            {declHint !== null && !declSheetOpen && (
              <button type="button" className="decl-chip" onClick={() => setDeclDismissedKey(null)}>
                {t('sheet.declChip')}
              </button>
            )}
          </>
        )}
      </main>

      {sheet}

      <footer className={`thand${myTurn ? ' thand--turn' : ''}`}>
        {raisedCard !== null && playHint !== null && !pending && (
          <p className="thand__hint dim">{t('table.tapAgain')}</p>
        )}
        <HandFan hand={deal?.hand ?? []} playHint={playHint} selectCount={selectCount} />
      </footer>

      {showScoredOverlay && scoredResult !== null && (
        <DealScoredOverlay
          result={scoredResult}
          scores={view.scores}
          mySide={mySide}
          nameOf={nameOf}
          onClose={() => setScoredClosedFor(view.dealIndex)}
        />
      )}
      {showMatchOverlay && view.winnerSide !== null && (
        <MatchEndedOverlay
          winnerSide={view.winnerSide}
          scores={view.scores}
          seat={seat}
          hostSeat={room.hostSeat}
          mySide={mySide}
          players={players}
          nameOf={nameOf}
        />
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
    }
  }

  return (
    <header className="ttop">
      <div className="ttop__row">
        <span>
          <strong>
            {t('table.us')} {usScore}
          </strong>
          <span className="dim">
            {' · '}
            {t('table.them')} {themScore}
          </span>
        </span>
        <span className={trump !== null ? `ttop__trump suit--${trump}` : 'dim'}>
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
          <CardBack key={id} width="14px" />
        ))}
        <span className="opp__count dim">{count}</span>
      </div>
      <div className="opp__badges">
        {info.kind === 'bot' && <span className="chip">{t('lobby.bot')}</span>}
        {info.botControlled && <span className="chip chip--warn">{t('lobby.botControlled')}</span>}
        {offline && <span className="chip chip--off">{t('lobby.disconnected')}</span>}
        {isDeclarer && <span className="chip chip--gold">{t('table.declarer')}</span>}
      </div>
      {bubble !== null && <div className="bubble">{t(bubble.code, bubble.params ?? {})}</div>}
    </div>
  );
}

// ── Center: current trick (positioned per relative seat) ────────────────────

function TrickArea({
  deal,
  me,
  completedTrick,
  nameOf,
}: {
  deal: DealView;
  me: Seat;
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

  return (
    <div className="trick">
      {plays.map((play) => (
        <div
          key={`${play.seat}-${play.card}`}
          className={`trick__card trick__card--p${relSeat(me, play.seat)}${
            winner === play.seat ? ' trick__card--win' : ''
          }`}
        >
          <CardFace card={play.card} width="var(--card-w-md)" />
        </div>
      ))}
      {label !== null && <span className="trick__label dim">{label}</span>}
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
}: {
  hand: Card[];
  playHint: PlayHint | null;
  selectCount: number | null;
}) {
  const { t } = useTranslation();
  const raisedCard = useStore((s) => s.ui.raisedCard);
  const raiseCard = useStore((s) => s.raiseCard);
  const pending = useStore((s) => s.ui.pendingActionId) !== null;
  const selectedCards = useStore((s) => s.ui.selectedCards);
  const toggleSelectedCard = useStore((s) => s.toggleSelectedCard);

  function onTap(card: Card): void {
    if (selectCount !== null) {
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

  return (
    <div className={`hand${hand.length > 9 ? ' hand--dense' : ''}`}>
      {hand.map((card) => {
        const illegal = playHint !== null && !playHint.legal.includes(card);
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
