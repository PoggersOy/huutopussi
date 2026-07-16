/**
 * Reconnection / session-lifecycle hardening:
 *  - a connected-but-idle human passed to the fill-in bot reclaims their seat
 *    in-band by simply acting (no reload / second hello required);
 *  - re-hello on the same socket does not orphan the previous guest session;
 *  - a room enforces its per-room session cap.
 */
import type { Seat } from '@hp/engine';
import type { ServerMsg } from '@hp/protocol';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import type { Room } from '../src/rooms.js';
import type { Session } from '../src/sessions.js';
import { scriptedAction, TestClient } from './helpers.js';

let server: HpServer;
let port: number;

beforeEach(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: {
      turnMs: 150,
      wholeAnswerMs: 150,
      graceMs: 100,
      nextDealDelayMs: 60_000,
      redealDelayMs: 20,
      idleCloseMs: 600_000,
      botDelayMs: [800, 800],
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

test('a connected human passed to the fill-in bot reclaims by acting', async () => {
  const host = await TestClient.connect(port);
  const hw = await host.hello({ nickname: 'idler' });
  expect(hw.t).toBe('welcome');
  expect(host.seat).toBe(0);
  const code = host.roomCode;
  await fillBotsAndStart(host);

  const room = server.rooms.get(code);
  if (!room) throw new Error('room missing');

  // Seat 0 stays connected but never acts: after turnMs it is marked
  // botControlled and the bot starts filling in.
  await host.next(
    (m) => m.t === 'room' && m.room.seats[0]?.kind === 'human' && m.room.seats[0].botControlled,
    10_000,
    'seat 0 goes botControlled',
  );
  expect(seatSession(room, 0)?.botControlled).toBe(true);
  // Its socket is still open — the finding: only a page reload used to recover.
  expect(seatSession(room, 0)?.socket).not.toBeNull();

  // The still-present human acts on their own hints -> instant reclaim.
  const reclaimed = host.next(
    (m) => m.t === 'room' && m.room.seats[0]?.kind === 'human' && !m.room.seats[0].botControlled,
    10_000,
    'seat 0 reclaimed',
  );
  const view = host.lastView;
  const hints = host.lastTurn?.hints;
  if (!view || !hints) throw new Error('expected the reclaimed seat to hold live hints');
  host.action(scriptedAction(view, hints));
  await reclaimed;

  expect(seatSession(room, 0)?.botControlled).toBe(false);

  host.close();
});

test('re-hello on the same socket does not orphan the previous guest session', async () => {
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'host' });
  const code = host.roomCode;
  const room = server.rooms.get(code);
  if (!room) throw new Error('room missing');

  const guest = await TestClient.connect(port);
  await guest.hello({ roomCode: code });
  const afterJoin = room.sessions.size; // host + guest

  // Repeated re-hellos on the SAME socket must each drop the detached guest,
  // never accumulate dead sessions.
  for (let i = 0; i < 5; i++) {
    await guest.hello({ roomCode: code });
    expect(room.sessions.size).toBe(afterJoin);
  }

  host.close();
  guest.close();
});

test('a full room refuses further guests with error.roomFull', async () => {
  await server.close();
  server = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null, maxSessionsPerRoom: 3 });
  port = await server.listen();

  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'host' });
  const code = host.roomCode;

  // host (1) + two guests (3) exactly fills the cap.
  const guests: TestClient[] = [];
  for (let i = 0; i < 2; i++) {
    const g = await TestClient.connect(port);
    const w = await g.hello({ roomCode: code });
    expect(w.t).toBe('welcome');
    guests.push(g);
  }

  const overflow = await TestClient.connect(port);
  const reply = (await overflow.hello({ roomCode: code })) as ServerMsg;
  expect(reply.t).toBe('error');
  expect((reply as { code: string }).code).toBe('error.roomFull');

  host.close();
  overflow.close();
  for (const g of guests) g.close();
});

test('unidentified and message-flooding WebSockets are closed', async () => {
  await server.close();
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    wsHelloTimeoutMs: 30,
    wsRateLimit: { windowMs: 60_000, maxMessages: 3 },
  });
  port = await server.listen();

  const unidentified = await TestClient.connect(port);
  expect(await unidentified.waitClose(2_000, 'hello timeout')).toBe(1008);

  const flood = await TestClient.connect(port);
  const welcome = await flood.hello({ nickname: 'flood' });
  expect(welcome.t).toBe('welcome'); // hello consumed one message from the cap
  flood.send({ t: 'ping' });
  flood.send({ t: 'ping' });
  flood.send({ t: 'ping' });
  expect(await flood.waitClose(2_000, 'message rate close')).toBe(1008);
});
