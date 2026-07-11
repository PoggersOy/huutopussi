/**
 * The per-deal score table (Korttipisteet … Muutos … running total) plus the
 * contract result line, shared by the live "Jako laskettu" overlay
 * (screens/table/TableOverlays) and the History screen's deal-by-deal browser
 * (DealHistoryBrowser). Pure presentational: given one deal's DealResult, the
 * running match totals to show, and the column order + labels, it renders the
 * `.score` table. Callers own the surrounding panel/nav/close.
 */
import type { DealResult, Seat, Side } from '@hp/engine';
import { useTranslation } from 'react-i18next';

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
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
}: {
  result: DealResult;
  /** Running match totals to show in the final row (index === side). */
  scores: number[];
  /** Column order (sides), left to right. */
  order: Side[];
  sideLabel: (side: Side) => string;
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
        {rows.map(([key, values]) => (
          <tr key={key}>
            <th>{t(key)}</th>
            {values.map((value, i) => (
              <td key={order[i]}>{value}</td>
            ))}
          </tr>
        ))}
        {hasPorvoo && (
          <tr>
            <th className="score__porvoo">{t('table.porvoo')}</th>
            {cols.map((s, i) => (
              <td key={order[i]} className="score__porvoo">
                {s.porvoo ? '×' : ''}
              </td>
            ))}
          </tr>
        )}
        <tr className="score__delta">
          <th>{t('overlay.delta')}</th>
          {cols.map((s, i) => (
            <td key={order[i]} className={s.scoreDelta >= 0 ? 'delta--pos' : 'delta--neg'}>
              {signed(s.scoreDelta)}
            </td>
          ))}
        </tr>
        <tr className="score__matchtotal">
          <th>{t('overlay.matchTotal')}</th>
          {order.map((side) => (
            <td key={side}>{scores[side] ?? 0}</td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
