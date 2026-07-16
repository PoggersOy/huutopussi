/**
 * Lobby seating over the wire. A seated player's OWN seat rides only on the
 * `welcome` message (the broadcast `room` message carries no viewer identity),
 * so taking or leaving a seat must re-welcome the actor — otherwise a joined
 * guest's client stays `seat: null` and never sees its turn/hints (it can't
 * bid or play until it happens to reconnect).
 */
import type { ServerMsg } from '@hp/protocol';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import { TestClient } from './helpers.js';

let server: HpServer;
let port: number;

beforeAll(async () => {
  server = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null });
  port = await server.listen();
});
afterAll(async () => {
  await server.close();
});

test('takeSeat / leaveSeat re-welcome the actor so their client learns its seat', async () => {
  const host = await TestClient.connect(port);
  const hw = await host.hello({ nickname: 'host' });
  if (hw.t !== 'welcome') throw new Error('host hello failed');
  const code = host.roomCode;

  const guest = await TestClient.connect(port);
  const gw = await guest.hello({ roomCode: code, nickname: 'guest' });
  if (gw.t !== 'welcome') throw new Error('guest hello failed');
  expect(gw.seat).toBe(1); // auto-seated at the first free seat (host holds 0)

  // Re-taking the seat they already hold is an idempotent re-welcome.
  const seated = guest.next(
    (m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome',
    5_000,
    'welcome after takeSeat',
  );
  guest.lobby({ type: 'takeSeat', seat: 1 });
  expect(((await seated) as Extract<ServerMsg, { t: 'welcome' }>).seat).toBe(1);

  const stoodUp = guest.next(
    (m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome',
    5_000,
    'welcome after leaveSeat',
  );
  guest.lobby({ type: 'leaveSeat' });
  expect(((await stoodUp) as Extract<ServerMsg, { t: 'welcome' }>).seat).toBeNull();

  host.close();
  guest.close();
});

test('a disconnected host temporarily yields lobby powers to a connected player', async () => {
  const host = await TestClient.connect(port);
  await host.hello({ nickname: 'host' });
  const guest = await TestClient.connect(port);
  await guest.hello({ roomCode: host.roomCode, nickname: 'guest' });

  const transferred = guest.next(
    (m) => m.t === 'room' && m.room.hostSeat === 1 && m.room.seats[0]?.connected === false,
    5_000,
    'host transfer',
  );
  host.close();
  await transferred;

  // The temporary host can keep the lobby operable instead of waiting forever
  // for the creator's browser to return.
  const botAdded = guest.next(
    (m) => m.t === 'room' && m.room.seats[2]?.kind === 'bot',
    5_000,
    'temporary host command',
  );
  guest.lobby({ type: 'addBot', seat: 2 });
  await botAdded;
  guest.close();
});
