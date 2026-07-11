/**
 * Schema-migration regression (see db.ts `migrate`).
 *
 * An early production build created the `deals` table WITHOUT a `bid` column
 * (and with declarer/contract/made NOT NULL) and the `matches` table with
 * `final_score0/1` instead of `final_scores`. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so after a schema bump every deal that
 * reached scoring threw "table deals has no column named bid" inside the
 * persist transaction — stalling the game on the last card. These tests stand
 * up that legacy schema and assert `new Db()` heals it on open.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DealResult } from '@hp/engine';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Db } from '../src/db.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hp-migrate-'));
  dbPath = join(dir, 'hp.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes the pre-migration schema (no deals.bid; NOT NULL cols; final_score0/1). */
function seedLegacySchema(): void {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, config TEXT NOT NULL,
      first_dealer INTEGER NOT NULL, status TEXT NOT NULL, winner_side INTEGER,
      final_score0 INTEGER, final_score1 INTEGER, deals INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE deals (
      match_id TEXT NOT NULL, deal_index INTEGER NOT NULL, dealer INTEGER NOT NULL,
      declarer INTEGER NOT NULL, contract INTEGER NOT NULL, made INTEGER NOT NULL,
      result TEXT NOT NULL, finished_at INTEGER NOT NULL,
      PRIMARY KEY (match_id, deal_index)
    );
    INSERT INTO matches (id, room_id, config, first_dealer, status, started_at)
      VALUES ('m0', 'r0', '{}', 0, 'active', 1);
    INSERT INTO deals (match_id, deal_index, dealer, declarer, contract, made, result, finished_at)
      VALUES ('m0', 0, 0, 2, 185, 1, '{"legacy":true}', 1);
  `);
  raw.close();
}

function sides(n: number): DealResult['sides'] {
  return Array.from({ length: n }, () => ({
    cardPoints: 10,
    lastTrickBonus: 0,
    marriagePoints: 0,
    discardPoints: 0,
    rawTotal: 10,
    roundedTotal: 10,
    tricks: 1,
    porvoo: false,
    scoreDelta: 10,
  }));
}

test('opening a legacy db migrates it; a 3-player deal result records without throwing', () => {
  seedLegacySchema();
  const db = new Db(dbPath); // runs migrate()

  const cols = (db.raw.prepare('PRAGMA table_info(deals)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(cols).toContain('bid');

  // The exact call that stalled the live game (3-player deal, declarer seat 2).
  const result: DealResult = { declarer: 2, contract: 185, bid: 100, made: true, sides: sides(3) };
  expect(() => db.recordDealResult('m0', 1, 1, result)).not.toThrow();

  // The pre-existing legacy summary row survives the rebuild.
  const legacy = db.raw
    .prepare('SELECT result FROM deals WHERE match_id = ? AND deal_index = 0')
    .get('m0') as { result: string } | undefined;
  expect(legacy?.result).toBe('{"legacy":true}');
  db.close();
});

test('migrated deals table accepts a contract-less (all-pass) deal with null columns', () => {
  seedLegacySchema();
  const db = new Db(dbPath);
  const contractless: DealResult = {
    declarer: null,
    contract: null,
    bid: null,
    made: null,
    sides: sides(3),
  };
  expect(() => db.recordDealResult('m0', 2, 1, contractless)).not.toThrow();
  db.close();
});

test('migrated matches table accepts finishMatch (final_scores column added)', () => {
  seedLegacySchema();
  const db = new Db(dbPath);
  expect(() => db.finishMatch('m0', 2, [10, 20, 185])).not.toThrow();
  const row = db.raw.prepare('SELECT final_scores FROM matches WHERE id = ?').get('m0') as {
    final_scores: string;
  };
  expect(JSON.parse(row.final_scores)).toEqual([10, 20, 185]);
  db.close();
});

test('migrate is idempotent and a no-op on a fresh db', () => {
  const db = new Db(dbPath); // fresh: SCHEMA already current
  const result: DealResult = { declarer: 0, contract: 60, bid: 60, made: false, sides: sides(2) };
  expect(() => db.recordDealResult('mX', 0, 0, result)).not.toThrow();
  db.close();
  // Re-open (migrate runs again) — must not error or lose data.
  const db2 = new Db(dbPath);
  const row = db2.raw.prepare('SELECT bid FROM deals WHERE match_id = ?').get('mX') as {
    bid: number;
  };
  expect(row.bid).toBe(60);
  db2.close();
});
