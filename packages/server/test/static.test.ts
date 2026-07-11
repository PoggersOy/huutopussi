/**
 * Static serving: the crawler-facing assets (robots.txt, sitemap.xml,
 * og-image.png), their MIME types, and the SPA fallback for room links. Uses a
 * throwaway staticDir so the test doesn't depend on a built client.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('a room deep-link falls back to the SPA shell (crawlable, no 404)', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/r/ABCDE`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
});

test('an unknown asset is a 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/nope.js`);
  expect(res.status).toBe(404);
});
