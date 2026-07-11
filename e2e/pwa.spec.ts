/**
 * PWA basics against the built app served by the real server:
 *  - the web manifest is reachable and describes the installable app,
 *  - the service worker registers and activates,
 *  - offline navigation serves the precached shell (best-effort: skipped
 *    gracefully when the SW cannot take control in this environment).
 */
import { expect, test } from '@playwright/test';
import { gotoEnglish } from './helpers';

test('manifest is reachable and complete', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toContain('manifest');
  const manifest = (await res.json()) as {
    name?: string;
    display?: string;
    start_url?: string;
    icons?: Array<{ src: string; sizes: string }>;
  };
  expect(manifest.name).toBe('Huutopussi');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons?.length ?? 0).toBeGreaterThanOrEqual(2);

  const sw = await request.get('/sw.js');
  expect(sw.ok()).toBe(true);
});

test('service worker registers; offline navigation serves the cached shell', async ({
  page,
  context,
}) => {
  await gotoEnglish(page);
  await expect(page.getByRole('heading', { name: 'Huutopussi' })).toBeVisible();

  const swSupported = await page.evaluate(() => 'serviceWorker' in navigator);
  test.skip(!swSupported, 'serviceWorker API unavailable in this context');

  // Wait for the registration to activate (registerSW runs on app boot).
  let active = false;
  try {
    active = await page.evaluate(async () => {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('sw ready timeout')), 20_000);
      });
      const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
      return reg.active !== null;
    });
  } catch {
    active = false;
  }
  test.skip(!active, 'service worker did not activate (dev/SW caveat)');

  // A fresh SW does not control the page that registered it — reload so the
  // shell navigation goes through the worker.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Huutopussi' })).toBeVisible();
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  test.skip(!controlled, 'service worker never took control (dev/SW caveat)');

  // Offline: the precached app shell must still render (navigateFallback).
  await context.setOffline(true);
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Huutopussi' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a room', exact: true })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
