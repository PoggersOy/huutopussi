/**
 * Host-configurable turn pacing (tableSettings): autoplay on/off + turn timeout.
 *  - autoplay OFF: a present, idle human is never passed to a bot and has no
 *    deadline (unlimited time), yet still receives their hints;
 *  - setTableSettings mid-match re-arms the live turn with the new timeout;
 *  - a player who RETURNS from being autoplayed reclaims the seat at once and
 *    gets a FULL fresh turn budget (never the tail of the bot's clock).
 */
import { expectedActor, type Seat } from '@hp/engine';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import type { Room } from '../src/rooms.js';
import type { Session } from '../src/sessions.js';
import { sleep, TestClient } from './helpers.js';

let server: HpServer;
let port: number;

beforeEach(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: {
      turnMs: 20_000, // long: a present human's turn won't self-expire mid-test
      wholeAnswerMs: 20_000,
      graceMs: 150,
      nextDealDelayMs: 60_000,
      redealDelayMs: 20,
      botDelayMs: [20, 20],
    },
  });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
});

function seatSession(room: Room, seat: Seat): Session | null {
  for (const s of room.sessions.values()) if (s.seat === seat) return s;
  return null;
}

async function fillBotsAndStart(host: TestClient): Promise<void> {
  for (const seat of [1, 2, 3] as Seat[]) {
    const ack = host.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'bot',
      10_000,
      `bot at ${seat}`,
    );
    host.lobby({ type: 'addBot', seat });
    await ack;
  }
  const started = host.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'match start');
  host.lobby({ type: 'startMatch' });
  await started;
}

/**
 * Resolves once the bots have played round to the (idle) host's own turn. Polls
 * the client's live turn state rather than awaiting a future message: when seat
 * 0 opens, that update arrives with `startMatch` and a `next()` would miss it.
 */
async function waitHostTurn(host: TestClient, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (host.lastTurn?.seat === 0 && host.lastTurn.hints != null) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for host turn');
}

test('autoplay off: a present idle human keeps their hints and is never auto-played', async () => {
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'idler' });
  const code = host.roomCode;

  // Turn autoplay OFF from the lobby, then start with bots filling 1-3.
  const off = host.next(
    (m) => m.t === 'room' && m.room.tableSettings.autoplay === false,
    5_000,
    'autoplay off',
  );
  host.lobby({ type: 'setTableSettings', patch: { autoplay: false } });
  await off;
  await fillBotsAndStart(host);

  // Play reaches the idle host and simply waits there — no deadline, no bot.
  await waitHostTurn(host);
  const room = server.rooms.get(code);
  if (!room?.match) throw new Error('room/match missing');
  expect(room.tableSettings.autoplay).toBe(false);
  expect(room.turnDeadline).toBeNull();
  // The acting seat still got its hints even with no deadline.
  expect(host.lastTurn?.deadline).toBeNull();
  expect(host.lastTurn?.hints).not.toBeNull();

  // Well beyond the (20 s) turnMs floor would be overkill; even a long pause
  // leaves the seat untouched because autoplay is off.
  await sleep(500);
  expect(seatSession(room, 0)?.botControlled).toBe(false);
  expect(room.turnDeadline).toBeNull();
  expect(expectedActor(room.match)).toBe(0); // still the human's turn

  host.close();
});

test('disconnect with autoplay off broadcasts the newly armed grace deadline', async () => {
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'idler' });
  const code = host.roomCode;
  const off = host.next(
    (m) => m.t === 'room' && m.room.tableSettings.autoplay === false,
    5_000,
    'autoplay off',
  );
  host.lobby({ type: 'setTableSettings', patch: { autoplay: false } });
  await off;
  await fillBotsAndStart(host);
  await waitHostTurn(host);

  // A spectator keeps the room alive and observes the authoritative deadline.
  const observer = await TestClient.connect(port);
  await observer.hello({ roomCode: code, nickname: 'observer' });
  const update = observer.next(
    (m) =>
      m.t === 'update' &&
      m.room?.seats[0]?.connected === false &&
      m.turn?.seat === 0 &&
      m.turn.deadline !== null,
    5_000,
    'disconnect grace deadline',
  );
  const before = Date.now();
  host.terminate();
  const observed = await update;
  if (observed.t !== 'update') throw new Error('expected update');
  expect(observed.turn?.deadline as number).toBeGreaterThan(before);

  observer.close();
});

test('setTableSettings applies a new turn timeout to the live turn', async () => {
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'host' });
  const code = host.roomCode;
  await fillBotsAndStart(host);
  await waitHostTurn(host);

  // Change the timeout mid-turn; the deadline re-arms to the new budget.
  const applied = host.next(
    (m) => m.t === 'update' && m.room?.tableSettings.turnTimeoutSec === 60 && m.turn?.seat === 0,
    5_000,
    'timeout applied',
  );
  const before = Date.now();
  host.lobby({ type: 'setTableSettings', patch: { turnTimeoutSec: 60 } });
  await applied;

  const room = server.rooms.get(code);
  if (!room?.match) throw new Error('room/match missing');
  expect(room.tableSettings.turnTimeoutMs).toBe(60_000);
  expect(room.turnDeadline).not.toBeNull();
  // ~60 s out (was ~20 s): comfortably past the old budget.
  expect(room.turnDeadline as number).toBeGreaterThan(before + 55_000);
  expect(host.lastTurn?.deadline as number).toBeGreaterThan(before + 55_000);

  host.close();
});

