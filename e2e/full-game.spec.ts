/**
 * Full deal end-to-end through the real UI: Anna + 3 bots. Anna bids once and
 * then passes when losing (bids again only when forced), completes the
 * exchange when she is declarer / gives when asked, and plays all 9 tricks
 * with the two-step raised-card flow. Every move comes from server hints —
 * the driver only ever taps enabled UI elements.
 *
 * Ends by asserting the deal-scored overlay shows numbers that sum per the
 * päämuoto point system: card points + last trick = 130, per-side totals add
 * up, tricks sum to 9, marriage points are multiples of 20.
 */
import { expect, test } from '@playwright/test';
import { addBots, createRoom, driveUntil, newDriver, setPreset, startMatch } from './helpers';

test.setTimeout(420_000);

interface OverlayRow {
  label: string;
  cells: number[];
}

test('Anna vs three bots: a full deal reaches a consistent score overlay', async ({ page }) => {
  await createRoom(page, 'Anna');
  // The product default is illisoft (last trick 20, contract-less deals). This
  // test asserts the päämuoto point system (130-point deals, always a
  // declarer), so pin päämuoto explicitly before starting.
  await setPreset(page, 'paamuoto');
  await addBots(page, 3);
  await startMatch(page);

  const driver = newDriver(page);
  const scoredHeading = page.locator('.overlay h2', { hasText: 'Deal scored' });

  await driveUntil(
    [driver],
    async () => await scoredHeading.isVisible().catch(() => false),
    360_000,
    'deal-scored overlay',
  );

  // The overlay is replaced ~6 s later by the next deal: read every row in
  // one atomic evaluate, then assert offline.
  const rows: OverlayRow[] = await page.locator('.overlay tbody tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      label: tr.querySelector('th')?.textContent?.trim() ?? '',
      cells: Array.from(tr.querySelectorAll('td')).map((td) =>
        Number.parseInt(td.textContent ?? '', 10),
      ),
    })),
  );

  const row = (label: string): number[] => {
    const found = rows.find((r) => r.label === label);
    if (found === undefined) throw new Error(`missing overlay row '${label}'`);
    return found.cells;
  };

  const [cardUs, cardThem] = row('Card points');
  const [lastUs, lastThem] = row('Last trick');
  const [marrUs, marrThem] = row('Marriages');
  const [totalUs, totalThem] = row('Total');
  const [tricksUs, tricksThem] = row('Tricks');
  const [deltaUs, deltaThem] = row('Change');

  for (const n of [cardUs, cardThem, lastUs, lastThem, marrUs, marrThem]) {
    expect(Number.isInteger(n)).toBe(true);
  }

  // Point system A + last-trick bonus: every deal distributes exactly 130
  // card points between the sides.
  expect((cardUs ?? 0) + (cardThem ?? 0) + (lastUs ?? 0) + (lastThem ?? 0)).toBe(130);
  // The last-trick bonus goes to exactly one side.
  expect([lastUs, lastThem].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 10]);
  // Per-side totals are the sum of their parts.
  expect(totalUs).toBe((cardUs ?? 0) + (lastUs ?? 0) + (marrUs ?? 0));
  expect(totalThem).toBe((cardThem ?? 0) + (lastThem ?? 0) + (marrThem ?? 0));
  // Marriage values are 40/60/80/100 each — always multiples of 20.
  expect((marrUs ?? 0) % 20).toBe(0);
  expect((marrThem ?? 0) % 20).toBe(0);
  expect(marrUs).toBeGreaterThanOrEqual(0);
  expect(marrThem).toBeGreaterThanOrEqual(0);
  // 9 tricks per 4-player deal.
  expect((tricksUs ?? 0) + (tricksThem ?? 0)).toBe(9);
  // Score deltas exist and are integers (contract clamp/Porvoo may make them
  // diverge from the raw totals, so only sanity-check them here).
  expect(Number.isInteger(deltaUs)).toBe(true);
  expect(Number.isInteger(deltaThem)).toBe(true);

  // Päämuoto always has a declarer (forced opening) — the contract line names
  // one and states made/failed.
  await expect(page.locator('.overlay').getByText(/Contract \d+ (made|failed)/)).toBeVisible();
});
