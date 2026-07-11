/**
 * Host "Stop game" (lobby cmd `stopMatch`): only the host may abort an ongoing
 * match, which closes the room and drops every client (WS close 4000).
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import { seatHumans, type TestClient } from './helpers.js';

let server: HpServer;
let port: number;

beforeAll(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: { turnMs: 20_000, botDelayMs: [0, 1], nextDealDelayMs: 60_000, redealDelayMs: 10 },
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
});

async function startedThreeHanded(): Promise<[TestClient, TestClient, TestClient]> {
  const clients = await seatHumans(port, 3, { players: 3 });
  const [host, g1, g2] = clients;
  if (!host || !g1 || !g2) throw new Error('expected 3 seated clients');
  const started = host.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'start');
  host.lobby({ type: 'startMatch' });
  await started;
  return [host, g1, g2];
}

test('a non-host cannot stop the match', async () => {
  const [, guest] = await startedThreeHanded();
  const id = guest.lobby({ type: 'stopMatch' });
  const reply = await guest.next(
    (m) => m.t === 'error' && m.refActionId === id,
    10_000,
    'notHost error',
  );
  expect(reply.t === 'error' && reply.code).toBe('error.notHost');
  guest.close();
});

test('the host stops the match and every client is dropped (room closed)', async () => {
  const [host, g1, g2] = await startedThreeHanded();
  const g1Closed = g1.waitClose(10_000);
  const g2Closed = g2.waitClose(10_000);
  host.lobby({ type: 'stopMatch' });
  // 4000 = room closed (see socket.ts TERMINAL_CLOSE); clients land on the
  // "room closed" dead-end and can navigate Home.
  expect(await g1Closed).toBe(4000);
  expect(await g2Closed).toBe(4000);
});
