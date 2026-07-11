/**
 * History deal-browser: a full-screen modal that pages through every deal of a
 * FINISHED match, showing that deal's score breakdown — the same table shown
 * live as "Jako laskettu". Swipe left/right on touch, arrow keys on desktop, or
 * use the prev/next arrows and the dots. Reads only the persisted MatchSummary
 * (names, players and per-deal DealResults captured at match end); running
 * totals are recomputed cumulatively from each deal's per-side scoreDelta.
 */
import { type DealResult, partnerOf, type Seat, type Side } from '@hp/engine';
import type { MatchSummary } from '@hp/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DealBreakdownTable, DealContractLine } from './DealBreakdownTable';

const SWIPE_THRESHOLD_PX = 48;

/** Running match totals after each deal: cumulative sum of per-side scoreDelta. */
function runningScores(deals: DealResult[], sideCount: number): number[][] {
  const totals = Array.from({ length: sideCount }, () => 0);
  return deals.map((deal) => {
    for (let side = 0; side < sideCount; side++) {
      totals[side] = (totals[side] ?? 0) + (deal.sides[side]?.scoreDelta ?? 0);
    }
    return [...totals];
  });
}

export function DealHistoryBrowser({
  match,
  roomCode,
  onClose,
}: {
  match: MatchSummary;
  roomCode: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const deals = match.dealResults ?? [];
  const players = match.players ?? 4;
  const sideCount = players === 4 ? 2 : players;
  const count = deals.length;
  const [idx, setIdx] = useState(0);
  const touchX = useRef<number | null>(null);

  // Arrow keys page the deals; Escape closes. Functional setIdx keeps the
  // handler correct without re-subscribing on every deal change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(count - 1, i + 1));
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, onClose]);

  if (count === 0) return null; // caller only opens when deals exist
  const go = (delta: number) => setIdx((i) => Math.max(0, Math.min(count - 1, i + delta)));
  const order = Array.from({ length: sideCount }, (_, i) => i as Side);
  const nameOf = (seat: Seat): string => match.names?.[seat] ?? t('table.seat', { seat: seat + 1 });
  const sideLabel = (side: Side): string =>
    players === 4
      ? `${nameOf(side as Seat)} & ${nameOf(partnerOf(side as Seat))}`
      : nameOf(side as Seat);

  const scoresByDeal = runningScores(deals, sideCount);
  const result = deals[idx];
  if (result === undefined) return null;
  const scores = scoresByDeal[idx] ?? [];

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay__panel stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>{t('history.dealTitle', { n: idx + 1, total: count })}</h2>
          <span className="dim room-code">{roomCode}</span>
        </div>
        {/* Keyed by idx so the page re-mounts and replays its slide-in on change. */}
        <div
          className="deal-page"
          key={idx}
          onTouchStart={(e) => {
            touchX.current = e.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const start = touchX.current;
            touchX.current = null;
            if (start === null) return;
            const dx = (e.changedTouches[0]?.clientX ?? start) - start;
            if (dx <= -SWIPE_THRESHOLD_PX) go(1);
            else if (dx >= SWIPE_THRESHOLD_PX) go(-1);
          }}
        >
          <DealContractLine result={result} nameOf={nameOf} />
          <DealBreakdownTable result={result} scores={scores} order={order} sideLabel={sideLabel} />
        </div>
        <div className="deal-nav">
          <button
            type="button"
            className="btn--ghost deal-nav__arrow"
            onClick={() => go(-1)}
            disabled={idx === 0}
            aria-label={t('history.prevDeal')}
          >
            ‹
          </button>
          <div className="deal-dots">
            {deals.map((_, i) => (
              <button
                type="button"
                // biome-ignore lint/suspicious/noArrayIndexKey: deals are a fixed, ordered list
                key={i}
                className={i === idx ? 'deal-dot deal-dot--on' : 'deal-dot'}
                aria-label={t('history.dealTitle', { n: i + 1, total: count })}
                aria-current={i === idx}
                onClick={() => setIdx(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn--ghost deal-nav__arrow"
            onClick={() => go(1)}
            disabled={idx === count - 1}
            aria-label={t('history.nextDeal')}
          >
            ›
          </button>
        </div>
        <button type="button" className="btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
