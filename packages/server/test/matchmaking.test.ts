/**
 * Matchmaking: server-driven find-or-create + auto-seat + auto-start, the
 * ranked/unranked rating distinction (ranked full room → rated; unranked stays
 * unrated even when all signed-in), the host "Start with bots" (fillBotsAndStart),
 * the /api/matchmaking waiting counts, ranked-needs-login, and the waiting-room
 * reaper. Matches run on illisoft with an injected winTarget:100 so a rated deal
 * finishes fast.
 */
import { randomUUID } from 'node:crypto';
import type { ServerMsg } from '@hp/protocol';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { hashToken } from '../src/auth.js';
import { createServer, type HpServer } from '../src/index.js';
import { attachDriver, TestClient } from './helpers.js';

type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;
type UpdateMsg = Extract<ServerMsg, { t: 'update' }>;

let server: HpServer;
let port: number;

beforeEach(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: { turnMs: 20_000, botDelayMs: [0, 1], nextDealDelayMs: 5, redealDelayMs: 5 },
    // Matchmade rooms are illisoft; end fast for the rated/unrated tests.
    matchmakingConfig: { winTarget: 100 },
  });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
});

function makeUser(name: string): { id: string; token: string } {
  const user = server.db.upsertUserByGoogleSub({
    id: randomUUID(),
    googleSub: `sub-${name}-${randomUUID()}`,
    email: `${name}@example.test`,
    name,
    picture: null,
  });
  const token = randomUUID();
  server.db.createAuthToken(hashToken(token), user.id, Date.now() + 600_000);
  return { id: user.id, token };
}

const matchEnd = (c: TestClient) =>
  c.next(
    (m) => m.t === 'update' && m.view.winnerSide !== null,
    60_000,
    'match end',
  ) as Promise<UpdateMsg>;

async function fetchMatchmaking(): Promise<
  Array<{ players: number; ranked: boolean; waiting: number }>
> {
  const res = await fetch(`http://127.0.0.1:${port}/api/matchmaking`);
  return (
    (await res.json()) as { buckets: Array<{ players: number; ranked: boolean; waiting: number }> }
  ).buckets;
}

test('two finders of the same bucket share one waiting room (no auto-start until full)', async () => {
  const a = await TestClient.connect(port);
  const wa = (await a.hello({
    matchmaking: { players: 4, ranked: false },
    nickname: 'A',
  })) as WelcomeMsg;
  expect(wa.t).toBe('welcome');
  expect(wa.room.matchmaking).toEqual({ ranked: false });
  expect(wa.seat).toBe(0);

  const b = await TestClient.connect(port);
  const wb = (await b.hello({
    matchmaking: { players: 4, ranked: false },
    nickname: 'B',
  })) as WelcomeMsg;
  expect(wb.room.code).toBe(wa.room.code); // same room
  expect(wb.seat).toBe(1);
  expect(wb.room.status).toBe('lobby'); // 2/4 — still waiting
  const humans = wb.room.seats.filter((s) => s.kind === 'human').length;
  expect(humans).toBe(2);

  a.close();
  b.close();
});

test('a full ranked bucket auto-starts and is rated (+20 / −20)', async () => {
  const ua = makeUser('RankA');
  const ub = makeUser('RankB');

  const a = await TestClient.connect(port);
  await a.hello({ matchmaking: { players: 2, ranked: true }, auth: ua.token });
  attachDriver(a, { openBid: true });

  const b = await TestClient.connect(port);
  const ended = matchEnd(a);
  await b.hello({ matchmaking: { players: 2, ranked: true }, auth: ub.token });
  attachDriver(b, { openBid: true }); // second join fills the room → auto-start

  const end = await ended;
  expect(end.ratings?.rated).toBe(true);
  const deltas = (end.ratings?.perSeat ?? []).map((p) => p.delta).sort((x, y) => x - y);
  expect(deltas).toEqual([-20, 20]);
  expect(server.db.getUserById(ua.id)?.gamesPlayed).toBe(1);
  expect(server.db.getUserById(ub.id)?.gamesPlayed).toBe(1);

  a.close();
  b.close();
});

test('an all-signed-in UNRANKED bucket auto-starts but is NOT rated', async () => {
  const ua = makeUser('CasA');
  const ub = makeUser('CasB');

  const a = await TestClient.connect(port);
  await a.hello({ matchmaking: { players: 2, ranked: false }, auth: ua.token });
  attachDriver(a, { openBid: true });

  const b = await TestClient.connect(port);
  const ended = matchEnd(a);
  await b.hello({ matchmaking: { players: 2, ranked: false }, auth: ub.token });
  attachDriver(b, { openBid: true });

  const end = await ended;
  expect(end.ratings?.rated).toBe(false); // the explicit unranked flag
  expect(server.db.getUserById(ua.id)?.gamesPlayed).toBe(0);
  expect(server.db.getUserById(ua.id)?.rating).toBe(1000);

  a.close();
  b.close();
});

test('host "Start with bots" fills empty seats and starts (unrated)', async () => {
  const ua = makeUser('BotHost');
  const a = await TestClient.connect(port);
  const w = (await a.hello({
    matchmaking: { players: 2, ranked: false },
    auth: ua.token,
  })) as WelcomeMsg;
  expect(w.seat).toBe(0); // first finder is host
  // Solo-vs-bots is player-paced between deals: drive "Jatka" to the finish.
  attachDriver(a, { openBid: true, advanceDeals: true });

  const ended = matchEnd(a);
  a.lobby({ type: 'fillBotsAndStart' });
  const end = await ended;

  expect(end.ratings?.rated).toBe(false); // a bot is present
  expect(server.db.getUserById(ua.id)?.gamesPlayed).toBe(0);
  a.close();
});

test('a guest requesting a ranked bucket gets error.rankedNeedsLogin', async () => {
  const a = await TestClient.connect(port);
  const reply = await a.hello({ matchmaking: { players: 2, ranked: true }, nickname: 'Guest' });
  expect(reply.t).toBe('error');
  expect(reply.t === 'error' && reply.code).toBe('error.rankedNeedsLogin');
  a.close();
});

test('/api/matchmaking reports per-bucket waiting counts', async () => {
  const a = await TestClient.connect(port);
  await a.hello({ matchmaking: { players: 4, ranked: false }, nickname: 'W1' });
  const buckets = await fetchMatchmaking();
  const b4u = buckets.find((x) => x.players === 4 && x.ranked === false);
  expect(b4u?.waiting).toBe(1);
  // Untouched buckets report zero.
  expect(buckets.find((x) => x.players === 2 && x.ranked === true)?.waiting).toBe(0);
  a.close();
});

test('the reaper closes an abandoned empty waiting room', async () => {
  const a = await TestClient.connect(port);
  const w = (await a.hello({
    matchmaking: { players: 4, ranked: false },
    nickname: 'Solo',
  })) as WelcomeMsg;
  const code = w.room.code;
  expect(server.rooms.has(code)).toBe(true);

  a.close();
  // Wait for onSocketClosed → closeRoom to run.
  await new Promise((r) => setTimeout(r, 300));
  expect(server.rooms.has(code)).toBe(false);
  expect((await fetchMatchmaking()).find((x) => x.players === 4 && !x.ranked)?.waiting).toBe(0);
});
