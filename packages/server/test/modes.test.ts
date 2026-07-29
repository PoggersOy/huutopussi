/**
 * illisoft game modes over the wire: rooms default to ILLISOFT_RULES, full/
 * partial config patches with cross-field validation, active-seat bookkeeping
 * for 2/3-player modes (the 2p dummy hand is NOT a seat), and full 3p/2p koini
 * deals driven over WS by bots + a scripted human.
 */
import type { Seat, Side } from '@hp/engine';
import { DEFAULT_RULES, ILLISOFT_RULES } from '@hp/engine';
import type { ServerMsg } from '@hp/protocol';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer, type HpServer } from '../src/index.js';
import { attachDriver, fullConfigPatch, TestClient, waitForDealScored } from './helpers.js';

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type ErrorMsg = Extract<ServerMsg, { t: 'error' }>;

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
      redealDelayMs: 10,
    },
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
});

async function expectLobbyError(client: TestClient, cmd: Parameters<TestClient['lobby']>[0]) {
  const id = client.lobby(cmd);
  const reply = (await client.next(
    (m) => m.t === 'error' && m.refActionId === id,
    10_000,
    `error for ${cmd.type}`,
  )) as ErrorMsg;
  return reply;
}

async function setConfigOk(
  client: TestClient,
  patch: Extract<Parameters<TestClient['lobby']>[0], { type: 'setConfig' }>['patch'],
): Promise<RoomMsg> {
  const id = client.lobby({ type: 'setConfig', patch });
  const reply = await client.next(
    (m) => m.t === 'room' || (m.t === 'error' && m.refActionId === id),
    10_000,
    'setConfig reply',
  );
  if (reply.t !== 'room') throw new Error(`setConfig rejected: ${JSON.stringify(reply)}`);
  return reply as RoomMsg;
}

test('rooms default to the Oletus (ILLISOFT) config; a full patch replaces it', async () => {
  const c = await TestClient.connect(port);
  const w = await c.hello({ nickname: 'illi' });
  if (w.t !== 'welcome') throw new Error('hello failed');
  expect(w.room.config).toEqual(ILLISOFT_RULES);
  expect(w.room.seats.length).toBe(4);

  // A complete config patch replaces the whole ruleset.
  const swapped = await setConfigOk(c, fullConfigPatch(DEFAULT_RULES));
  expect(swapped.room.config).toEqual(DEFAULT_RULES);

  // A partial patch overrides individual fields on top of the current config.
  const raised = await setConfigOk(c, { winTarget: 300 });
  expect(raised.room.config).toEqual({ ...DEFAULT_RULES, winTarget: 300 });

  // Every engine variation that used to be missing from the wire is applied.
  const varied = await setConfigOk(c, {
    bidStep: 10,
    firstBidder: 'dealer',
    askHalfMustHoldCard: false,
  });
  expect(varied.room.config).toEqual({
    ...DEFAULT_RULES,
    winTarget: 300,
    bidStep: 10,
    firstBidder: 'dealer',
    askHalfMustHoldCard: false,
  });
  c.close();
});

test('cross-field config validation and active-seat bounds', async () => {
  const c = await TestClient.connect(port);
  const w = await c.hello({ nickname: 'cfg' });
  if (w.t !== 'welcome') throw new Error('hello failed');

  // Koinipakka options are 2-3p only.
  let err = await expectLobbyError(c, { type: 'setConfig', patch: { talonSize: 6 } });
  expect(err.code).toBe('error.badConfig');
  err = await expectLobbyError(c, { type: 'setConfig', patch: { openTalon: false } });
  expect(err.code).toBe('error.badConfig');
  // The partner exchange is 4p only.
  err = await expectLobbyError(c, {
    type: 'setConfig',
    patch: { players: 3, exchangeCount: 3 },
  });
  expect(err.code).toBe('error.badConfig');
  // Bid bounds must stay ordered.
  err = await expectLobbyError(c, { type: 'setConfig', patch: { minBid: 200, maxBid: 100 } });
  expect(err.code).toBe('error.badConfig');
  // Bid bounds must also remain reachable with a custom increment.
  err = await expectLobbyError(c, { type: 'setConfig', patch: { bidStep: 7 } });
  expect(err.code).toBe('error.badConfig');

  // A rejected patch leaves the room config untouched.
  const room = server.rooms.get(c.roomCode);
  expect(room?.config).toEqual(ILLISOFT_RULES);

  // Valid 3p mode: koinipakka options apply, seats shrink to 3.
  const ok = await setConfigOk(c, { players: 3, talonSize: 6, openTalon: false });
  expect(ok.room.config.players).toBe(3);
  expect(ok.room.config.talonSize).toBe(6);
  expect(ok.room.seats.length).toBe(3);

  // Seats >= players do not exist in this mode.
  err = await expectLobbyError(c, { type: 'addBot', seat: 3 });
  expect(err.code).toBe('error.badSeat');
  const guest = await TestClient.connect(port);
  const gw = await guest.hello({ roomCode: c.roomCode, nickname: 'late' });
  expect(gw.t).toBe('welcome');
  err = await expectLobbyError(guest, { type: 'takeSeat', seat: 3 });
  expect(err.code).toBe('error.badSeat');

  guest.close();
  c.close();
});

