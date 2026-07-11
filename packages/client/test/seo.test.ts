/**
 * Guards the static SEO surface in index.html: the crawler-visible tags that
 * are not rendered by React (title, description, canonical, hreflang, Open
 * Graph, Twitter card, JSON-LD). A missing/renamed tag here silently tanks the
 * SEO score, so pin the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs with the package root as cwd; index.html lives there.
const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
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
