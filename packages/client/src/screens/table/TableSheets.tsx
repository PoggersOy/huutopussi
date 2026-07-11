/**
 * Bottom sheets for the Table screen — one per acting phase, driven purely by
 * the phase + server-sent ActionHints (UI legality NEVER recomputed locally).
 * Sheets render in-flow above the hand fan so the player's cards stay visible
 * and tappable (the exchange sheets confirm a selection made in the fan).
 */
import {
  type ActionHint,
  activeSeats,
  type DealPhase,
  marriageValue,
  type RuleConfig,
  type Seat,
  sideOf,
} from '@hp/engine';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CardFace } from '../../components/CardFace';
import { sendAction } from '../../socket';
import { useStore } from '../../store';
import { SUIT_GLYPH } from './tableUtils';
import { useTalonCards } from './talonMemory';

export type BidHint = Extract<ActionHint, { type: 'bid' }>;
export type ContractHint = Extract<ActionHint, { type: 'setContract' }>;
export type DiscardHint = Extract<ActionHint, { type: 'discardCards' }>;
export type DeclHint = Extract<ActionHint, { type: 'declaration' }>;
export type AnswerWholeHint = Extract<ActionHint, { type: 'answerWhole' }>;
export type PlayHint = Extract<ActionHint, { type: 'playCard' }>;

function usePending(): boolean {
  return useStore((s) => s.ui.pendingActionId) !== null;
}

/** `pulse` gives the sheet the gold "waiting on you" heartbeat — used when the
 *  action lives in the sheet (buttons), so the sheet breathes instead of the
 *  hand fan. */
function SheetShell({
  title,
  children,
  pulse = false,
}: {
  title: string;
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <section className={`tsheet${pulse ? ' tsheet--turn' : ''}`}>
      <div className="tsheet__handle" aria-hidden="true" />
      <h2 className="tsheet__title">{title}</h2>
      {children}
    </section>
  );
}

function WaitingNote({ name }: { name: string }) {
  const { t } = useTranslation();
  return <p className="dim tsheet__waiting">{t('sheet.waiting', { name })}</p>;
}

/** Redeal demand button for the exchange-window sheets (illisoft §3) — shown
 *  only when the server hinted `demandRedeal` alongside the phase action. */
function RedealButton({ show }: { show: boolean }) {
  const { t } = useTranslation();
  const pending = usePending();
  if (!show) return null;
  return (
    <button
      type="button"
      className="btn--danger"
      disabled={pending}
      onClick={() => sendAction({ type: 'demandRedeal' })}
    >
      {t('action.demandRedeal')}
    </button>
  );
}

/** Stepper with quick-add buttons (+step / +2·step / +5·step, i.e. +5/+10/+25). */
function AmountStepper({
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
    <div className="tsheet__stepper">
      <button type="button" disabled={value - step < min} onClick={() => onChange(value - step)}>
        −{step}
      </button>
      <strong className="tsheet__amount">{value}</strong>
      {[1, 2, 5].map((m) => (
        <button
          type="button"
          key={m}
          disabled={value + step * m > max}
          onClick={() => onChange(value + step * m)}
        >
          +{step * m}
        </button>
      ))}
    </div>
  );
}

// ── Bidding ──────────────────────────────────────────────────────────────────