test('shrinking the mode evicts occupants of now-inactive seats', async () => {
  const c = await TestClient.connect(port);
  const w = await c.hello({ nickname: 'shrink' });
  if (w.t !== 'welcome') throw new Error('hello failed');
  for (const seat of [1, 2, 3] as Seat[]) {
    const ack = c.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'bot',
      10_000,
      `bot at ${seat}`,
    );
    c.lobby({ type: 'addBot', seat });
    await ack;
  }

  const shrunk = await setConfigOk(c, { players: 2 });
  expect(shrunk.room.seats.length).toBe(2);
  expect(shrunk.room.seats[0]?.kind).toBe('human');
  expect(shrunk.room.seats[1]?.kind).toBe('bot');

  // The bots at seats 2..3 are gone from the room entirely.
  const room = server.rooms.get(c.roomCode);
  if (!room) throw new Error('room missing');
  const seated = [...room.sessions.values()].filter((s) => s.seat !== null).map((s) => s.seat);
  expect(seated.sort()).toEqual([0, 1]);
  c.close();
});

test('full 3p talon deal over WS with bots (avoin koini)', async () => {
  const human = await TestClient.connect(port);
  const w = await human.hello({ nickname: 'solo3p', config: { players: 3 } });
  if (w.t !== 'welcome') throw new Error('hello failed');
  expect(w.room.config).toEqual({ ...ILLISOFT_RULES, players: 3 });
  expect(w.room.seats.length).toBe(3);

  // Not enough seats filled yet: startMatch must refuse.
  const early = await expectLobbyError(human, { type: 'startMatch' });
  expect(early.code).toBe('error.seatsNotFilled');

  for (const seat of [1, 2] as Seat[]) {
    const ack = human.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'bot',
      10_000,
      `bot at ${seat}`,
    );
    human.lobby({ type: 'addBot', seat });
    await ack;
  }

  // Trackers over the human's message stream.
  let sawTalonCount3 = false;
  let sawTalonTaken = false;
  let sawOpenTalonFaces = false;
  let sawDiscarded3 = false;
  const badTurnSeats: number[] = [];
  const hintViolations: string[] = [];
  human.onServerMsg((m) => {
    if (m.t !== 'update' && m.t !== 'welcome') return;
    if (m.turn) {
      if (m.turn.seat >= 3) badTurnSeats.push(m.turn.seat);
      if (m.turn.hints !== null && m.turn.seat !== human.seat) {
        hintViolations.push(`hints for seat ${m.turn.seat}`);
      }
    }
    const deal = m.view?.deal;
    if (!deal) return;
    if (deal.talonCount === 3) sawTalonCount3 = true;
    if (deal.talonCount === 0 && deal.declarer !== null) sawTalonTaken = true;
    if (deal.talonSeen !== null && deal.tricksPlayed === 0) {
      expect(deal.talonSeen.length).toBe(3);
      sawOpenTalonFaces = true;
    }
    if (deal.discardedCount === 3) sawDiscarded3 = true;
    expect(deal.handCounts[3]).toBe(0); // seat 3 does not play in 3p
  });
  attachDriver(human, { openBid: true });

  const started = human.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'start');
  human.lobby({ type: 'startMatch' });
  await started;

  const scored = await waitForDealScored(human, 90_000);
  const deal = scored.view.deal;
  if (!deal || deal.phase.name !== 'scored') throw new Error('expected scored deal');

  // A 3-card talon means 11-card hands and 11 tricks; 3 sides score.
  expect(deal.tricksPlayed).toBe(11);
  expect(scored.view.scores.length).toBe(3);
  const result = deal.phase.result;
  expect(result.sides.length).toBe(3);
  // Someone always bids (the scripted human opens), so the deal has a declarer.
  expect(result.declarer).not.toBeNull();
  expect(result.bid).not.toBeNull();
  expect(result.contract).not.toBeNull();
  for (const side of [0, 1, 2] as Side[]) {
    expect(scored.view.scores[side]).toBe(result.sides[side]?.scoreDelta);
  }

  expect(sawTalonCount3).toBe(true); // koinipakka visible as a count pre-take
  expect(sawTalonTaken).toBe(true); // ...and empty once the declarer took it
  expect(sawOpenTalonFaces).toBe(true); // avoin koini: faces public in trick 1
  expect(sawDiscarded3).toBe(true); // discard count (not faces) is public
  expect(badTurnSeats).toEqual([]);
  expect(hintViolations).toEqual([]);

  // Persistence: the deal row stores the variable-length result as JSON.
  const room = server.rooms.get(human.roomCode);
  const row = server.db.raw
    .prepare('SELECT declarer, contract, bid, made, result FROM deals WHERE match_id = ?')
    .get(room?.matchId) as
    | { declarer: number; contract: number; bid: number; made: number; result: string }
    | undefined;
  if (!row) throw new Error('deal row missing');
  expect(row.declarer).toBe(result.declarer);
  expect(row.contract).toBe(result.contract);
  expect(row.bid).toBe(result.bid);
  const storedResult = JSON.parse(row.result) as typeof result;
  expect(storedResult.sides.length).toBe(3);
  expect(storedResult).toEqual(JSON.parse(JSON.stringify(result)));

  human.close();
});

