/**
 * Google-login + Elo wiring over HTTP and WS: the /auth and /api/profile
 * endpoints, hello binding a signed-in account (rating in the lobby, nickname
 * defaulted from the Google name), and the match-end rating path — a 2p match
 * between two distinct signed-in humans is RATED (winner +20 / loser −20 from
 * 1000 at K40), while a match containing a bot is UNRATED (no change).
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
  });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
});

/** Insert a signed-in account + a valid app token; returns its raw token + id. */
function makeUser(name: string): { id: string; token: string } {
  const user = server.db.upsertUserByGoogleSub({
    id: randomUUID(),
    googleSub: `sub-${name}-${randomUUID()}`,
    name,
    picture: null,
  });
  const token = randomUUID(); // any opaque string works; the server hashes it
  server.db.createAuthToken(hashToken(token), user.id, Date.now() + 600_000);
  return { id: user.id, token };
}

const RATED_2P = { players: 2, winTarget: 100 } as const;

test('auth-config reports no client id in guest mode', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth-config`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ googleClientId: null });
});

test('google sign-in is disabled (503) without a configured client id', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'anything' }),
  });
  expect(res.status).toBe(503);
});

test('/auth/me + /api/profile resolve a bearer token; logout revokes it', async () => {
  const u = makeUser('Alice');

  const me = await fetch(`http://127.0.0.1:${port}/auth/me`, {
    headers: { authorization: `Bearer ${u.token}` },
  });
  expect(me.status).toBe(200);
  const meBody = (await me.json()) as {
    user: { name: string; rating: number; provisional: boolean };
  };
  expect(meBody.user.name).toBe('Alice');
  expect(meBody.user.rating).toBe(1000);
  expect(meBody.user.provisional).toBe(true);

  expect((await fetch(`http://127.0.0.1:${port}/auth/me`)).status).toBe(401);

  const profile = await fetch(`http://127.0.0.1:${port}/api/profile`, {
    headers: { authorization: `Bearer ${u.token}` },
  });
  expect(profile.status).toBe(200);
  const pBody = (await profile.json()) as { ratingEvents: unknown[] };
  expect(pBody.ratingEvents).toEqual([]);

  const logout = await fetch(`http://127.0.0.1:${port}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}` },
  });
  expect(logout.status).toBe(204);

  // Token is revoked: it no longer resolves.
  const after = await fetch(`http://127.0.0.1:${port}/auth/me`, {
    headers: { authorization: `Bearer ${u.token}` },
  });
  expect(after.status).toBe(401);
});

test('a signed-in hello shows the account rating in the lobby and defaults the nickname', async () => {
  const u = makeUser('Bob');
  const client = await TestClient.connect(port);
  const welcome = (await client.hello({ auth: u.token })) as WelcomeMsg;
  expect(welcome.t).toBe('welcome');
  const seat0 = welcome.room.seats[0];
  expect(seat0?.nickname).toBe('Bob'); // defaulted from the Google name
  expect(seat0?.rating).toBe(1000);
  expect(seat0?.provisional).toBe(true);
  client.close();
});

