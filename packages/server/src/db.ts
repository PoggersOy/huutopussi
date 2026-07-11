/**
 * db.ts — better-sqlite3 persistence (plan §7 + P6).
 *
 * Tables: rooms, sessions, matches, deals (per-deal summary), deal_events
 * (append-only event log). Events are appended inside the same transaction
 * that accepts an action, so crash recovery is free: on boot, unfinished
 * matches are replayed from deal_events (server.ts), all seats marked
 * disconnected, and the reconnect flow does the rest. Finished matches keep
 * their summaries forever; their event logs are pruned after 30 days.
 *
 * Room codes are NOT unique in the db (historical rows); uniqueness among
 * live rooms is enforced by the in-memory registry.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DealResult, GameEvent, RuleConfig, Seat, Side } from '@hp/engine';
import type { MatchSummary } from '@hp/protocol';
import Database from 'better-sqlite3';
import type { SessionKind } from './sessions.js';

export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  host_token TEXT,
  config     TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  seat       INTEGER,
  nickname   TEXT,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id);
CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL,
  config       TEXT NOT NULL,       -- RuleConfig JSON (mode: players/talon/variants)
  first_dealer INTEGER NOT NULL,
  status       TEXT NOT NULL, -- active | finished | abandoned
  winner_side  INTEGER,
  final_scores TEXT,                -- JSON number[], one per side (2 or 3)
  deals        INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id, status);
CREATE TABLE IF NOT EXISTS deals (
  match_id    TEXT NOT NULL,
  deal_index  INTEGER NOT NULL,
  dealer      INTEGER NOT NULL,
  declarer    INTEGER,              -- null = contract-less (all-pass) deal
  contract    INTEGER,
  bid         INTEGER,
  made        INTEGER,
  result      TEXT NOT NULL,        -- full DealResult JSON (variable-length sides)
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, deal_index)
);
CREATE TABLE IF NOT EXISTS deal_events (
  match_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  event      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, seq)
);
`;

export interface SessionRow {
  token: string;
  roomId: string;
  seat: Seat | null;
  nickname: string | null;
  kind: SessionKind;
}

export interface RecoveredMatch {
  matchId: string;
  roomId: string;
  code: string;
  hostToken: string | null;
  roomConfig: RuleConfig;
  matchConfig: RuleConfig;
  firstDealer: Seat;
  startedAt: number;
  eventSeq: number;
  events: GameEvent[];
  sessions: SessionRow[];
}

export class Db {
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Idempotent schema migrations for databases created by an OLDER build.
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so any column
   * or constraint added after a db was first created must be applied here or
   * writes fail at runtime (e.g. the `deals.bid` column added later would throw
   * "table deals has no column named bid" at the first deal that reaches
   * scoring, stalling the game). Safe to run on every boot; a no-op on a db
   * already at the current schema.
   */
  private migrate(): void {
    this.raw.transaction(() => {
      // Additive nullable columns (plain ALTER … ADD COLUMN).
      this.addColumnIfMissing('deals', 'bid', 'INTEGER');
      this.addColumnIfMissing('matches', 'final_scores', 'TEXT');
      // The original `deals` schema declared declarer/contract/made NOT NULL;
      // contract-less (all-pass) deals record them as null, so relax to
      // nullable by rebuilding the table (SQLite cannot drop a NOT NULL in
      // place). Preserves existing rows.
      this.relaxDealsNullability();
    })();
  }

  private columnsOf(table: string): Array<{ name: string; notnull: number }> {
    return this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
    }>;
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    if (!this.columnsOf(table).some((c) => c.name === column)) {
      this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private relaxDealsNullability(): void {
    const declarer = this.columnsOf('deals').find((c) => c.name === 'declarer');
    if (!declarer || declarer.notnull === 0) return; // already nullable / fresh schema
    // `bid` is guaranteed present here (addColumnIfMissing ran just above).
    this.raw.exec(`
      CREATE TABLE deals_new (
        match_id    TEXT NOT NULL,
        deal_index  INTEGER NOT NULL,
        dealer      INTEGER NOT NULL,
        declarer    INTEGER,
        contract    INTEGER,
        bid         INTEGER,
        made        INTEGER,
        result      TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        PRIMARY KEY (match_id, deal_index)
      );
      INSERT INTO deals_new
        (match_id, deal_index, dealer, declarer, contract, bid, made, result, finished_at)
        SELECT match_id, deal_index, dealer, declarer, contract, bid, made, result, finished_at
        FROM deals;
      DROP TABLE deals;
      ALTER TABLE deals_new RENAME TO deals;
    `);
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  close(): void {
    this.raw.close();
  }

  // ── rooms ──────────────────────────────────────────────────────────────────

  createRoom(row: {
    id: string;
    code: string;
    hostToken: string | null;
    config: RuleConfig;
  }): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO rooms (id, code, host_token, config, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'lobby', ?, ?)`,
      )
      .run(row.id, row.code, row.hostToken, JSON.stringify(row.config), now, now);
  }

  setRoomStatus(id: string, status: string): void {
    this.raw
      .prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  setRoomConfig(id: string, config: RuleConfig): void {
    this.raw
      .prepare('UPDATE rooms SET config = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), Date.now(), id);
  }

  setRoomHost(id: string, hostToken: string | null): void {
    this.raw
      .prepare('UPDATE rooms SET host_token = ?, updated_at = ? WHERE id = ?')
      .run(hostToken, Date.now(), id);
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  saveSession(row: SessionRow): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO sessions (token, room_id, seat, nickname, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE
           SET seat = excluded.seat, nickname = excluded.nickname, updated_at = excluded.updated_at`,
      )
      .run(row.token, row.roomId, row.seat, row.nickname, row.kind, now, now);
  }

  deleteSession(token: string): void {
    this.raw.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ── matches / deals / events ───────────────────────────────────────────────

  createMatch(row: { id: string; roomId: string; config: RuleConfig; firstDealer: Seat }): void {
    this.raw
      .prepare(
        `INSERT INTO matches (id, room_id, config, first_dealer, status, started_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(row.id, row.roomId, JSON.stringify(row.config), row.firstDealer, Date.now());
  }

  appendEvent(matchId: string, seq: number, event: GameEvent): void {
    this.raw
      .prepare('INSERT INTO deal_events (match_id, seq, event, created_at) VALUES (?, ?, ?, ?)')
      .run(matchId, seq, JSON.stringify(event), Date.now());
  }

  recordDealResult(matchId: string, dealIndex: number, dealer: Seat, result: DealResult): void {
    // The full DealResult (2 or 3 SideBreakdowns) goes in as JSON; the
    // queryable columns are duplicated out. declarer/contract/bid/made are
    // null for a contract-less (all-pass) deal.
    if (result.sides.length < 2) {
      throw new Error('recordDealResult: fewer than two sides in DealResult');
    }
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO deals (
           match_id, deal_index, dealer, declarer, contract, bid, made, result, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        matchId,
        dealIndex,
        dealer,
        result.declarer,
        result.contract,
        result.bid,
        result.made === null ? null : result.made ? 1 : 0,
        JSON.stringify(result),
        Date.now(),
      );
    this.raw.prepare('UPDATE matches SET deals = deals + 1 WHERE id = ?').run(matchId);
  }

  finishMatch(id: string, winnerSide: Side, finalScores: number[]): void {
    this.raw
      .prepare(
        `UPDATE matches SET status = 'finished', winner_side = ?, final_scores = ?,
         finished_at = ? WHERE id = ?`,
      )
      .run(winnerSide, JSON.stringify(finalScores), Date.now(), id);
  }

  abandonMatch(id: string): void {
    this.raw
      .prepare(`UPDATE matches SET status = 'abandoned', finished_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  matchSummaries(roomId: string): MatchSummary[] {
    const rows = this.raw
      .prepare(
        `SELECT winner_side, final_scores, deals, finished_at
         FROM matches WHERE room_id = ? AND status = 'finished' ORDER BY finished_at ASC`,
      )
      .all(roomId) as Array<{
      winner_side: number;
      final_scores: string | null;
      deals: number;
      finished_at: number;
    }>;
    return rows.map((r) => ({
      finishedAt: r.finished_at,
      winnerSide: (r.winner_side === 0 || r.winner_side === 1 || r.winner_side === 2
        ? r.winner_side
        : 0) as Side,
      finalScores: r.final_scores === null ? [] : (JSON.parse(r.final_scores) as number[]),
      deals: r.deals,
    }));
  }

  /** All matches still marked active, newest first, with their full event logs. */
  activeMatches(): RecoveredMatch[] {
    const rows = this.raw
      .prepare(
        `SELECT m.id AS match_id, m.room_id, m.config AS match_config,
                m.first_dealer, m.started_at,
                r.code, r.host_token, r.config AS room_config
         FROM matches m JOIN rooms r ON r.id = m.room_id
         WHERE m.status = 'active' ORDER BY m.started_at DESC`,
      )
      .all() as Array<{
      match_id: string;
      room_id: string;
      match_config: string;
      first_dealer: number;
      started_at: number;
      code: string;
      host_token: string | null;
      room_config: string;
    }>;
    const eventStmt = this.raw.prepare(
      'SELECT seq, event FROM deal_events WHERE match_id = ? ORDER BY seq ASC',
    );
    const sessionStmt = this.raw.prepare(
      'SELECT token, room_id, seat, nickname, kind FROM sessions WHERE room_id = ?',
    );
    return rows.map((r) => {
      const eventRows = eventStmt.all(r.match_id) as Array<{ seq: number; event: string }>;
      const sessionRows = sessionStmt.all(r.room_id) as Array<{
        token: string;
        room_id: string;
        seat: number | null;
        nickname: string | null;
        kind: string;
      }>;
      const last = eventRows[eventRows.length - 1];
      return {
        matchId: r.match_id,
        roomId: r.room_id,
        code: r.code,
        hostToken: r.host_token,
        roomConfig: JSON.parse(r.room_config) as RuleConfig,
        matchConfig: JSON.parse(r.match_config) as RuleConfig,
        firstDealer: r.first_dealer as Seat,
        startedAt: r.started_at,
        eventSeq: last ? last.seq : 0,
        events: eventRows.map((e) => JSON.parse(e.event) as GameEvent),
        sessions: sessionRows.map((s) => ({
          token: s.token,
          roomId: s.room_id,
          seat: s.seat === null ? null : (s.seat as Seat),
          nickname: s.nickname,
          kind: s.kind === 'bot' ? 'bot' : 'human',
        })),
      };
    });
  }

  /** Prunes event logs of matches finished/abandoned before `cutoffMs`. */
  pruneOldEvents(cutoffMs: number): number {
    const res = this.raw
      .prepare(
        `DELETE FROM deal_events WHERE match_id IN (
           SELECT id FROM matches
           WHERE status != 'active' AND finished_at IS NOT NULL AND finished_at < ?
         )`,
      )
      .run(cutoffMs);
    return res.changes;
  }
}
