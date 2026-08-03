/**
 * Full deal end-to-end through the real UI: Anna + 3 bots. Anna bids once and
 * then passes when losing (bids again only when forced), completes the
 * exchange when she is declarer / gives when asked, and plays all 9 tricks
 * with the two-step raised-card flow. Every move comes from server hints —
 * the driver only ever taps enabled UI elements.
 *
 * Ends by asserting the deal-scored overlay shows numbers consistent with the
 * default ("Oletus") point system: card points + last trick = 140, per-side
 * totals add up (allowing the ±2 opponent rounding to nearest 5), tricks sum to
 * 9, marriage points are multiples of 20.
 */
import { expect, test } from '@playwright/test';
import { addBots, createRoom, driveUntil, newDriver, startMatch } from './helpers';

test.setTimeout(420_000);

interface OverlayRow {
  label: string;
  cells: number[];
}

test('Anna vs three bots: a full deal reaches a consistent score overlay', async ({ page }) => {
  await createRoom(page, 'Anna');
  // Guest rooms play the built-in default ("Oletus"): last trick 20 → 140-point
  // deals, opponent totals rounded to the nearest 5. Anna always places one bid
  // (see the driver), so the deal is never contract-less — there's a declarer.
  await addBots(page, 3);
  await startMatch(page);

  const driver = newDriver(page);
  const resultsHeading = page.locator('.overlay h2', { hasText: 'Deal results' });

  await driveUntil(
    [driver],
    async () => await resultsHeading.isVisible().catch(() => false),
    360_000,
    'deal-results overlay',
  );

  // Solo-vs-bots is player-paced: the overlay waits for a "Continue" tap and the
  // driver never presses it, so it lingers. Still read every row in one atomic
  // evaluate, then assert offline — cheap insurance against any future timer.
  const readRows = async (): Promise<OverlayRow[]> =>
    await page.locator('.overlay tbody tr').evaluateAll((trs) =>
      trs.map((tr) => ({
        label: tr.querySelector('th')?.textContent?.trim() ?? '',
        cells: Array.from(tr.querySelectorAll('td')).map((td) =>
          Number.parseInt(td.textContent ?? '', 10),
        ),
      })),
    );

  // The figures COUNT UP when the card lands (docs/MOTION.md §3.5), so a single
  // read can catch them mid-tick — that is what "card points summed to 82" was.
  // Read until two consecutive samples agree, i.e. the numbers have settled.
  let rows: OverlayRow[] = await readRows();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(200);
    const again = await readRows();
    if (JSON.stringify(again) === JSON.stringify(rows)) break;
    rows = again;
  }

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

  // Point system A + last-trick bonus: every deal distributes exactly 140
  // card points between the sides (120 card points + a 20-point last trick).
  expect((cardUs ?? 0) + (cardThem ?? 0) + (lastUs ?? 0) + (lastThem ?? 0)).toBe(140);
  // The last-trick bonus goes to exactly one side.
  expect([lastUs, lastThem].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 20]);
  // Per-side totals are the sum of their parts — within the ±2 that the default
  // ruleset's nearest-5 rounding of the non-declarer side can introduce.
  expect(
    Math.abs((totalUs ?? 0) - ((cardUs ?? 0) + (lastUs ?? 0) + (marrUs ?? 0))),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs((totalThem ?? 0) - ((cardThem ?? 0) + (lastThem ?? 0) + (marrThem ?? 0))),
  ).toBeLessThanOrEqual(2);
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

  // Anna always bids, so the deal has a declarer — the contract line names one
  // and states made/failed.
  await expect(page.locator('.overlay').getByText(/Contract \d+ (made|failed)/)).toBeVisible();
});