test('full 2p deal with a bot: the dummy hand is dealt but is not a seat', async () => {
  const human = await TestClient.connect(port);
  const w = await human.hello({ nickname: 'solo2p' });
  if (w.t !== 'welcome') throw new Error('hello failed');
  // 2p via the lobby patch path (the 3p test used the hello config path).
  const shrunk = await setConfigOk(human, { players: 2 });
  expect(shrunk.room.seats.length).toBe(2);

  {
    const ack = human.next(
      (m) => m.t === 'room' && m.room.seats[1]?.kind === 'bot',
      10_000,
      'bot at 1',
    );
    human.lobby({ type: 'addBot', seat: 1 });
    await ack;
  }

  let sawDummy11 = false;
  const badTurnSeats: number[] = [];
  human.onServerMsg((m) => {
    if (m.t !== 'update' && m.t !== 'welcome') return;
    if (m.turn && m.turn.seat >= 2) badTurnSeats.push(m.turn.seat);
    const deal = m.view?.deal;
    if (!deal) return;
    if (deal.dummyHandCount === 11) sawDummy11 = true;
    expect(deal.handCounts[2]).toBe(0);
    expect(deal.handCounts[3]).toBe(0);
  });
  attachDriver(human, { openBid: true });

  const started = human.next((m) => m.t === 'update' && m.view.deal !== null, 10_000, 'start');
  human.lobby({ type: 'startMatch' });
  await started;

  const scored = await waitForDealScored(human, 90_000);
  const deal = scored.view.deal;
  if (!deal || deal.phase.name !== 'scored') throw new Error('expected scored deal');
  expect(deal.tricksPlayed).toBe(11);
  expect(scored.view.scores.length).toBe(2);
  expect(deal.phase.result.sides.length).toBe(2);
  expect(deal.phase.result.declarer).not.toBeNull();
  expect(sawDummy11).toBe(true);
  expect(badTurnSeats).toEqual([]);

  // Server truth: the dead third hand exists but nobody ever acted for it.
  const room = server.rooms.get(human.roomCode);
  expect(room?.match?.deal?.dummyHand?.length).toBe(11);

  human.close();
});
