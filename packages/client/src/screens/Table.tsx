/**
 * Table: crude but WORKING placeholder (replaced next phase). Renders the raw
 * PlayerView plus buttons generated from the server-sent ActionHints — every
 * button submits a real action through the socket layer, proving the
 * store/socket/protocol stack end-to-end. UI legality comes ONLY from hints.
 */
import { type ActionHint, type Card, type Seat, type Suit, sideOf } from '@hp/engine';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CardBack, CardFace } from '../components/CardFace';
import { sendAction, sendLobby } from '../socket';
import { useStore } from '../store';

const SUIT_GLYPH: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠' };

export function Table() {
  const { t } = useTranslation();
  const server = useStore((s) => s.server);
  const pendingActionId = useStore((s) => s.ui.pendingActionId);
  const { view, seat, turn } = server;

  if (view === null || view.deal === null) {
    return (
      <div className="screen">
        <div className="screen__main">
          <p className="dim">{t('common.loading')}</p>
          {view?.winnerSide != null && (
            <MatchOver winnerSide={view.winnerSide} scores={view.scores} />
          )}
        </div>
      </div>
    );
  }

  const deal = view.deal;
  const mySide = seat === null ? 0 : sideOf(seat);
  const myTurn = seat !== null && turn !== null && turn.seat === seat;
  const hints = myTurn ? (turn?.hints ?? []) : [];
  const playHint = hints.find(
    (h): h is Extract<ActionHint, { type: 'playCard' }> => h.type === 'playCard',
  );

  return (
    <div className="screen">
      <header className="screen__top stack" style={{ gap: 'var(--space-1)' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>
            {t('table.scores')}: {t('table.us')} {view.scores[mySide]} · {t('table.them')}{' '}
            {view.scores[mySide === 0 ? 1 : 0]}
          </span>
          <span>{t('table.deal', { n: view.dealIndex + 1 })}</span>
        </div>
        <div className="row dim" style={{ justifyContent: 'space-between' }}>
          <span>
            {t('table.trump')}:{' '}
            {deal.trump !== null
              ? `${SUIT_GLYPH[deal.trump]} ${t(`suit.${deal.trump}`)}`
              : t('table.noTrump')}
          </span>
          <span>
            {t('table.contract')}: {deal.contract ?? '—'}
          </span>
        </div>
        <div className="row dim" style={{ justifyContent: 'space-between' }}>
          <span>{t(`phase.${deal.phase.name}`)}</span>
          <span>
            {turn !== null &&
              (myTurn ? t('table.yourTurn') : t('table.turnOf', { seat: turn.seat + 1 }))}
          </span>
        </div>
      </header>

      <main className="screen__main">
        {view.winnerSide != null && <MatchOver winnerSide={view.winnerSide} scores={view.scores} />}
        <TrickArea />
        {myTurn && hints.length > 0 && (
          <div className="panel stack">
            {hints.map((hint) => (
              <HintControls key={hint.type} hint={hint} hand={deal.hand} />
            ))}
          </div>
        )}
        {pendingActionId !== null && <p className="dim">{t('table.pending')}</p>}
        <details>
          <summary className="dim">{t('table.raw')}</summary>
          <pre className="raw">
            {JSON.stringify({ seq: server.seq, seat, turn, view }, null, 2)}
          </pre>
        </details>
      </main>

      <footer className="screen__bottom">
        <HandFan hand={deal.hand} playHint={playHint ?? null} />
      </footer>
    </div>
  );
}

// ── Center: current trick (crude) ────────────────────────────────────────────

function TrickArea() {
  const { t } = useTranslation();
  const deal = useStore((s) => s.server.view?.deal);
  if (!deal) return null;
  const phase = deal.phase;
  const plays = phase.name === 'follow' ? phase.plays : [];

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: 'center', minHeight: 'var(--card-h-sm)' }}>
        {plays.length === 0 ? (
          <span className="dim">
            {phase.name === 'lead' && t('table.turnOf', { seat: phase.leader + 1 })}
            {phase.name === 'scored' && t('event.dealScored')}
          </span>
        ) : (
          plays.map((play) => (
            <div
              key={play.seat}
              className="stack"
              style={{ alignItems: 'center', gap: 'var(--space-1)' }}
            >
              <CardFace card={play.card} width="var(--card-w-sm)" />
              <span className="dim">{t('table.seat', { seat: play.seat + 1 })}</span>
            </div>
          ))
        )}
      </div>
      {deal.lastTrick !== null && plays.length === 0 && (
        <div className="row dim" style={{ justifyContent: 'center' }}>
          <span>{t('event.trickWon')}:</span>
          {deal.lastTrick.plays.map((play) => (
            <CardFace key={play.seat} card={play.card} width="var(--card-w-sm)" />
          ))}
        </div>
      )}
      <OpponentCounts />
    </div>
  );
}

