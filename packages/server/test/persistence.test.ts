/**
 * Persistence (P6): events are appended in the action transaction, so killing
 * the server object mid-deal and reopening the same db must recover the match
 * (replay deal_events, seats disconnected), let clients reconnect with their
 * old session tokens and finish the deal. Also: a room with zero connected
 * humans past the idle timeout is persisted as abandoned and closed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES, type Seat } from '@hp/engine';
import { expect, test } from 'vitest';
import { Db } from '../src/db.js';
import { createServer, type HpServer } from '../src/index.js';
import { attachDriver, sleep, TestClient, waitForDealScored } from './helpers.js';

async function addBots(host: TestClient): Promise<void> {
  for (const seat of [1, 2, 3] as Seat[]) {
    const ack = host.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'bot',
      10_000,
      `bot at seat ${seat}`,
    );
    host.lobby({ type: 'addBot', seat });
    await ack;
  }
}

test('kill server mid-deal, reopen db, recover, finish deal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-server-test-'));
  const dbPath = join(dir, 'hp.db');
  const timers = {
    turnMs: 15_000,
    graceMs: 15_000,
    botDelayMs: [10, 20] as [number, number],
    nextDealDelayMs: 60_000,
  };
  let server2: HpServer | null = null;

  const server1 = createServer({ port: 0, dbPath, heartbeatMs: null, timers });
  try {
    const port1 = await server1.listen();
    const host = await TestClient.connect(port1);
    const hw = await host.hello({ nickname: 'solo' });
    expect(hw.t).toBe('welcome');
    const code = host.roomCode;
    const token = host.token;
    await addBots(host);
    attachDriver(host);

    const midDeal = host.next(
      (m) => m.t === 'update' && (m.view.deal?.tricksPlayed ?? 0) >= 2,
      30_000,
      'mid-deal (2 tricks played)',
    );
    host.lobby({ type: 'startMatch' });
    await midDeal;

    const room1 = server1.rooms.get(code);
    if (!room1) throw new Error('room missing before kill');
    const eventSeqAtKill = room1.eventSeq;
    const matchId = room1.matchId;

    // Simulated crash: close() does NOT abandon matches (deploys must not
    // kill games) — the db keeps the match active with its event log.
    await server1.close();
    host.terminate();

    server2 = createServer({ port: 0, dbPath, heartbeatMs: null, timers });
    const port2 = await server2.listen();

    const room2 = server2.rooms.get(code);
    if (!room2) throw new Error('room not recovered from db');
    expect(room2.matchId).toBe(matchId);
    expect(room2.status).toBe('playing');
    expect(room2.eventSeq).toBeGreaterThanOrEqual(eventSeqAtKill);
    expect(room2.match?.deal).not.toBeNull();
    expect(room2.match?.deal?.phase.name).not.toBe('scored');
    expect(room2.match?.winnerSide).toBeNull();
    // Every recovered seat starts disconnected.
    for (const s of room2.sessions.values()) expect(s.socket).toBeNull();

    // The human reclaims its seat with the persisted session token.
    const host2 = await TestClient.connect(port2);
    const w2 = await host2.hello({ sessionToken: token, roomCode: code });
    expect(w2.t).toBe('welcome');
    expect(host2.token).toBe(token);
    expect(host2.seat).toBe(0);
    expect(host2.lastView?.deal).not.toBeNull();
    attachDriver(host2);

    const scored = await waitForDealScored(host2, 60_000);
    expect(scored.view.deal?.tricksPlayed).toBe(9);

    // The recovered match's deal summary landed in the same db.
    const dealRows = server2.db.raw
      .prepare('SELECT COUNT(*) AS n FROM deals WHERE match_id = ?')
      .get(matchId) as { n: number };
    expect(dealRows.n).toBe(1);

    host2.close();
  } finally {
    await server1.close();
    if (server2) await server2.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test('room with zero connected humans is abandoned and closed after idle timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-server-idle-'));
  const dbPath = join(dir, 'hp.db');
  const server = createServer({
    port: 0,
    dbPath,
    heartbeatMs: null,
    timers: {
      turnMs: 300,
      graceMs: 100,
      botDelayMs: [0, 1],
      nextDealDelayMs: 20,
      redealDelayMs: 10,
      idleCloseMs: 200,
    },
  });
  try {
    const port = await server.listen();
    const host = await TestClient.connect(port);
    const hw = await host.hello({ nickname: 'ghost' });
    expect(hw.t).toBe('welcome');
    const code = host.roomCode;
    const token = host.token;
    await addBots(host);
    const started = host.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'start');
    host.lobby({ type: 'startMatch' });
    await started;
    const room = server.rooms.get(code);
    if (!room) throw new Error('room missing');
    const matchId = room.matchId;

    host.terminate();

    const deadline = Date.now() + 10_000;
    while (server.rooms.has(code) && Date.now() < deadline) await sleep(25);
    expect(server.rooms.has(code)).toBe(false);

    const matchRow = server.db.raw
      .prepare('SELECT status FROM matches WHERE id = ?')
      .get(matchId) as { status: string } | undefined;
    expect(matchRow?.status).toBe('abandoned');
    const roomRow = server.db.raw.prepare('SELECT status FROM rooms WHERE id = ?').get(room.id) as
      | { status: string }
      | undefined;
    expect(roomRow?.status).toBe('closed');
    const sessionRows = server.db.raw
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE room_id = ?')
      .get(room.id) as { n: number };
    expect(sessionRows.n).toBe(0);

    // The closed room is gone: the old token cannot resume it.
    const late = await TestClient.connect(port);
    const reply = await late.hello({ sessionToken: token, roomCode: code });
    expect(reply.t).toBe('error');
    expect((reply as { code: string }).code).toBe('error.roomNotFound');
    late.close();
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('maintenance prunes old inactive rooms but preserves recoverable playing rooms', () => {
  const db = new Db(':memory:');
  const settings = { autoplay: true, turnTimeoutMs: 90_000 };
  db.createRoom({
    id: 'old',
    code: 'AAAAA',
    hostToken: null,
    config: DEFAULT_RULES,
    tableSettings: settings,
  });
  db.saveSession({
    token: 'old-token',
    roomId: 'old',
    seat: 0,
    nickname: 'Old name',
    kind: 'human',
    userId: null,
  });
  db.setRoomStatus('old', 'closed');
  db.createRoom({
    id: 'active',
    code: 'BBBBB',
    hostToken: null,
    config: DEFAULT_RULES,
    tableSettings: settings,
  });
  db.setRoomStatus('active', 'playing');
  db.raw.prepare('UPDATE rooms SET updated_at = 1').run();

  expect(db.pruneInactiveRooms(2)).toEqual({ rooms: 1, sessions: 1 });
  expect(db.raw.prepare('SELECT id FROM rooms ORDER BY id').all()).toEqual([{ id: 'active' }]);
  expect(db.raw.prepare('SELECT token FROM sessions').all()).toEqual([]);
  db.close();
});

test('recovery preserves an explicitly unranked match disposition and start roster', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-rating-recovery-'));
  const dbPath = join(dir, 'hp.db');
  const db = new Db(dbPath);
  const settings = { autoplay: true, turnTimeoutMs: 90_000 };
  db.createRoom({
    id: 'room-unranked',
    code: 'UNR4K',
    hostToken: null,
    config: { ...DEFAULT_RULES, players: 2 },
    tableSettings: settings,
  });
  db.setRoomStatus('room-unranked', 'playing');
  db.createMatch({
    id: 'match-unranked',
    roomId: 'room-unranked',
    config: { ...DEFAULT_RULES, players: 2 },
    firstDealer: 0,
    ratingEligible: false,
    roster: [
      { seat: 0, kind: 'human', userId: 'u1', participantKey: 'user:u1' },
      { seat: 1, kind: 'human', userId: 'u2', participantKey: 'user:u2' },
    ],
  });
  db.close();

  const recovered = createServer({ port: 0, dbPath, heartbeatMs: null });
  try {
    const room = recovered.rooms.get('UNR4K');
    expect(room?.ratingEligible).toBe(false);
    expect(room?.matchRoster.map((p) => p.userId)).toEqual(['u1', 'u2']);
  } finally {
    await recovered.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