export function BiddingSheet({
  phase,
  hint,
  actorName,
  nameOf,
}: {
  phase: Extract<DealPhase, { name: 'bidding' }>;
  hint: BidHint | null;
  actorName: string;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  const pending = usePending();
  const view = useStore((s) => s.server.view);
  const min = hint?.min ?? 0;
  const [amount, setAmount] = useState(min);
  useEffect(() => setAmount(min), [min]);

  // Cosmetic bid-ban indicators (illisoft §2) — legality still comes from hints.
  const cfg = view?.config ?? null;
  const players = cfg?.players ?? 4;
  const banned = (seat: Seat): boolean =>
    cfg !== null &&
    cfg.bidBanThreshold !== null &&
    (view?.scores[sideOf(seat, players)] ?? 0) <= cfg.bidBanThreshold;
  const reopened =
    cfg?.bidBanReopen === true &&
    phase.excluded.length === 0 &&
    banned(phase.turn) &&
    !activeSeats(players).every(banned);

  return (
    <SheetShell title={t('phase.bidding')}>
      <p className="dim tsheet__center">
        {phase.highBid !== null
          ? t('sheet.highBid', { amount: phase.highBid.amount, name: nameOf(phase.highBid.seat) })
          : t('sheet.noBids')}
      </p>
      {phase.excluded.length > 0 && (
        <p className="dim tsheet__center">
          {t('sheet.bidBanSkipped', { names: phase.excluded.map(nameOf).join(', ') })}
        </p>
      )}
      {reopened && <p className="tsheet__notice">{t('sheet.biddingReopened')}</p>}
      {hint !== null ? (
        <>
          {hint.forced && (
            <p className="tsheet__notice">{t('sheet.forcedBid', { min: hint.min })}</p>
          )}
          <AmountStepper
            min={hint.min}
            max={hint.max}
            step={hint.step}
            value={amount}
            onChange={setAmount}
          />
          <div className="tsheet__actions">
            <button
              type="button"
              className="btn--primary tsheet__big"
              disabled={pending}
              onClick={() => sendAction({ type: 'bid', amount })}
            >
              {t('action.bid')} {amount}
            </button>
            {hint.canPass && (
              <button
                type="button"
                className="tsheet__big"
                disabled={pending}
                onClick={() => sendAction({ type: 'pass' })}
              >
                {t('action.pass')}
              </button>
            )}
          </div>
          {hint.canDemandRedeal && (
            <button
              type="button"
              className="btn--danger"
              disabled={pending}
              onClick={() => sendAction({ type: 'demandRedeal' })}
            >
              {t('action.demandRedeal')}
            </button>
          )}
        </>
      ) : (
        <WaitingNote name={actorName} />
      )}
    </SheetShell>
  );
}

// ── Exchange give / return ───────────────────────────────────────────────────

export function ExchangeSheet({
  mode,
  count,
  targetName,
  actorName,
  canDemandRedeal = false,
}: {
  mode: 'give' | 'return';
  /** Exact number of cards to select; null when the viewer is not the actor. */
  count: number | null;
  targetName: string;
  actorName: string;
  canDemandRedeal?: boolean;
}) {
  const { t } = useTranslation();
  const pending = usePending();
  const selected = useStore((s) => s.ui.selectedCards);

  return (
    <SheetShell title={t(mode === 'give' ? 'phase.exchangeGive' : 'phase.exchangeReturn')}>
      {count !== null ? (
        <>
          <p className="dim tsheet__center">
            {t(mode === 'give' ? 'sheet.give' : 'sheet.return', { count, name: targetName })}
          </p>
          <div className="tsheet__picked">
            {selected.map((card) => (
              <CardFace key={card} card={card} width="var(--card-w-sm)" />
            ))}
          </div>
          <button
            type="button"
            className="btn--primary tsheet__big"
            disabled={pending || selected.length !== count}
            onClick={() =>
              sendAction({
                type: mode === 'give' ? 'giveCards' : 'returnCards',
                cards: selected,
              })
            }
          >
            {t('common.confirm')} · {t('sheet.selectedCount', { n: selected.length, count })}
          </button>
          <RedealButton show={canDemandRedeal} />
        </>
      ) : (
        <WaitingNote name={actorName} />
      )}
    </SheetShell>
  );
}

// ── Koini discard (2-3p: declarer sets aside talonSize cards) ────────────────

export function DiscardSheet({
  hint,
  actorName,
  dealIndex,
  canDemandRedeal = false,
}: {
  hint: DiscardHint | null;
  actorName: string;
  dealIndex: number;
  canDemandRedeal?: boolean;
}) {
  const { t } = useTranslation();
  const pending = usePending();
  const selected = useStore((s) => s.ui.selectedCards);
  const talonCards = useTalonCards(dealIndex);

  return (
    <SheetShell title={t('phase.exchangeDiscard')}>
      {hint !== null ? (
        <>
          <p className="dim tsheet__center">{t('sheet.discard', { count: hint.count })}</p>
          {talonCards !== null && (
            <>
              <p className="dim tsheet__center">{t('sheet.talonWas')}</p>
              <div className="tsheet__picked">
                {talonCards.map((card) => (
                  <CardFace key={card} card={card} width="var(--card-w-sm)" />
                ))}
              </div>
            </>
          )}
          <div className="tsheet__picked">
            {selected.map((card) => (
              <CardFace key={card} card={card} width="var(--card-w-sm)" />
            ))}
          </div>
          <button
            type="button"
            className="btn--primary tsheet__big"
            disabled={pending || selected.length !== hint.count}
            onClick={() => sendAction({ type: 'discardCards', cards: selected })}
          >
            {t('action.discard')} ·{' '}
            {t('sheet.selectedCount', { n: selected.length, count: hint.count })}
          </button>
          <RedealButton show={canDemandRedeal} />
        </>
      ) : (
        <WaitingNote name={actorName} />
      )}
    </SheetShell>
  );
}

// ── Contract ─────────────────────────────────────────────────────────────────

export function ContractSheet({
  hint,
  actorName,
  canDemandRedeal = false,
}: {
  hint: ContractHint | null;
  actorName: string;
  canDemandRedeal?: boolean;
}) {
  const { t } = useTranslation();
  const pending = usePending();
  const min = hint?.min ?? 0;
  const [amount, setAmount] = useState(min);
  useEffect(() => setAmount(min), [min]);

  return (
    <SheetShell title={t('sheet.contractTitle')} pulse={hint !== null}>
      {hint !== null ? (
        <>
          <p className="dim tsheet__center">{t('sheet.contractMin', { min: hint.min })}</p>
          <AmountStepper
            min={hint.min}
            max={hint.max}
            step={hint.step}
            value={amount}
            onChange={setAmount}
          />
          <div className="tsheet__actions">
            {/* "Ohi" keeps the contract at the winning bid (amount = min). */}
            <button
              type="button"
              className="tsheet__big"
              disabled={pending}
              onClick={() => sendAction({ type: 'setContract', amount: hint.min })}
            >
              {t('action.keepBid', { amount: hint.min })}
            </button>
            <button
              type="button"
              className="btn--primary tsheet__big"
              disabled={pending || amount <= hint.min}
              onClick={() => sendAction({ type: 'setContract', amount })}
            >
              {t('action.raiseTo', { amount })}
            </button>
          </div>
          <RedealButton show={canDemandRedeal} />
        </>
      ) : (
        <WaitingNote name={actorName} />
      )}
    </SheetShell>
  );
}

// ── Declaration (lead with canDeclare) ───────────────────────────────────────

export function DeclarationSheet({ hint, config }: { hint: DeclHint; config: RuleConfig }) {
  const { t } = useTranslation();
  const pending = usePending();
  const [halfPicker, setHalfPicker] = useState(false);

  return (
    <SheetShell title={t('sheet.declTitle')}>
      {halfPicker ? (
        <>
          <p className="dim tsheet__center">{t('sheet.halfPrompt')}</p>
          <div className="tsheet__grid">
            {hint.halfAsks.map((ask) => {
              const asked = ask.rankHeld === 'K' ? 'Q' : 'K';
              return (
                <button
                  type="button"
                  key={`${ask.suit}${ask.rankHeld}`}
                  className="btn--primary"
                  disabled={pending}
                  onClick={() =>
                    sendAction({ type: 'askHalf', suit: ask.suit, rankHeld: ask.rankHeld })
                  }
                >
                  {t('bubble.askHalf', { card: `${SUIT_GLYPH[ask.suit]}${asked}` })}
                </button>
              );
            })}
          </div>
          <button type="button" className="btn--ghost" onClick={() => setHalfPicker(false)}>
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <div className="tsheet__grid">
          {hint.ownSuits.map((suit) => (
            <button
              type="button"
              key={suit}
              className="btn--primary"
              disabled={pending}
              onClick={() => sendAction({ type: 'declareOwn', suit })}
            >
              <span className={`suit--${suit} tsheet__glyph`}>{SUIT_GLYPH[suit]}</span>
              {t(`suit.${suit}`)} +{marriageValue(suit, config)}
            </button>
          ))}
          {hint.canAskWhole && (
            <button
              type="button"
              disabled={pending}
              onClick={() => sendAction({ type: 'askWhole' })}
            >
              {t('sheet.askWholeBtn')}
            </button>
          )}
          {hint.halfAsks.length > 0 && (
            <button type="button" disabled={pending} onClick={() => setHalfPicker(true)}>
              {t('action.askHalf')}…
            </button>
          )}
        </div>
      )}
    </SheetShell>
  );
}

// ── Answer a whole-marriage ask ──────────────────────────────────────────────

export function AnswerWholeSheet({
  hint,
  actorName,
  config,
}: {
  hint: AnswerWholeHint | null;
  actorName: string;
  config: RuleConfig;
}) {
  const { t } = useTranslation();
  const pending = usePending();

  return (
    <SheetShell title={t(hint !== null ? 'sheet.answerTitle' : 'phase.awaitWholeAnswer')}>
      {hint !== null ? (
        <div className="tsheet__grid">
          {hint.suits.map((suit) => (
            <button
              type="button"
              key={suit}
              className="btn--primary"
              disabled={pending}
              onClick={() => sendAction({ type: 'answerWhole', suit })}
            >
              <span className={`suit--${suit} tsheet__glyph`}>{SUIT_GLYPH[suit]}</span>
              {t(`suit.${suit}`)} +{marriageValue(suit, config)}
            </button>
          ))}
        </div>
      ) : (
        <WaitingNote name={actorName} />
      )}
    </SheetShell>
  );
}
