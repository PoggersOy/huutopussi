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
import { STARTING_RATING } from './elo.js';
import type { RoomTableSettings } from './rooms.js';
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
  names        TEXT,                -- JSON (string|null)[], seat-indexed, at match end
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
-- Google-linked accounts and their Elo. Keyed on the Google 'sub' (stable),
-- never email (emails change/recycle). Guests never get a row here.
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT NOT NULL UNIQUE,
  email        TEXT,
  name         TEXT,
  picture      TEXT,
  rating       INTEGER NOT NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  win_streak   INTEGER NOT NULL DEFAULT 0,
  best_streak  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- Opaque app session tokens. Only the sha256 hash is stored, so a db leak
-- yields no usable tokens. Revocation = delete the row.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
-- Durable per-match rating deltas (profile screen + reconnect-after-finish).
CREATE TABLE IF NOT EXISTS rating_events (
  match_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  seat          INTEGER NOT NULL,
  rating_before INTEGER NOT NULL,
  rating_after  INTEGER NOT NULL,
  delta         INTEGER NOT NULL,
  streak_after  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_rating_events_user ON rating_events(user_id, created_at);
`;

export interface SessionRow {
  token: string;
  roomId: string;
  seat: Seat | null;
  nickname: string | null;
  kind: SessionKind;
  /** Signed-in account behind this session, or null for a guest. */
  userId: string | null;
}

/** A user account row (camelCased). */
export interface UserRow {
  id: string;
  googleSub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winStreak: number;
  bestStreak: number;
}

/** One persisted per-match rating change for a user. */
export interface RatingEventRow {
  matchId: string;
  seat: Seat;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  streakAfter: number;
  createdAt: number;
}

/** A single participant's rating outcome, written at match end. */
export interface RatingUpdate {
  matchId: string;
  userId: string;
  seat: Seat;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  newStreak: number;
  isWin: boolean;
  createdAt: number;
}

export interface RecoveredMatch {
  matchId: string;
  roomId: string;
  code: string;
  hostToken: string | null;
  roomConfig: RuleConfig;
  /** null for rooms created before the table-settings column existed. */
  tableSettings: RoomTableSettings | null;
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
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns and
   * constraints added after a db was first created must be applied here, or
   * writes fail at runtime (e.g. an older `deals` table lacking the `bid`/
   * `result` columns threw at the first deal that reached scoring, stalling the
   * game on its last card). A migration must NEVER prevent boot — a throw here
   * would crash-loop the whole server and take the site down — so the body is
   * wrapped and failures are logged, not fatal. No-op on an up-to-date db.
   */
  private migrate(): void {
    try {
      this.raw.transaction(() => {
        this.addColumnIfMissing('matches', 'final_scores', 'TEXT');
        // Seat-indexed player names captured at match end (JSON (string|null)[]),
        // so the history deal-browser can label columns/declarer with the names
        // that played THAT match (live seats change between matches). Nullable:
        // pre-feature matches simply have no names.
        this.addColumnIfMissing('matches', 'names', 'TEXT');
        // Turn pacing (autoplay + timeout); nullable so pre-feature rooms
        // recover with the server default (see activeMatches / server.ts).
        this.addColumnIfMissing('rooms', 'table_settings', 'TEXT');
        // Links a live session to a signed-in account; null = guest.
        this.addColumnIfMissing('sessions', 'user_id', 'TEXT');
        this.rebuildDealsIfDrifted();
      })();
    } catch (err) {
      console.error('[db] schema migration failed (continuing without it):', err);
    }
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

  /**
   * `deals` is a rebuildable per-deal SUMMARY only — crash recovery replays
   * `matches` + `deal_events`, never this table — so on ANY schema drift we
   * recreate it to the current shape rather than assume the legacy columns
   * (older builds variously lacked `bid`/`result` or declared declarer/
   * contract/made NOT NULL). Rows are copied only when every NOT NULL column is
   * present to source; otherwise the table starts empty. Losing legacy summary
   * rows only affects the history screen for pre-migration deals.
   */
  private rebuildDealsIfDrifted(): void {
    const cols = this.columnsOf('deals');
    const names = cols.map((c) => c.name);
    const CURRENT = [
      'match_id',
      'deal_index',
      'dealer',
      'declarer',
      'contract',
      'bid',
      'made',
      'result',
      'finished_at',
    ];
    const declarer = cols.find((c) => c.name === 'declarer');
    const upToDate =
      names.length === CURRENT.length &&
      CURRENT.every((c) => names.includes(c)) &&
      declarer?.notnull === 0; // current schema makes it nullable
    if (upToDate) return;

    // NOT NULL columns with no default: rows are only preservable if present.
    const required = ['match_id', 'deal_index', 'dealer', 'result', 'finished_at'];
    const canPreserve = required.every((c) => names.includes(c));

    this.raw.exec('ALTER TABLE deals RENAME TO deals_legacy;');
    this.raw.exec(`CREATE TABLE deals (
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
    );`);
    if (canPreserve) {
      const src = CURRENT.map((c) => (names.includes(c) ? c : 'NULL')).join(', ');
      this.raw.exec(`INSERT INTO deals (${CURRENT.join(', ')}) SELECT ${src} FROM deals_legacy;`);
    }
    this.raw.exec('DROP TABLE deals_legacy;');
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
    tableSettings: RoomTableSettings;
  }): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO rooms (id, code, host_token, config, table_settings, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'lobby', ?, ?)`,
      )
      .run(
        row.id,
        row.code,
        row.hostToken,
        JSON.stringify(row.config),
        JSON.stringify(row.tableSettings),
        now,
        now,
      );
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

  setRoomTableSettings(id: string, tableSettings: RoomTableSettings): void {
    this.raw
      .prepare('UPDATE rooms SET table_settings = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(tableSettings), Date.now(), id);
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
        `INSERT INTO sessions (token, room_id, seat, nickname, kind, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE
           SET seat = excluded.seat, nickname = excluded.nickname,
               user_id = excluded.user_id, updated_at = excluded.updated_at`,
      )
      .run(row.token, row.roomId, row.seat, row.nickname, row.kind, row.userId, now, now);
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

  /**
   * `names` is the seat-indexed roster at match end (length === players), for
   * the history deal-browser; omit it (or pass null) for callers that don't
   * have it — the summary then falls back to generic seat/side labels.
   */
  finishMatch(
    id: string,
    winnerSide: Side,
    finalScores: number[],
    names?: (string | null)[] | null,
  ): void {
    this.raw
      .prepare(
        `UPDATE matches SET status = 'finished', winner_side = ?, final_scores = ?,
         names = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        winnerSide,
        JSON.stringify(finalScores),
        names == null ? null : JSON.stringify(names),
        Date.now(),
        id,
      );
  }

  abandonMatch(id: string): void {
    this.raw
      .prepare(`UPDATE matches SET status = 'abandoned', finished_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  matchSummaries(roomId: string): MatchSummary[] {
    const rows = this.raw
      .prepare(
        `SELECT id, winner_side, final_scores, names, config, deals, finished_at
         FROM matches WHERE room_id = ? AND status = 'finished' ORDER BY finished_at ASC`,
      )
      .all(roomId) as Array<{
      id: string;
      winner_side: number;
      final_scores: string | null;
      names: string | null;
      config: string;
      deals: number;
      finished_at: number;
    }>;
    // Per-deal breakdowns for the history deal-browser. The full DealResult of
    // every deal is already persisted; pull them in deal order per match.
    const dealStmt = this.raw.prepare(
      'SELECT result FROM deals WHERE match_id = ? ORDER BY deal_index ASC',
    );
    return rows.map((r) => {
      const players = (JSON.parse(r.config) as RuleConfig).players;
      const dealResults = (dealStmt.all(r.id) as Array<{ result: string }>).map(
        (d) => JSON.parse(d.result) as DealResult,
      );
      return {
        finishedAt: r.finished_at,
        winnerSide: (r.winner_side === 0 || r.winner_side === 1 || r.winner_side === 2
          ? r.winner_side
          : 0) as Side,
        finalScores: r.final_scores === null ? [] : (JSON.parse(r.final_scores) as number[]),
        deals: r.deals,
        players,
        dealResults,
        ...(r.names === null ? {} : { names: JSON.parse(r.names) as (string | null)[] }),
      };
    });
  }

  /** All matches still marked active, newest first, with their full event logs. */
  activeMatches(): RecoveredMatch[] {
    const rows = this.raw
      .prepare(
        `SELECT m.id AS match_id, m.room_id, m.config AS match_config,
                m.first_dealer, m.started_at,
                r.code, r.host_token, r.config AS room_config, r.table_settings
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
      table_settings: string | null;
    }>;
    const eventStmt = this.raw.prepare(
      'SELECT seq, event FROM deal_events WHERE match_id = ? ORDER BY seq ASC',
    );
    const sessionStmt = this.raw.prepare(
      'SELECT token, room_id, seat, nickname, kind, user_id FROM sessions WHERE room_id = ?',
    );
    return rows.map((r) => {
      const eventRows = eventStmt.all(r.match_id) as Array<{ seq: number; event: string }>;
      const sessionRows = sessionStmt.all(r.room_id) as Array<{
        token: string;
        room_id: string;
        seat: number | null;
        nickname: string | null;
        kind: string;
        user_id: string | null;
      }>;
      const last = eventRows[eventRows.length - 1];
      return {
        matchId: r.match_id,
        roomId: r.room_id,
        code: r.code,
        hostToken: r.host_token,
        roomConfig: JSON.parse(r.room_config) as RuleConfig,
        tableSettings:
          r.table_settings === null ? null : (JSON.parse(r.table_settings) as RoomTableSettings),
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
          userId: s.user_id,
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

  // ── users / auth tokens / ratings ────────────────────────────────────────────

  /**
   * Insert a user (with the starting rating) on first sign-in, or refresh the
   * profile fields (email/name/picture) on a returning sign-in. Keyed on the
   * Google `sub`. Returns the full current row.
   */
  upsertUserByGoogleSub(profile: {
    id: string;
    googleSub: string;
    email: string | null;
    name: string | null;
    picture: string | null;
  }): UserRow {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO users (id, google_sub, email, name, picture, rating, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(google_sub) DO UPDATE
           SET email = excluded.email, name = excluded.name,
               picture = excluded.picture, updated_at = excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.googleSub,
        profile.email,
        profile.name,
        profile.picture,
        STARTING_RATING,
        now,
        now,
      );
    const row = this.getUserByGoogleSub(profile.googleSub);
    if (!row) throw new Error('upsertUserByGoogleSub: row missing after upsert');
    return row;
  }

  getUserByGoogleSub(googleSub: string): UserRow | null {
    return this.mapUser(
      this.raw.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub) as
        | UserDbRow
        | undefined,
    );
  }

  getUserById(id: string): UserRow | null {
    return this.mapUser(
      this.raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserDbRow | undefined,
    );
  }

  private mapUser(row: UserDbRow | undefined): UserRow | null {
    if (!row) return null;
    return {
      id: row.id,
      googleSub: row.google_sub,
      email: row.email,
      name: row.name,
      picture: row.picture,
      rating: row.rating,
      gamesPlayed: row.games_played,
      wins: row.wins,
      losses: row.losses,
      winStreak: row.win_streak,
      bestStreak: row.best_streak,
    };
  }

  createAuthToken(tokenHash: string, userId: string, expiresAt: number): void {
    this.raw
      .prepare(
        `INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, Date.now(), expiresAt, Date.now());
  }

  /** Resolve a token hash to its user id if present and unexpired; touches last_used_at. */
  resolveAuthToken(tokenHash: string, nowMs: number): string | null {
    const row = this.raw
      .prepare('SELECT user_id, expires_at FROM auth_tokens WHERE token_hash = ?')
      .get(tokenHash) as { user_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= nowMs) return null;
    this.raw
      .prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token_hash = ?')
      .run(nowMs, tokenHash);
    return row.user_id;
  }

  deleteAuthToken(tokenHash: string): void {
    this.raw.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(tokenHash);
  }

  /** Removes expired auth tokens; returns the number deleted. */
  pruneExpiredTokens(nowMs: number): number {
    return this.raw.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').run(nowMs).changes;
  }

  /**
   * Apply the rating outcomes of one finished, rated match: bump each user's
   * rating / games / W-L / streak and append an immutable rating_event. Call
   * inside the match-end transaction (better-sqlite3 is synchronous).
   */
  applyRatingResults(updates: RatingUpdate[]): void {
    const userStmt = this.raw.prepare(
      `UPDATE users
         SET rating = ?, games_played = games_played + 1,
             wins = wins + ?, losses = losses + ?,
             win_streak = ?, best_streak = MAX(best_streak, ?), updated_at = ?
       WHERE id = ?`,
    );
    const eventStmt = this.raw.prepare(
      `INSERT OR REPLACE INTO rating_events
         (match_id, user_id, seat, rating_before, rating_after, delta, streak_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const u of updates) {
      userStmt.run(
        u.ratingAfter,
        u.isWin ? 1 : 0,
        u.isWin ? 0 : 1,
        u.newStreak,
        u.newStreak,
        u.createdAt,
        u.userId,
      );
      eventStmt.run(
        u.matchId,
        u.userId,
        u.seat,
        u.ratingBefore,
        u.ratingAfter,
        u.delta,
        u.newStreak,
        u.createdAt,
      );
    }
  }

  /** A user's recent rating changes, newest first (for the profile screen). */
  getRatingEventsForUser(userId: string, limit: number): RatingEventRow[] {
    const rows = this.raw
      .prepare(
        `SELECT match_id, seat, rating_before, rating_after, delta, streak_after, created_at
         FROM rating_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as Array<{
      match_id: string;
      seat: number;
      rating_before: number;
      rating_after: number;
      delta: number;
      streak_after: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      matchId: r.match_id,
      seat: r.seat as Seat,
      ratingBefore: r.rating_before,
      ratingAfter: r.rating_after,
      delta: r.delta,
      streakAfter: r.streak_after,
      createdAt: r.created_at,
    }));
  }
}

/** Raw users-table row shape (snake_case) for internal mapping. */
interface UserDbRow {
  id: string;
  google_sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  rating: number;
  games_played: number;
  wins: number;
  losses: number;
  win_streak: number;
  best_streak: number;
  created_at: number;
  updated_at: number;
}