test('account deletion immediately downgrades live room sessions to guests', async () => {
  const u = makeUser('Erase Me');
  const client = await TestClient.connect(port);
  const welcome = (await client.hello({ auth: u.token })) as WelcomeMsg;
  expect(welcome.t).toBe('welcome');
  const room = server.rooms.get(client.roomCode);
  const liveSession = room?.sessions.get(client.token);
  expect(liveSession?.userId).toBe(u.id);
  expect(liveSession?.rating).toBe(1000);

  const downgraded = client.next(
    (m) => m.t === 'room' && m.room.seats[0]?.rating === null,
    5_000,
    'live session downgraded',
  );
  const deleted = await fetch(`http://127.0.0.1:${port}/auth/account`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${u.token}` },
  });
  expect(deleted.status).toBe(204);
  await downgraded;

  expect(server.db.getUserById(u.id)).toBeNull();
  expect(liveSession?.userId).toBeNull();
  expect(liveSession?.rating).toBeNull();
  expect(liveSession?.provisional).toBe(false);
  const stored = server.db.raw
    .prepare('SELECT user_id FROM sessions WHERE token = ?')
    .get(client.token) as { user_id: string | null };
  expect(stored.user_id).toBeNull();
  client.close();
});

test('2p match between two signed-in humans is rated: +20 / −20 from 1000', async () => {
  const a = makeUser('A');
  const b = makeUser('B');

  const host = await TestClient.connect(port);
  const w = (await host.hello({ auth: a.token, config: RATED_2P })) as WelcomeMsg;
  expect(w.t).toBe('welcome');
  host.seat = 0;

  const guest = await TestClient.connect(port);
  await guest.hello({ roomCode: host.roomCode, auth: b.token });
  const seated = guest.next(
    (m) => m.t === 'room' && m.room.seats[1]?.kind === 'human',
    10_000,
    'seat 1 taken',
  );
  guest.lobby({ type: 'takeSeat', seat: 1 });
  await seated;
  guest.seat = 1;

  attachDriver(host, { openBid: true });
  attachDriver(guest, { openBid: true });

  const ended = host.next(
    (m) => m.t === 'update' && m.view.winnerSide !== null,
    60_000,
    'match end',
  ) as Promise<UpdateMsg>;
  host.lobby({ type: 'startMatch' });
  const end = await ended;

  expect(end.ratings?.rated).toBe(true);
  expect(end.ratings?.perSeat).toHaveLength(2);

  const winnerSeat = end.view.winnerSide; // 2p: side === seat
  const perSeat = end.ratings?.perSeat ?? [];
  const winner = perSeat.find((p) => p.seat === winnerSeat);
  const loser = perSeat.find((p) => p.seat !== winnerSeat);
  expect(winner?.delta).toBe(20);
  expect(winner?.after).toBe(1020);
  expect(loser?.delta).toBe(-20);
  expect(loser?.after).toBe(980);

  // Persisted: one rated game each, streak advanced for the winner only.
  const uA = server.db.getUserById(a.id);
  const uB = server.db.getUserById(b.id);
  expect(uA?.gamesPlayed).toBe(1);
  expect(uB?.gamesPlayed).toBe(1);
  const winnerId = winner?.userId;
  const winnerRow = winnerId === a.id ? uA : uB;
  const loserRow = winnerId === a.id ? uB : uA;
  expect(winnerRow?.rating).toBe(1020);
  expect(winnerRow?.winStreak).toBe(1);
  expect(loserRow?.rating).toBe(980);
  expect(loserRow?.winStreak).toBe(0);

  host.close();
  guest.close();
});

test('a match containing a bot is unrated: no rating change', async () => {
  const a = makeUser('Solo');

  const host = await TestClient.connect(port);
  const w = (await host.hello({ auth: a.token, config: RATED_2P })) as WelcomeMsg;
  expect(w.t).toBe('welcome');
  host.seat = 0;

  const botSeated = host.next(
    (m) => m.t === 'room' && m.room.seats[1]?.kind === 'bot',
    10_000,
    'bot seated',
  );
  host.lobby({ type: 'addBot', seat: 1 });
  await botSeated;

  // Solo-vs-bots is player-paced between deals: drive "Jatka" to the finish.
  attachDriver(host, { openBid: true, advanceDeals: true });
  const ended = host.next(
    (m) => m.t === 'update' && m.view.winnerSide !== null,
    60_000,
    'match end',
  ) as Promise<UpdateMsg>;
  host.lobby({ type: 'startMatch' });
  const end = await ended;

  expect(end.ratings?.rated).toBe(false);
  expect(end.ratings?.perSeat).toEqual([]);

  const uA = server.db.getUserById(a.id);
  expect(uA?.gamesPlayed).toBe(0);
  expect(uA?.rating).toBe(1000);

  host.close();
});
