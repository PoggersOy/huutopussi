/**
 * GDPR account-privacy behaviors (db.ts + names.ts):
 *   - display names are reduced to "First L." (data minimization),
 *   - an older db's stored email is erased and the column dropped on boot,
 *   - deleteUserAccount erases a user everywhere (art. 17), anonymizing only
 *     THEIR seat in each shared match's roster and leaving co-players intact.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES } from '@hp/engine';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Db } from '../src/db.js';
import { shortenDisplayName } from '../src/names.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hp-privacy-'));
  dbPath = join(dir, 'hp.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('shortenDisplayName reduces to "First L." and is idempotent', () => {
  expect(shortenDisplayName('Samuli Vainio')).toBe('Samuli V.');
  expect(shortenDisplayName('Samuli Ilmari Vainio')).toBe('Samuli V.'); // last token wins
  expect(shortenDisplayName('  Samuli   Vainio  ')).toBe('Samuli V.'); // whitespace-robust
  expect(shortenDisplayName('Samuli')).toBe('Samuli'); // single token unchanged
  expect(shortenDisplayName('Samuli V.')).toBe('Samuli V.'); // idempotent
  expect(shortenDisplayName('')).toBeNull();
  expect(shortenDisplayName(null)).toBeNull();
});

test('a legacy db with an email column is scrubbed and the column dropped on boot', () => {
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT, name TEXT, picture TEXT,
    rating INTEGER NOT NULL, games_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  raw
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, rating, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('u1', 'sub-1', 'person@example.test', 'Samuli Vainio', null, 1000, 1, 1);
  raw.close();

  const db = new Db(dbPath); // runs SCHEMA + migrate → minimizeUserPii + dropEmailColumnIfPresent
  const cols = (db.raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(cols).not.toContain('email'); // hard-removed
  expect(db.getUserById('u1')?.name).toBe('Samuli V.'); // full surname scrubbed
});

test('deleteUserAccount erases the user everywhere and anonymizes only their roster seat', () => {
  const db = new Db(':memory:');
  db.upsertUserByGoogleSub({ id: 'u1', googleSub: 'sub-1', name: 'Samuli V.', picture: null });
  db.upsertUserByGoogleSub({ id: 'u2', googleSub: 'sub-2', name: 'Maija K.', picture: null });

  db.saveSession({
    token: 't1',
    roomId: 'r1',
    seat: 0,
    nickname: 'Samuli V.',
    kind: 'human',
    userId: 'u1',
  });
  db.createMatch({ id: 'm1', roomId: 'r1', config: DEFAULT_RULES, firstDealer: 0 });
  db.finishMatch('m1', 0, [100, 50], ['Samuli V.', 'Maija K.']);
  db.applyRatingResults([
    {
      matchId: 'm1',
      userId: 'u1',
      seat: 0,
      ratingBefore: 1000,
      ratingAfter: 1020,
      delta: 20,
      newStreak: 1,
      isWin: true,
      createdAt: 1,
    },
    {
      matchId: 'm1',
      userId: 'u2',
      seat: 1,
      ratingBefore: 1000,
      ratingAfter: 980,
      delta: -20,
      newStreak: 0,
      isWin: false,
      createdAt: 1,
    },
  ]);
  // A casual/bot match has no rating_events row; match_participants is its
  // only durable account↔seat link and must still drive roster anonymization.
  db.createMatch({ id: 'm2', roomId: 'r1', config: DEFAULT_RULES, firstDealer: 0 });
  db.finishMatch('m2', 1, [50, 100], ['Samuli V.', 'Bot']);
  db.recordMatchParticipants('m2', [{ userId: 'u1', seat: 0, players: 4, won: false }]);
  db.createAuthToken('hash-u1', 'u1', Date.now() + 60_000);

  db.deleteUserAccount('u1');

  // The account and everything keyed to it is gone…
  expect(db.getUserById('u1')).toBeNull();
  expect(db.resolveAuthToken('hash-u1', Date.now())).toBeNull();
  expect(db.getRatingEventsForUser('u1', 10)).toHaveLength(0);
  const sess = db.raw.prepare('SELECT user_id FROM sessions WHERE token = ?').get('t1') as {
    user_id: string | null;
  };
  expect(sess.user_id).toBeNull(); // live session downgraded to a guest

  // …but the co-player and the shared match survive, with only u1's seat nulled.
  expect(db.getUserById('u2')).not.toBeNull();
  expect(db.getRatingEventsForUser('u2', 10)).toHaveLength(1);
  const names = JSON.parse(
    (db.raw.prepare('SELECT names FROM matches WHERE id = ?').get('m1') as { names: string }).names,
  ) as (string | null)[];
  expect(names).toEqual([null, 'Maija K.']);
  const casualNames = JSON.parse(
    (db.raw.prepare('SELECT names FROM matches WHERE id = ?').get('m2') as { names: string }).names,
  ) as (string | null)[];
  expect(casualNames).toEqual([null, 'Bot']);

  db.close();
});
