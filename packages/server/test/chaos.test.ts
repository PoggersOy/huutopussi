/**
 * Chaos: a bots-vs-bots match (host seat drops and goes botControlled) runs to
 * completion while a chaos loop disconnects/reconnects clients, spams resync
 * and sends duplicated actionIds. After every resync whose seq matches the
 * server's current seq, the returned view must deep-equal the server truth
 * (redactViewFor over the live room state).
 */
import { redactViewFor, type Seat } from '@hp/engine';
import type { ServerMsg } from '@hp/protocol';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import { sleep, TestClient } from './helpers.js';

let server: HpServer;
let port: number;

beforeAll(async () => {
  server = createServer({
    port: 0,
    dbPath: ':memory:',
    heartbeatMs: null,
    timers: {
      turnMs: 250,
      wholeAnswerMs: 150,
      graceMs: 120,
      nextDealDelayMs: 25,
      redealDelayMs: 10,
      idleCloseMs: 600_000,
      botDelayMs: [0, 2],
    },
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
});

async function expectRoomBroadcast(c: TestClient, what: string): Promise<void> {
  const p = c.next((m) => m.t === 'room', 10_000, what);
  await p;
}

test('chaos match completes with consistent views', async () => {
  // Host creates the room, shrinks the match, fills the table with bots.
  let host = await TestClient.connect(port);
  const hw = await host.hello({ nickname: 'boss' });
  expect(hw.t).toBe('welcome');
  const code = host.roomCode;
  const token = host.token;

  {
    const ack = expectRoomBroadcast(host, 'setConfig ack');
    host.lobby({ type: 'setConfig', patch: { winTarget: 100 } });
    await ack;
  }
  for (const seat of [1, 2, 3] as Seat[]) {
    const ack = host.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'bot',
      10_000,
      `bot at ${seat}`,
    );
    host.lobby({ type: 'addBot', seat });
    await ack;
  }
  {
    const started = host.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'start');
    host.lobby({ type: 'startMatch' });
    await started;
  }

  const room = server.rooms.get(code);
  if (!room) throw new Error('room missing from registry');
  expect(room.config.winTarget).toBe(100);

  // Host walks away: seat 0 becomes botControlled after the turn deadline.
  host.terminate();

  let comparisons = 0;
  let spectator: TestClient | null = null;
  const start = Date.now();
  let hostConnected = false;

  while (room.match !== null && room.match.winnerSide === null) {
    if (room.closed) throw new Error('room closed during chaos');
    if (Date.now() - start > 100_000) throw new Error('chaos match did not complete in time');

    // Solo-vs-bots is player-paced between deals: the server arms no auto-advance
    // timer (see isSoloVsBots), so the sole human must send `nextDeal` ("Jatka")
    // or a match that needs more than one deal to reach winTarget never finishes.
    // Drive it here, reconnecting the host if it dropped so it can issue it.
    if (room.match.deal?.phase.name === 'scored') {
      if (!hostConnected) {
        host = await TestClient.connect(port);
        const w = await host.hello({ sessionToken: token, roomCode: code });
        expect(w.t).toBe('welcome');
        hostConnected = true;
      }
      host.lobby({ type: 'nextDeal' });
      await sleep(5);
      continue;
    }

    const dice = Math.random();

    if (spectator === null) {
      spectator = await TestClient.connect(port);
      const w = await spectator.hello({ roomCode: code });
      expect(w.t).toBe('welcome');
    } else if (dice < 0.15) {
      spectator.terminate();
      spectator = null;
    } else if (dice < 0.3 && !hostConnected) {
      // Host reconnects with its old session token (seat reclaim path).
      host = await TestClient.connect(port);
      const w = await host.hello({ sessionToken: token, roomCode: code });
      expect(w.t).toBe('welcome');
      expect((w as { seat: Seat | null }).seat).toBe(0);
      hostConnected = true;
    } else if (dice < 0.4 && hostConnected) {
      host.terminate();
      hostConnected = false;
    } else if (dice < 0.5) {
      // Duplicated (rejected) action: both responses must be identical.
      const id = host.token && hostConnected ? await duplicatedAction(host) : null;
      if (id === null && spectator) spectator.sendRaw('garbage {{{');
    } else {
      // Resync spam + consistency check against server truth.
      const reply = spectator.next(
        (m) => m.t === 'update' && m.event === null,
        10_000,
        'resync reply',
      );
      spectator.resync();
      const msg = (await reply) as Extract<ServerMsg, { t: 'update' }>;
      if (room.match && msg.seq === room.seq) {
        const truth = JSON.parse(JSON.stringify(redactViewFor(room.match, 'spectator')));
        expect(msg.view).toEqual(truth);
        comparisons += 1;
      }
    }
    await sleep(5);
  }

  expect(room.match?.winnerSide).not.toBeNull();
  expect(room.status).toBe('finished');
  expect(comparisons).toBeGreaterThan(0);

  // Quiescent full-consistency pass: every viewer's resync equals server truth.
  const finalHost = await TestClient.connect(port);
  const fw = await finalHost.hello({ sessionToken: token, roomCode: code });
  expect(fw.t).toBe('welcome');
  const finalSpec = await TestClient.connect(port);
  await finalSpec.hello({ roomCode: code });

  for (const [client, viewer] of [
    [finalHost, 0],
    [finalSpec, 'spectator'],
  ] as Array<[TestClient, Seat | 'spectator']>) {
    const reply = client.next((m) => m.t === 'update' && m.event === null, 10_000, 'final resync');
    client.resync();
    const msg = (await reply) as Extract<ServerMsg, { t: 'update' }>;
    const state = room.match;
    if (!state) throw new Error('match state lost');
    expect(msg.view).toEqual(JSON.parse(JSON.stringify(redactViewFor(state, viewer))));
    expect(msg.seq).toBe(room.seq);
  }

  // Idempotency at quiescence: duplicated actionIds replay identical bytes.
  const dupId = finalHost.action({ type: 'pass' });
  const r1 = await finalHost.next(
    (m) => m.t === 'error' && m.refActionId === dupId,
    5_000,
    'dup first',
  );
  const r2p = finalHost.next(
    (m) => m.t === 'error' && m.refActionId === dupId,
    5_000,
    'dup replay',
  );
  finalHost.action({ type: 'pass' }, dupId);
  expect(await r2p).toEqual(r1);

  // The match summary reached the history feed.
  const summaries = server.db.matchSummaries(room.id);
  expect(summaries.length).toBe(1);
  expect(summaries[0]?.winnerSide).toBe(room.match?.winnerSide);

  finalHost.close();
  finalSpec.close();
  spectator?.close();
}, 150_000);

/** Sends the same (illegal) action twice and asserts byte-identical replies. */
async function duplicatedAction(client: TestClient): Promise<string> {
  const id = client.action({ type: 'bid', amount: 5 });
  const first = await client.next(
    (m) => m.t === 'error' && m.refActionId === id,
    10_000,
    'dup action first reply',
  );
  const replay = client.next(
    (m) => m.t === 'error' && m.refActionId === id,
    10_000,
    'dup action replay',
  );
  client.action({ type: 'bid', amount: 5 }, id);
  expect(await replay).toEqual(first);
  return id;
}
