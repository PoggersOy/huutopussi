/**
 * Mid-deal reconnection: reloading the page must reclaim the same seat via
 * the localStorage session token and restore the exact same hand and scores;
 * a simulated visibility hidden→visible cycle (iOS wake) must resync without
 * tearing the connection down; the seat must remain fully playable after.
 */
import { expect, test } from '@playwright/test';
import {
  addBots,
  createRoom,
  driveUntil,
  newDriver,
  ownHand,
  ownScore,
  startMatch,
} from './helpers';

test.setTimeout(420_000);

test('reload mid-deal reclaims the seat; visibility wake stays consistent', async ({ page }) => {
  const code = await createRoom(page, 'Anna');
  await addBots(page, 3);
  await startMatch(page);

  const driver = newDriver(page);

  // Drive into the deal until a QUIET mid-deal point: Anna has already played
  // at least one card and it is her turn to play again (bots wait on her, so
  // nothing moves while we snapshot/reload).
  await driveUntil(
    [driver],
    async () => {
      const hand = await ownHand(page);
      if (hand.length === 0 || hand.length > 8) return false;
      if (await page.locator('.tsheet').count()) return false;
      if (await page.locator('.hand__spinner').count()) return false;
      return await page
        .locator('footer.thand--turn')
        .isVisible()
        .catch(() => false);
    },
    300_000,
    'quiet mid-deal point on our play turn',
  );

  const handBefore = await ownHand(page);
  const scoreBefore = await ownScore(page);
  const tokenBefore = await page.evaluate((c) => sessionStorage.getItem(`hp:session:${c}`), code);
  expect(tokenBefore).not.toBeNull();

  // ── Reload: the seat is reclaimed via the persisted session token ─────────
  await page.reload();
  await expect(page.locator('main.felt')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('footer.thand--turn')).toBeVisible({ timeout: 20_000 });

  expect(await ownHand(page)).toEqual(handBefore);
  expect(await ownScore(page)).toEqual(scoreBefore);
  expect(await page.evaluate((c) => sessionStorage.getItem(`hp:session:${c}`), code)).toBe(
    tokenBefore,
  );
  await expect(page.locator('.banner')).toHaveCount(0); // no reconnect banner

  // ── Visibility hidden → visible (iOS wake): unconditional resync ──────────
  const setVisibility = (state: string) =>
    page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => v,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);

  await setVisibility('hidden');
  await page.waitForTimeout(300);
  await setVisibility('visible');

  // The wake handler arms a 3 s zombie watchdog; if the resync response did
  // not arrive the socket would be closed and the reconnect banner shown.
  await page.waitForTimeout(4_000);
  await expect(page.locator('.banner')).toHaveCount(0);
  expect(await ownHand(page)).toEqual(handBefore);
  await expect(page.locator('footer.thand--turn')).toBeVisible();

  // ── Still live: the reclaimed seat can actually play ──────────────────────
  const sizeBefore = handBefore.length;
  await driveUntil(
    [driver],
    async () => (await ownHand(page)).length === sizeBefore - 1,
    60_000,
    'playing a card after the wake cycle',
  );
});
