/**
 * Guards the static SEO surface in index.html: the crawler-visible tags that
 * are not rendered by React (title, description, canonical, hreflang, Open
 * Graph, Twitter card, JSON-LD). A missing/renamed tag here silently tanks the
 * SEO score, so pin the contract.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs with the package root as cwd; index.html lives there.
const readPkg = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const html = readPkg('index.html');
const doc = new DOMParser().parseFromString(html, 'text/html');

const meta = (sel: string) => doc.querySelector(sel)?.getAttribute('content') ?? '';

describe('index.html SEO head', () => {
  it('declares the document language', () => {
    expect(doc.documentElement.getAttribute('lang')).toBe('fi');
  });

  it('has a descriptive, non-empty title', () => {
    const title = doc.querySelector('title')?.textContent ?? '';
    expect(title).toMatch(/Huutopussi/);
    expect(title.length).toBeGreaterThan(20);
  });

  it('has a meta description of a sensible length', () => {
    const desc = meta('meta[name="description"]');
    expect(desc.length).toBeGreaterThan(70);
    expect(desc.length).toBeLessThan(200);
  });

  it('is indexable and self-canonical', () => {
    expect(meta('meta[name="robots"]')).toMatch(/\bindex\b/);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://huutopussi.online/',
    );
  });

  it('exposes fi / en / x-default hreflang alternates', () => {
    const langs = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) =>
      l.getAttribute('hreflang'),
    );
    expect(langs).toEqual(expect.arrayContaining(['fi', 'en', 'x-default']));
  });

  it('has a complete Open Graph card with an absolute image', () => {
    expect(meta('meta[property="og:title"]')).toMatch(/Huutopussi/);
    expect(meta('meta[property="og:description"]').length).toBeGreaterThan(30);
    expect(meta('meta[property="og:url"]')).toBe('https://huutopussi.online/');
    expect(meta('meta[property="og:image"]')).toMatch(/^https:\/\/.+\.png$/);
    expect(meta('meta[property="og:image:width"]')).toBe('1200');
    expect(meta('meta[property="og:image:height"]')).toBe('630');
  });

  it('has a summary_large_image Twitter card', () => {
    expect(meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(meta('meta[name="twitter:image"]')).toMatch(/^https:\/\/.+\.png$/);
  });

  it('embeds valid schema.org JSON-LD for a free game', () => {
    const raw = doc.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    const data = JSON.parse(raw); // throws (fails the test) on malformed JSON
    expect(data['@context']).toBe('https://schema.org');
    const graph = data['@graph'] as Array<Record<string, unknown>>;
    const app = graph.find((n) => JSON.stringify(n['@type']).includes('Application'));
    expect(app?.applicationCategory).toBe('GameApplication');
    expect(app?.isAccessibleForFree).toBe(true);
  });
});

describe('crawler files (robots + sitemap)', () => {
  it('sitemap.xml lists every canonical public search landing page', () => {
    const xml = readPkg('public/sitemap.xml');
    const sm = new DOMParser().parseFromString(xml, 'application/xml');
    expect(sm.querySelector('parsererror')).toBeNull(); // parse errors surface here
    const locs = [...sm.getElementsByTagName('loc')].map((l) => l.textContent);
    expect(locs).toEqual([
      'https://huutopussi.online/',
      'https://huutopussi.online/saannot',
      'https://huutopussi.online/opettele',
    ]);
    // Every <loc> must be an absolute https URL on the production origin, or
    // Search Console rejects the entry.
    for (const loc of locs) expect(loc).toMatch(/^https:\/\/huutopussi\.online\//);
  });

  it('robots.txt allows crawling and points Search Console at the sitemap', () => {
    const txt = readPkg('public/robots.txt');
    expect(txt).toMatch(/Sitemap:\s*https:\/\/huutopussi\.online\/sitemap\.xml/);
    expect(txt).toMatch(/Disallow:\s*\/r\//); // private room links stay out of the index
    expect(txt).not.toMatch(/Disallow:\s*\/\s*$/m); // never a blanket site-wide block
  });
});

describe('pre-rendered SEO pages', () => {
  it('builds route-specific, crawlable HTML before React runs', () => {
    const dist = mkdtempSync(join(tmpdir(), 'hp-seo-'));
    try {
      writeFileSync(join(dist, 'index.html'), html);
      execFileSync(process.execPath, [join(process.cwd(), 'scripts/prerender-seo.mjs'), dist]);

      for (const page of [
        {
          slug: 'saannot',
          canonical: 'https://huutopussi.online/saannot',
          heading: 'Huutopussin säännöt',
        },
        {
          slug: 'opettele',
          canonical: 'https://huutopussi.online/opettele',
          heading: 'Opettele pelaamaan Huutopussia',
        },
      ]) {
        const output = readFileSync(join(dist, page.slug, 'index.html'), 'utf8');
        const rendered = new DOMParser().parseFromString(output, 'text/html');
        expect(rendered.title).toMatch(/Huutopussi/i);
        expect(rendered.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
          page.canonical,
        );
        expect(rendered.querySelector('h1')?.textContent).toBe(page.heading);
        expect(rendered.querySelector('#root')?.textContent?.length).toBeGreaterThan(500);
        expect(rendered.querySelectorAll('#root a[href]').length).toBeGreaterThanOrEqual(2);

        const schemas = [...rendered.querySelectorAll('script[type="application/ld+json"]')].map(
          (script) => JSON.parse(script.textContent ?? ''),
        );
        expect(schemas.some((schema) => schema['@type'] === 'WebPage')).toBe(true);
      }
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
