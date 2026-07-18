/**
 * Static serving: the crawler-facing assets (robots.txt, sitemap.xml,
 * og-image.png), their MIME types, and the SPA fallback for room links. Uses a
 * throwaway staticDir so the test doesn't depend on a built client.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';

let server: HpServer;
let port: number;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hp-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Huutopussi</title>');
  writeFileSync(
    join(dir, 'robots.txt'),
    'User-agent: *\nDisallow: /r/\n\nSitemap: https://huutopussi.online/sitemap.xml\n',
  );
  writeFileSync(join(dir, 'sitemap.xml'), '<?xml version="1.0"?><urlset></urlset>');
  writeFileSync(join(dir, 'og-image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'sw.js'), '/* service worker */');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  server = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null, staticDir: dir });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('robots.txt is served as text/plain and points at the sitemap', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/robots.txt`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  const body = await res.text();
  expect(body).toContain('Sitemap: https://huutopussi.online/sitemap.xml');
  expect(body).toContain('Disallow: /r/');
});

test('sitemap.xml is served with an XML content-type', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/sitemap.xml`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/xml');
  expect(await res.text()).toContain('<urlset');
});

test('the og-image is served as image/png', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/og-image.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
});

test('/ serves the SPA shell as HTML', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(await res.text()).toContain('<title>Huutopussi</title>');
});

test('HTTP responses carry browser hardening headers and live APIs are not cached', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  expect(page.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(page.headers.get('permissions-policy')).toContain('camera=()');
  expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');

  const live = await fetch(`http://127.0.0.1:${port}/api/matchmaking`);
  expect(live.headers.get('cache-control')).toBe('no-store');
});

test('a room deep-link falls back to the SPA shell (crawlable, no 404)', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/r/ABCDE`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
});

test('app-screen deep-links (incl. /privacy, /rules, /learn) fall back to the SPA shell', async () => {
  for (const path of ['/privacy', '/rules', '/profile', '/history', '/learn', '/learn/tutorial']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('content-type'), path).toContain('text/html');
  }
});

test('an unknown asset is a 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/nope.js`);
  expect(res.status).toBe(404);
});

test('an unknown app route serves the SPA shell with a 404 status (client 404 page)', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(await res.text()).toContain('<title>Huutopussi</title>');
});

test('/stats reports aggregate activity counts as JSON', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/stats`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    gamesToday: 0,
    uniquePlayersToday: 0,
    registeredPlayersToday: 0,
    guestPlayersToday: 0,
    registeredUsersTotal: 0,
    timezone: 'Europe/Helsinki',
  });
  expect(typeof body.generatedAt).toBe('number');
  expect(typeof body.since).toBe('number');
  // Local midnight is at or before now, and within the last 24h + DST slack.
  expect(body.since as number).toBeLessThanOrEqual(body.generatedAt as number);
  expect((body.generatedAt as number) - (body.since as number)).toBeLessThan(25 * 60 * 60 * 1000);
});

// A fresh server per test → the per-IP /stats bucket starts empty, so these
// don't interfere with each other or the shared-server test above.
test('/stats is strictly rate-limited (429 past the per-minute cap)', async () => {
  const s = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null, staticDir: dir });
  const p = await s.listen();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await fetch(`http://127.0.0.1:${p}/stats`)).status);
    // The cap is 6/min; the first six pass, everything after is refused.
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429, 429, 429]);
    const refused = await fetch(`http://127.0.0.1:${p}/stats`);
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
  } finally {
    await s.close();
  }
});

test('/stats is cached: repeat reads return the same snapshot (no recompute)', async () => {
  const s = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null, staticDir: dir });
  const p = await s.listen();
  try {
    const first = (await (await fetch(`http://127.0.0.1:${p}/stats`)).json()) as {
      generatedAt: number;
    };
    const second = (await (await fetch(`http://127.0.0.1:${p}/stats`)).json()) as {
      generatedAt: number;
    };
    // Same generatedAt ⇒ the second read came from the 1h cache, not a re-run.
    expect(second.generatedAt).toBe(first.generatedAt);
  } finally {
    await s.close();
  }
});

// Cache-Control drives PWA update propagation: sw.js and the shell must always
// revalidate (else the CDN pins a stale service worker), while content-hashed
// build output is safe to cache forever.
test('sw.js is served no-cache so new deploys are always detected', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/sw.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-cache');
});

test('the SPA shell is served no-cache (both / and the fallback)', async () => {
  const root = await fetch(`http://127.0.0.1:${port}/`);
  expect(root.headers.get('cache-control')).toBe('no-cache');
  const deep = await fetch(`http://127.0.0.1:${port}/r/ABCDE`);
  expect(deep.headers.get('cache-control')).toBe('no-cache');
});

test('content-hashed /assets/* are cached forever and immutable', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/assets/index-abc123.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
});

test('other static files revalidate daily', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/og-image.png`);
  expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
});