function OpponentCounts() {
  const { t } = useTranslation();
  const view = useStore((s) => s.server.view);
  if (view === null || view.deal === null) return null;
  const me = view.viewer === 'spectator' ? null : view.viewer;
  const seats = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== me);
  return (
    <div className="row" style={{ justifyContent: 'space-around' }}>
      {seats.map((s) => (
        <span key={s} className="dim row" style={{ gap: 'var(--space-1)' }}>
          <CardBack width="18px" />
          {t('table.seat', { seat: s + 1 })}: {view.deal?.handCounts[s]}
        </span>
      ))}
    </div>
  );
}

function MatchOver({ winnerSide, scores }: { winnerSide: 0 | 1; scores: [number, number] }) {
  const { t } = useTranslation();
  return (
    <div className="panel stack" style={{ borderColor: 'var(--gold)' }}>
      <h2>{t('table.matchOver', { side: winnerSide + 1 })}</h2>
      <p className="dim">
        {scores[0]} — {scores[1]}
      </p>
      <button type="button" className="btn--primary" onClick={() => sendLobby({ type: 'rematch' })}>
        {t('lobby.rematch')}
      </button>
    </div>
  );
}

// ── Bottom: own hand with two-step play ──────────────────────────────────────

function HandFan({
  hand,
  playHint,
}: {
  hand: Card[];
  playHint: Extract<ActionHint, { type: 'playCard' }> | null;
}) {
  const { t } = useTranslation();
  const raisedCard = useStore((s) => s.ui.raisedCard);
  const raiseCard = useStore((s) => s.raiseCard);

  function onTap(card: Card): void {
    if (playHint !== null && raisedCard === card && playHint.legal.includes(card)) {
      sendAction({ type: 'playCard', card });
      raiseCard(null);
      return;
    }
    raiseCard(raisedCard === card ? null : card);
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-1)' }}>
      {raisedCard !== null && playHint !== null && playHint.legal.includes(raisedCard) && (
        <p className="dim" style={{ textAlign: 'center' }}>
          {t('table.tapAgain')}
        </p>
      )}
      <div className="hand">
        {hand.map((card) => {
          const illegal = playHint !== null && !playHint.legal.includes(card);
          return (
            <button
              type="button"
              key={card}
              className={`hand__card${raisedCard === card ? ' hand__card--raised' : ''}${illegal ? ' hand__card--dim' : ''}`}
              onClick={() => onTap(card)}
            >
              <CardFace card={card} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Hint-driven action controls ──────────────────────────────────────────────

function HintControls({ hint, hand }: { hint: ActionHint; hand: Card[] }) {
  switch (hint.type) {
    case 'bid':
      return <BidControls hint={hint} />;
    case 'setContract':
      return <ContractControls hint={hint} />;
    case 'giveCards':
      return <CardPicker key="give" count={hint.count} hand={hand} action="giveCards" />;
    case 'returnCards':
      return <CardPicker key="return" count={hint.count} hand={hand} action="returnCards" />;
    case 'declaration':
      return <DeclarationControls hint={hint} />;
    case 'answerWhole':
      return <AnswerWholeControls hint={hint} />;
    case 'playCard':
      return null; // handled by the hand fan
  }
}

function Stepper({
  min,
  max,
  step,
  value,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="row">
      <button type="button" disabled={value - step < min} onClick={() => onChange(value - step)}>
        −{step}
      </button>
      <strong style={{ minWidth: '3.5em', textAlign: 'center' }}>{value}</strong>
      <button type="button" disabled={value + step > max} onClick={() => onChange(value + step)}>
        +{step}
      </button>
    </div>
  );
}

function BidControls({ hint }: { hint: Extract<ActionHint, { type: 'bid' }> }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(hint.min);
  useEffect(() => setAmount(hint.min), [hint.min]);

  return (
    <div className="stack">
      <span className="dim">
        {t('phase.bidding')}
        {hint.forced && ` — ${t('error.forcedOpening', { min: hint.min })}`}
      </span>
      <div className="row">
        <Stepper
          min={hint.min}
          max={hint.max}
          step={hint.step}
          value={amount}
          onChange={setAmount}
        />
        <button
          type="button"
          className="btn--primary"
          onClick={() => sendAction({ type: 'bid', amount })}
        >
          {t('action.bid')} {amount}
        </button>
      </div>
      <div className="row">
        {hint.canPass && (
          <button type="button" onClick={() => sendAction({ type: 'pass' })}>
            {t('action.pass')}
          </button>
        )}
        {hint.canDemandRedeal && (
          <button
            type="button"
            className="btn--danger"
            onClick={() => sendAction({ type: 'demandRedeal' })}
          >
            {t('action.demandRedeal')}
          </button>
        )}
      </div>
    </div>
  );
}

function ContractControls({ hint }: { hint: Extract<ActionHint, { type: 'setContract' }> }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(hint.min);
  useEffect(() => setAmount(hint.min), [hint.min]);
  return (
    <div className="stack">
      <span className="dim">{t('action.setContract')}</span>
      <div className="row">
        <Stepper
          min={hint.min}
          max={hint.max}
          step={hint.step}
          value={amount}
          onChange={setAmount}
        />
        <button
          type="button"
          className="btn--primary"
          onClick={() => sendAction({ type: 'setContract', amount })}
        >
          {t('action.setContract')} {amount}
        </button>
      </div>
    </div>
  );
}

function CardPicker({
  count,
  hand,
  action,
}: {
  count: number;
  hand: Card[];
  action: 'giveCards' | 'returnCards';
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Card[]>([]);

  function toggle(card: Card): void {
    setPicked((prev) =>
      prev.includes(card)
        ? prev.filter((c) => c !== card)
        : prev.length < count
          ? [...prev, card]
          : prev,
    );
  }

  return (
    <div className="stack">
      <span className="dim">
        {t(`action.${action}`)} — {t('table.selectCount', { count })}
      </span>
      <div className="row">
        {hand.map((card) => (
          <button
            type="button"
            key={card}
            className={picked.includes(card) ? '' : 'btn--ghost'}
            style={{ padding: 'var(--space-1)' }}
            onClick={() => toggle(card)}
          >
            <CardFace card={card} width="var(--card-w-sm)" />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn--primary"
        disabled={picked.length !== count}
        onClick={() => {
          sendAction({ type: action, cards: picked });
          setPicked([]);
        }}
      >
        {t('common.confirm')}
      </button>
    </div>
  );
}

function DeclarationControls({ hint }: { hint: Extract<ActionHint, { type: 'declaration' }> }) {
  const { t } = useTranslation();
  return (
    <div className="stack">
      <div className="row">
        {hint.ownSuits.map((suit) => (
          <button type="button" key={suit} onClick={() => sendAction({ type: 'declareOwn', suit })}>
            {t('action.declareOwn')} {SUIT_GLYPH[suit]}
          </button>
        ))}
        {hint.canAskWhole && (
          <button type="button" onClick={() => sendAction({ type: 'askWhole' })}>
            {t('action.askWhole')}
          </button>
        )}
        {hint.halfAsks.map((ask) => (
          <button
            type="button"
            key={`${ask.suit}${ask.rankHeld}`}
            onClick={() => sendAction({ type: 'askHalf', suit: ask.suit, rankHeld: ask.rankHeld })}
          >
            {t('action.askHalf')} {SUIT_GLYPH[ask.suit]}
            {ask.rankHeld}
          </button>
        ))}
      </div>
    </div>
  );
}

function AnswerWholeControls({ hint }: { hint: Extract<ActionHint, { type: 'answerWhole' }> }) {
  const { t } = useTranslation();
  return (
    <div className="row">
      {hint.suits.map((suit) => (
        <button
          type="button"
          key={suit}
          className="btn--primary"
          onClick={() => sendAction({ type: 'answerWhole', suit })}
        >
          {t('action.answerWhole')} {SUIT_GLYPH[suit]}
        </button>
      ))}
    </div>
  );
}
