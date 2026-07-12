/**
 * Integration: 4 scripted WS clients over a real server on an ephemeral port
 * drive a room from creation through seating and a full deal to dealScored,
 * using only server-sent hints for legality.
 */
import type { Seat } from '@hp/engine';
import { DEFAULT_RULES } from '@hp/engine';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import {
  attachDriver,
  fullConfigPatch,
  seatFourHumans,
  TestClient,
  waitForDealScored,
} from './helpers.js';

let server: HpServer;
let port: number;

beforeAll(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: {
      turnMs: 20_000,
      botDelayMs: [0, 1],
      nextDealDelayMs: 60_000,
    },
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('healthz responds', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('GET /api/rooms reports live rooms and omits unknown/invalid codes', async () => {
  // A live room in the lobby: creating it auto-seats the host at seat 0, so it
  // has one occupant of four.
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'Ann', config: fullConfigPatch(DEFAULT_RULES) });
  const code = host.roomCode;

  // Probe the live code, an unknown-but-valid code, and a malformed one.
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms?codes=${code},ZZZZZ,not-a-code`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body = (await res.json()) as {
    rooms: Array<{ code: string; status: string; seatsFilled: number; seatsTotal: number }>;
  };
  // Only the real room comes back; unknown/invalid codes are silently dropped.
  expect(body.rooms).toEqual([{ code, status: 'lobby', seatsFilled: 1, seatsTotal: 4 }]);

  // Lowercase input is normalized to the canonical upper-case code.
  const lower = await fetch(`http://127.0.0.1:${port}/api/rooms?codes=${code.toLowerCase()}`);
  const lowerBody = (await lower.json()) as { rooms: Array<{ code: string }> };
  expect(lowerBody.rooms.map((r) => r.code)).toEqual([code]);

  // No codes → empty list, still a well-formed 200.
  const none = await fetch(`http://127.0.0.1:${port}/api/rooms`);
  expect((await none.json()) as unknown).toEqual({ rooms: [] });

  host.close();
});

test('a malformed percent-encoded path is a 400, not a process crash', async () => {
  // decodeURIComponent throws URIError on a lone/incomplete escape; uncaught in
  // the request listener it would terminate the whole server.
  for (const bad of ['/%', '/%zz', '/%2', '/foo%']) {
    const res = await fetch(`http://127.0.0.1:${port}${bad}`);
    expect(res.status).toBe(400);
  }
  // The server is still alive and serving after the malformed requests.
  const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(ok.status).toBe(200);
});

test('bad messages get error.badMessage without crashing', async () => {
  const c = await TestClient.connect(port);
  const err1 = c.next((m) => m.t === 'error', 5_000, 'bad message error');
  c.sendRaw('this is not json');
  expect(((await err1) as { code: string }).code).toBe('error.badMessage');
  const err2 = c.next((m) => m.t === 'error', 5_000, 'schema error');
  c.sendRaw(JSON.stringify({ t: 'nonsense', foo: 1 }));
  expect(((await err2) as { code: string }).code).toBe('error.badMessage');
  // Messages before hello are rejected but the socket survives.
  const err3 = c.next((m) => m.t === 'error', 5_000, 'hello-first error');
  c.send({ t: 'resync' });
  expect(((await err3) as { code: string }).code).toBe('error.helloFirst');
  c.close();
});

test('wrong protocol version is refused', async () => {
  const c = await TestClient.connect(port);
  const err = await c.hello({ v: 999 });
  expect(err.t).toBe('error');
  expect((err as { code: string }).code).toBe('error.protocolVersion');
  c.close();
});

test('four scripted clients complete a full deal over WS', async () => {
  const clients = await seatFourHumans(port);
  const host = clients[0] as TestClient;

  // Hint hygiene: hints must only ever arrive with our own turn.
  const hintViolations: string[] = [];
  for (const c of clients) {
    c.onServerMsg((m) => {
      if ((m.t === 'update' || m.t === 'welcome') && m.turn && m.turn.hints !== null) {
        if (c.seat === null || m.turn.seat !== c.seat) {
          hintViolations.push(`hints for seat ${m.turn.seat} sent to seat ${String(c.seat)}`);
        }
      }
    });
    attachDriver(c);
  }

  // Non-host cannot start the match.
  const guest = clients[1] as TestClient;
  const denyId = guest.lobby({ type: 'startMatch' });
  const denied = await guest.next(
    (m) => m.t === 'error' && m.refActionId === denyId,
    10_000,
    'startMatch denied',
  );
  expect((denied as { code: string }).code).toBe('error.notHost');

  const started = clients.map((c) =>
    c.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'deal started'),
  );
  host.lobby({ type: 'startMatch' });
  await Promise.all(started);

  const scored = await Promise.all(clients.map((c) => waitForDealScored(c)));

  // All four saw the same scored snapshot.
  const first = scored[0];
  expect(first).toBeDefined();
  for (const msg of scored) {
    expect(msg.view.scores).toEqual(first?.view.scores);
    expect(msg.view.deal?.tricksPlayed).toBe(9);
  }
  // Scores moved exactly by the reported deltas (from 0).
  const phase = first?.view.deal?.phase;
  if (!phase || phase.name !== 'scored') throw new Error('expected scored phase');
  expect(first?.view.scores[0]).toBe(phase.result.sides[0]?.scoreDelta);
  expect(first?.view.scores[1]).toBe(phase.result.sides[1]?.scoreDelta);

  expect(hintViolations).toEqual([]);

  // Server truth agrees.
  const room = server.rooms.get(host.roomCode);
  expect(room?.match?.deal?.phase.name).toBe('scored');

  // The deal summary was persisted in the action transaction.
  const dealRows = server.db.raw
    .prepare('SELECT COUNT(*) AS n FROM deals WHERE match_id = ?')
    .get(room?.matchId) as { n: number };
  expect(dealRows.n).toBe(1);

  for (const c of clients) c.close();
});

test('idempotency: a duplicated actionId replays the original response', async () => {
  const c = await TestClient.connect(port);
  await c.hello({ nickname: 'dup' });
  // An action outside any match fails; the duplicate must replay the SAME error.
  const actionId = c.action({ type: 'pass' });
  const firstReply = await c.next(
    (m) => m.t === 'error' && m.refActionId === actionId,
    5_000,
    'first response',
  );
  const replay = c.next(
    (m) => m.t === 'error' && m.refActionId === actionId,
    5_000,
    'replayed response',
  );
  c.action({ type: 'pass' }, actionId);
  expect(await replay).toEqual(firstReply);

  // Same for lobby commands: duplicated takeSeat does not re-apply.
  const seat: Seat = 2;
  const lobbyId = c.lobby({ type: 'takeSeat', seat });
  const roomMsg = await c.next((m) => m.t === 'room', 5_000, 'takeSeat response');
  const replayed = c.next((m) => m.t === 'room', 5_000, 'takeSeat replay');
  c.lobby({ type: 'takeSeat', seat }, lobbyId);
  expect(await replayed).toEqual(roomMsg);
  c.close();
});
