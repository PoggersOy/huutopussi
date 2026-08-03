/**
 * The per-deal score table (Korttipisteet … Muutos … running total) plus the
 * contract result line, shared by the live "Jako laskettu" overlay
 * (screens/table/TableOverlays) and the History screen's deal-by-deal browser
 * (DealHistoryBrowser). Pure presentational: given one deal's DealResult, the
 * running match totals to show, and the column order + labels, it renders the
 * `.score` table. Callers own the surrounding panel/nav/close.
 */
import type { DealResult, Seat, Side } from '@hp/engine';
import type { CSSProperties, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useCountUp } from '../countUp';

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Per-row delay; mirrors the `--stagger` token the row slide-in uses. */
const STAGGER_MS = 55;

/**
 * A score that ticks up to its value as the card lands (docs/MOTION.md §3.5).
 * `delay` staggers it with its row so the table fills in top to bottom rather
 * than every figure spinning at once. Reduced motion → the final value at once.
 *
 * `animate` is off unless the caller opts in: counting is for the *moment* a
 * deal is scored, not for the History screen, where the same table is something
 * you scroll back through to read.
 */
function Count({
  value,
  delay,
  sign,
  animate,
}: {
  value: number;
  delay: number;
  sign?: boolean;
  animate: boolean;
}): ReactElement {
  const shown = useCountUp(value, delay, animate);
  return <span className="count-up">{sign === true ? signed(shown) : shown}</span>;
}

/** "Sopimus N täyttyi/kaatui — name" (or the all-pass note); null if no contract. */
export function DealContractLine({
  result,
  nameOf,
}: {
  result: DealResult;
  nameOf: (seat: Seat) => string;
}) {
  const { t } = useTranslation();
  if (result.declarer === null) {
    return <p className="dim tsheet__center">{t('overlay.contractless')}</p>;
  }
  if (result.contract === null || result.made === null) return null;
  return (
    <p className={result.made ? 'overlay__made' : 'overlay__failed'}>
      {t(result.made ? 'overlay.contractMade' : 'overlay.contractFailed', {
        contract: result.contract,
        name: nameOf(result.declarer),
      })}
    </p>
  );
}

export function DealBreakdownTable({
  result,
  scores,
  order,
  sideLabel,
  animate = false,
}: {
  result: DealResult;
  /** Running match totals to show in the final row (index === side). */
  scores: number[];
  /** Column order (sides), left to right. */
  order: Side[];
  sideLabel: (side: Side) => string;
  /** Count the figures up as they appear — for the live "deal scored" moment
   *  only; the History browser renders the same table as a static readout. */
  animate?: boolean;
}) {
  const { t } = useTranslation();
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
        {/* `--r` is the row's index: each row slides in one --stagger after the
            one above it, and its figures count up on the same beat. */}
        {rows.map(([key, values], r) => (
          <tr key={key} style={{ '--r': r } as CSSProperties}>
            <th>{t(key)}</th>
            {values.map((value, i) => (
              <td key={order[i]}>
                <Count value={value} delay={r * STAGGER_MS} animate={animate} />
              </td>
            ))}
          </tr>
        ))}
        {hasPorvoo && (
          <tr style={{ '--r': rows.length } as CSSProperties}>
            <th className="score__porvoo">{t('table.porvoo')}</th>
            {cols.map((s, i) => (
              <td key={order[i]} className="score__porvoo">
                {s.porvoo ? '×' : ''}
              </td>
            ))}
          </tr>
        )}
        <tr className="score__delta" style={{ '--r': rows.length + 1 } as CSSProperties}>
          <th>{t('overlay.delta')}</th>
          {cols.map((s, i) => (
            <td key={order[i]} className={s.scoreDelta >= 0 ? 'delta--pos' : 'delta--neg'}>
              <Count
                value={s.scoreDelta}
                delay={(rows.length + 1) * STAGGER_MS}
                sign
                animate={animate}
              />
            </td>
          ))}
        </tr>
        <tr className="score__matchtotal" style={{ '--r': rows.length + 2 } as CSSProperties}>
          <th>{t('overlay.matchTotal')}</th>
          {order.map((side) => (
            <td key={side}>
              <Count
                value={scores[side] ?? 0}
                delay={(rows.length + 2) * STAGGER_MS}
                animate={animate}
              />
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
