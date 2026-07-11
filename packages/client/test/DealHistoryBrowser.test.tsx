/**
 * DealHistoryBrowser: pages through a finished match's deals and shows each
 * deal's breakdown. The running-total row must accumulate per-side scoreDelta
 * across deals, and prev/next/dots must move between deals. Uses the real i18n
 * catalog (en) so labels/aria-names are exercised too.
 */
import type { DealResult } from '@hp/engine';
import type { MatchSummary } from '@hp/protocol';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DealHistoryBrowser } from '../src/components/DealHistoryBrowser';
import i18n from '../src/i18n';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

function sides(deltas: number[]): DealResult['sides'] {
  return deltas.map((d) => ({
    cardPoints: d,
    lastTrickBonus: 0,
    marriagePoints: 0,
    discardPoints: 0,
    rawTotal: d,
    roundedTotal: d,
    tricks: 1,
    porvoo: false,
    scoreDelta: d,
  }));
}

/** A 3-player match, two deals; running totals are [60,25,35] then [70,-45,55]. */
const match: MatchSummary = {
  finishedAt: 1000,
  winnerSide: 0,
  finalScores: [70, -45, 55],
  deals: 2,
  players: 3,
  names: ['Samuli', 'Paikka 2', 'Paikka 3'],
  dealResults: [
    { declarer: 0, contract: 60, bid: 60, made: true, sides: sides([60, 25, 35]) },
    { declarer: 1, contract: 70, bid: 70, made: false, sides: sides([10, -70, 20]) },
  ],
};

const cellsOf = (container: HTMLElement, rowClass: string): string[] =>
  Array.from(container.querySelector(rowClass)?.querySelectorAll('td') ?? []).map(
    (td) => td.textContent ?? '',
  );

describe('DealHistoryBrowser', () => {
  it('shows the first deal with cumulative totals and one dot per deal', () => {
    const { container } = render(
      <DealHistoryBrowser match={match} roomCode="ABCDE" onClose={() => {}} />,
    );
    // Deal 1: delta === cumulative total (first deal).
    expect(cellsOf(container, '.score__delta')).toEqual(['+60', '+25', '+35']);
    expect(cellsOf(container, '.score__matchtotal')).toEqual(['60', '25', '35']);
    // Contract made → the "made" subtitle, naming the declarer.
    expect(container.querySelector('.overlay__made')?.textContent).toContain('60');
    expect(container.querySelectorAll('.deal-dot')).toHaveLength(2);
  });

  it('advances to the next deal and accumulates running totals', () => {
    const { container, getByRole } = render(
      <DealHistoryBrowser match={match} roomCode="ABCDE" onClose={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: i18n.t('history.nextDeal') }));
    // Deal 2 delta is that deal only; the match-total row is the running sum.
    expect(cellsOf(container, '.score__delta')).toEqual(['+10', '-70', '+20']);
    expect(cellsOf(container, '.score__matchtotal')).toEqual(['70', '-45', '55']);
    // A failed contract shows the "failed" subtitle instead.
    expect(container.querySelector('.overlay__failed')).not.toBeNull();
  });

  it('jumps to a deal via its dot', () => {
    const { container } = render(
      <DealHistoryBrowser match={match} roomCode="ABCDE" onClose={() => {}} />,
    );
    const dots = container.querySelectorAll('.deal-dot');
    fireEvent.click(dots[1] as Element);
    expect(cellsOf(container, '.score__matchtotal')).toEqual(['70', '-45', '55']);
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <DealHistoryBrowser match={match} roomCode="ABCDE" onClose={onClose} />,
    );
    fireEvent.click(getByRole('button', { name: i18n.t('common.close') }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