test('a returning away player reclaims at once with a full fresh turn', async () => {
  // Short turn budget so the idle host is passed to a fill-in bot quickly; a
  // long bot delay then holds that fill-in scheduled-but-not-yet-played, which
  // is the window we need to prove an instant reclaim on return.
  await server.close();
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: {
      turnMs: 600,
      wholeAnswerMs: 600,
      graceMs: 100,
      nextDealDelayMs: 60_000,
      redealDelayMs: 20,
      botDelayMs: [1500, 1500],
    },
  });
  port = await server.listen();

  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'leaver' });
  const code = host.roomCode;
  const token = host.token;
  await fillBotsAndStart(host);
  await waitHostTurn(host);

  const room = server.rooms.get(code);
  if (!room?.match) throw new Error('room/match missing');

  // The present-but-idle host is passed to a fill-in bot after the turn budget;
  // the bot is scheduled (1500 ms) but hasn't played yet.
  const until = Date.now() + 5_000;
  while (seatSession(room, 0)?.botControlled !== true && Date.now() < until) await sleep(20);
  expect(seatSession(room, 0)?.botControlled).toBe(true);
  expect(expectedActor(room.match)).toBe(0); // fill-in bot has not acted

  // Host returns (re-hello with its session token) while it is still their turn.
  const reply = await host.hello({ sessionToken: token });
  expect(reply.t).toBe('welcome');

  // Reclaimed immediately: away flag cleared, still their turn, a fresh full
  // budget (not the expired tail), and the welcome carried live hints.
  expect(seatSession(room, 0)?.botControlled).toBe(false);
  expect(expectedActor(room.match)).toBe(0);
  expect(room.turnDeadline).not.toBeNull();
  expect(room.turnDeadline as number).toBeGreaterThan(Date.now() + 300);
  expect(host.lastTurn?.seat).toBe(0);
  expect(host.lastTurn?.hints).not.toBeNull();

  host.close();
});

test('the "I\'m back" button (reclaimSeat) reclaims a still-connected away seat', async () => {
  // Same window as above, but the player never disconnects: they idle past the
  // turn budget, get passed to a fill-in bot, then press "I'm back" over the
  // LIVE socket — proving reclaim works without a reconnect (and off no action).
  await server.close();
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: {
      turnMs: 600,
      wholeAnswerMs: 600,
      graceMs: 100,
      nextDealDelayMs: 60_000,
      redealDelayMs: 20,
      botDelayMs: [1500, 1500],
    },
  });
  port = await server.listen();

  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'idler' });
  const code = host.roomCode;
  await fillBotsAndStart(host);
  await waitHostTurn(host);

  const room = server.rooms.get(code);
  if (!room?.match) throw new Error('room/match missing');

  // The present-but-idle host is passed to a fill-in bot after the turn budget;
  // the bot is scheduled (1500 ms) but hasn't played yet.
  const until = Date.now() + 5_000;
  while (seatSession(room, 0)?.botControlled !== true && Date.now() < until) await sleep(20);
  expect(seatSession(room, 0)?.botControlled).toBe(true);
  expect(expectedActor(room.match)).toBe(0); // fill-in bot has not acted

  // Press "I'm back" — the away flag clears and, since it is still their turn,
  // a fresh full budget is re-armed and broadcast to the countdown.
  const rearmed = host.next(
    (m) => m.t === 'update' && m.turn?.seat === 0 && m.turn.deadline != null,
    5_000,
    'reclaim re-arm',
  );
  host.lobby({ type: 'reclaimSeat' });
  await rearmed;

  expect(seatSession(room, 0)?.botControlled).toBe(false);
  expect(expectedActor(room.match)).toBe(0);
  expect(room.turnDeadline).not.toBeNull();
  expect(room.turnDeadline as number).toBeGreaterThan(Date.now() + 300);

  host.close();
});

test('reclaimSeat is a harmless no-op when the seat is not bot-filled', async () => {
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'host' });
  const code = host.roomCode;
  await fillBotsAndStart(host);
  await waitHostTurn(host);

  const room = server.rooms.get(code);
  if (!room?.match) throw new Error('room/match missing');
  expect(seatSession(room, 0)?.botControlled).toBe(false);

  // Pressing "I'm back" while already in control is a silent success: no error,
  // no state change. A no-op sends nothing back, so a follow-up broadcasting
  // command (processed in order after it) is the deterministic sync point.
  host.lobby({ type: 'reclaimSeat' });
  const synced = host.next(
    (m) => m.t === 'room' && m.room.seats[0]?.nickname === 'renamed',
    5_000,
    'sync point',
  );
  host.lobby({ type: 'setNickname', nickname: 'renamed' });
  await synced;

  expect(seatSession(room, 0)?.botControlled).toBe(false);
  expect(expectedActor(room.match)).toBe(0);
  // No error frame arrived from the reclaim (or anything before it).
  expect(host.messages.some((m) => m.t === 'error')).toBe(false);

  host.close();
});
