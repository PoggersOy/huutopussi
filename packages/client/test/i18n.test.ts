/**
 * i18n catalog completeness sweep.
 *
 * Asserts, by scanning source files (not by hand-maintained lists):
 *  1. fi.json and en.json expose IDENTICAL key sets;
 *  2. every i18n key referenced in client source is present in both catalogs —
 *     static `t('…')` literals, toast/bubble `code:` literals, the dynamic
 *     `event.${type}` family (gated by TOASTED_EVENTS in store.ts) and the
 *     `suit.${suit}` family;
 *  3. every engine `error.*` code in packages/engine/src/validate.ts and every
 *     server-emitted `error.*` code is present in both catalogs (the server
 *     relays them verbatim and Toasts renders `t(code)`);
 *  4. the catalogs carry no orphan keys nothing references.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';
import fi from '../src/i18n/fi.json';

// Vitest runs with cwd = packages/client (the vitest.config.ts root).
const CLIENT_SRC = resolve(process.cwd(), 'src');
const ENGINE_VALIDATE = resolve(process.cwd(), '../engine/src/validate.ts');
const SERVER_SRC = resolve(process.cwd(), '../server/src');

// ── Catalog flattening ───────────────────────────────────────────────────────

function flatten(node: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [prefix + key]
      : flatten(value as Record<string, unknown>, `${prefix}${key}.`),
  );
}

const fiKeys = new Set(flatten(fi));
const enKeys = new Set(flatten(en));

/** A used key is satisfied by an exact entry or by an i18next plural pair. */
function satisfied(keys: ReadonlySet<string>, key: string): boolean {
  return keys.has(key) || (keys.has(`${key}_one`) && keys.has(`${key}_other`));
}

// ── Source scanning ──────────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Dotted string literals ('a.b', "a.b") — i18n keys by repo convention. */
function dottedLiterals(source: string): string[] {
  return [...source.matchAll(/['"]([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z.]*)['"]/g)].map(
    (m) => m[1] as string,
  );
}

function collectUsedKeys(): Set<string> {
  const used = new Set<string>();

  // 1. Every dotted literal in client source (t('…'), code: '…', aria-labels…).
  //    src/i18n/ is excluded: catalogs/config must not vouch for themselves.
  const files = sourceFiles(CLIENT_SRC).filter((f) => !f.includes(`${join('src', 'i18n')}`));
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    for (const key of dottedLiterals(readFileSync(file, 'utf8'))) used.add(key);
  }

  // 2. Dynamic `event.${event.type}` toasts — gated by TOASTED_EVENTS.
  const storeSource = readFileSync(join(CLIENT_SRC, 'store.ts'), 'utf8');
  const setLiteral = storeSource.match(/TOASTED_EVENTS[^=]*=\s*new Set\(\[([^\]]*)\]/);
  expect(setLiteral, 'TOASTED_EVENTS set not found in store.ts').not.toBeNull();
  const toasted = [...(setLiteral?.[1] ?? '').matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  expect(toasted.length).toBeGreaterThan(0);
  for (const type of toasted) used.add(`event.${type}`);

  // 3. Dynamic `suit.${suit}` labels (Table top bar + declaration sheets).
  for (const suit of ['H', 'D', 'C', 'S']) used.add(`suit.${suit}`);

  // 3b. Dynamic `home.bots.level.${difficulty}` labels (Pikapeli level picker).
  for (const level of ['easy', 'medium', 'hard']) used.add(`home.bots.level.${level}`);

  // 4. Engine rule-error codes: the server relays them verbatim as toasts.
  const engineCodes = [...readFileSync(ENGINE_VALIDATE, 'utf8').matchAll(/err\('([^']+)'/g)].map(
    (m) => m[1] as string,
  );
  expect(engineCodes.length).toBeGreaterThanOrEqual(20);
  for (const code of engineCodes) used.add(code);

  // 5. Server-emitted error codes (protocol/lobby errors).
  const serverCodes = sourceFiles(SERVER_SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/['"](error\.[a-zA-Z]+)['"]/g)].map(
      (m) => m[1] as string,
    ),
  );
  expect(serverCodes.length).toBeGreaterThanOrEqual(5);
  for (const code of serverCodes) used.add(code);

  return used;
}

const usedKeys = collectUsedKeys();

// ── Assertions ───────────────────────────────────────────────────────────────

describe('i18n catalogs', () => {
  it('fi and en have identical key sets', () => {
    expect([...fiKeys].sort()).toEqual([...enKeys].sort());
  });

  it('every key used in client/engine/server source exists in both catalogs', () => {
    const missing = [...usedKeys]
      .filter((key) => !satisfied(fiKeys, key) || !satisfied(enKeys, key))
      .sort();
    expect(missing).toEqual([]);
  });

  it('carries no orphan keys that nothing references', () => {
    const orphans = [...fiKeys]
      .filter((key) => {
        const base = key.replace(/_(one|other)$/, '');
        return !usedKeys.has(key) && !usedKeys.has(base);
      })
      .sort();
    expect(orphans).toEqual([]);
  });
});

// Trick terminology: the product owner replaced the illisoft-era "kääntö" with
// the standard Finnish "tikki" (docs/illisoft-saannot-spec.md §12 uses the older
// "kääntö"; the UI overrides it). A trick round is still "pelikierros", and
// "läpäri" (SLAM) / "Porvoo" (päämuoto slang) still don't belong on the
// trickless column.
describe('fi trick terminology (tikki)', () => {
  // Matches every inflection of tikki (tikki / tikin / tikkiä / tikit) but not kääntö.
  const TIKKI = 'tik';
  const KAANTO = 'kään';

  it('labels the trickless column with tikki, not läpäri or Porvoo', () => {
    const label = fi.table.porvoo.toLowerCase();
    expect(label).not.toContain('läpäri');
    expect(label).not.toContain('porvoo');
    expect(label).not.toContain(KAANTO);
    expect(label).toContain(TIKKI);
  });

  it('uses tikki (never kääntö) for every won-trick label', () => {
    const wonTrickLabels = [
      fi.overlay.tricks,
      fi.table.lastTrickBtn,
      fi.table.trickWonBy,
      fi.overlay.lastTrick,
      fi.config.declareRightOwnLedWonTrick,
      fi.config.declareRightAnyWonTrick,
      fi.config.showLastTrick,
    ];
    for (const label of wonTrickLabels) {
      expect(label.toLowerCase()).not.toContain(KAANTO);
      expect(label.toLowerCase()).toContain(TIKKI);
    }
  });

  it('uses pelikierros (never tikki) for the head-trick obligation', () => {
    const label = fi.error.mustHeadTrick.toLowerCase();
    expect(label).not.toContain('tikki');
    expect(label).toContain('pelikierro');
  });
});
