/**
 * In-table reactions over the wire. An emote is ephemeral table flair, not game
 * state: the server attributes it to the sender's SEAT, rate-limits it, echoes
 * it to everyone in the room (sender included), and never touches the seq
 * stream. Spectators (no seat) can't react. Works in the lobby too — no match
 * needs to be running.
 */
import type { ServerMsg } from '@hp/protocol';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import { sleep, TestClient } from './helpers.js';

let server: HpServer;
let port: number;

beforeAll(async () => {
  server = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null });
  port = await server.listen();
});
afterAll(async () => {
  await server.close();
});

type EmoteMsg = Extract<ServerMsg, { t: 'emote' }>;

/** Host (seat 0) + a guest auto-seated at seat 1, both in the same room. */
async function seatTwo(): Promise<[TestClient, TestClient]> {
  const host = await TestClient.connect(port);
  const hw = await host.hello({ nickname: 'host' });
  if (hw.t !== 'welcome') throw new Error('host hello failed');
  const guest = await TestClient.connect(port);
  const gw = await guest.hello({ roomCode: host.roomCode, nickname: 'guest' });
  if (gw.t !== 'welcome') throw new Error('guest hello failed');
  return [host, guest];
}

test('a seated reaction is broadcast to everyone (sender included) with the sender seat', async () => {
  const [host, guest] = await seatTwo();

  const hostSaw = host.next((m) => m.t === 'emote', 3_000, 'own emote echo') as Promise<EmoteMsg>;
  const guestSaw = guest.next((m) => m.t === 'emote', 3_000, 'peer emote') as Promise<EmoteMsg>;
  host.send({ t: 'emote', emote: 'nice' });

  const [mine, theirs] = await Promise.all([hostSaw, guestSaw]);
  expect(mine).toEqual({ t: 'emote', seat: 0, emote: 'nice' });
  expect(theirs).toEqual({ t: 'emote', seat: 0, emote: 'nice' });

  host.close();
  guest.close();
});

test('reactions are rate-limited: a burst yields one, then another after the cooldown', async () => {
  const [host, guest] = await seatTwo();
  const seen: EmoteMsg[] = [];
  guest.onServerMsg((m) => {
    if (m.t === 'emote') seen.push(m);
  });

  // Two back-to-back: the second is inside the cooldown and dropped.
  host.send({ t: 'emote', emote: 'fire' });
  host.send({ t: 'emote', emote: 'laugh' });
  await sleep(150);
  expect(seen.map((e) => e.emote)).toEqual(['fire']);

  // After the cooldown (server EMOTE_COOLDOWN_MS = 1500), a fresh one lands.
  await sleep(1_600);
  host.send({ t: 'emote', emote: 'gg' });
  await sleep(150);
  expect(seen.map((e) => e.emote)).toEqual(['fire', 'gg']);

  host.close();
  guest.close();
});

test('a spectator (no seat) cannot react', async () => {
  const [host, guest] = await seatTwo();

  // Guest stands up → seat null (spectator). leaveSeat re-welcomes the actor.
  const stoodUp = guest.next(
    (m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome',
    3_000,
    'welcome after leaveSeat',
  );
  guest.lobby({ type: 'leaveSeat' });
  expect(((await stoodUp) as Extract<ServerMsg, { t: 'welcome' }>).seat).toBeNull();

  const hostSaw: EmoteMsg[] = [];
  host.onServerMsg((m) => {
    if (m.t === 'emote') hostSaw.push(m);
  });
  guest.send({ t: 'emote', emote: 'thanks' });
  await sleep(200);
  expect(hostSaw).toEqual([]);

  host.close();
  guest.close();
});
