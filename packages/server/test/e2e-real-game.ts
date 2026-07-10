/**
 * e2e-real-game.ts — headless full-stack integration check (run with tsx).
 *
 * Connects one scripted WS "human", fills seats 1-3 with bots via lobby
 * commands, starts the match and plays every human turn from server hints
 * until the MATCH COMPLETES. Along the way it:
 *   - drops the human socket mid-deal and reconnects with the sessionToken,
 *     asserting the welcome snapshot fully resumes play;
 *   - asserts hints are only ever addressed to our own seat;
 *   - asserts the 'history' message arrives after matchEnded;
 *   - asserts matches/deals rows exist in the SQLite db.
 *
 * Modes:
 *   tsx test/e2e-real-game.ts                          # spins up its own real
 *     server (fast timers, temp db) on an ephemeral port — CI-fast.
 *   tsx test/e2e-real-game.ts --port 8199 --db /path/hp.db [--win-target 100]
 *     # runs against an already-listening server (production timers).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Seat } from '@hp/engine';
import type { ServerMsg } from '@hp/protocol';
import Database from 'better-sqlite3';
import { createServer, type HpServer } from '../src/server.js';
import { attachDriver, sleep, TestClient } from './helpers.js';

type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;
type UpdateMsg = Extract<ServerMsg, { t: 'update' }>;
type HistoryMsg = Extract<ServerMsg, { t: 'history' }>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** Every hint-bearing turn must be addressed to our own seat (hidden info). */
function watchHintLeaks(client: TestClient, label: string): void {
  client.onServerMsg((m) => {
    if ((m.t === 'update' || m.t === 'welcome') && m.turn && m.turn.hints !== null) {
      if (m.turn.seat !== client.seat) {
        fail(`${label}: received hints for foreign seat ${m.turn.seat} (mine: ${client.seat})`);
      }
    }
  });
}

async function main(): Promise<void> {
  const externalPort = arg('--port');
  const external = externalPort !== undefined;
  const dbArg = arg('--db');
  const winTargetArg = arg('--win-target');
  const overallMs = external ? 480_000 : 120_000;
  const watchdog = setTimeout(() => fail(`did not finish within ${overallMs} ms`), overallMs);

  let server: HpServer | null = null;
  let port: number;
  let dbPath: string;
  if (external) {
    port = Number(externalPort);
    if (!dbArg) fail('--db <path> is required with --port');
    dbPath = dbArg;
  } else {
    dbPath = dbArg ?? join(mkdtempSync(join(tmpdir(), 'hp-e2e-')), 'hp.db');
    server = createServer({
      port: 0,
      dbPath,
      staticDir: null,
      heartbeatMs: null,
      timers: {
        turnMs: 5_000,
        wholeAnswerMs: 5_000,
        graceMs: 2_000,
        nextDealDelayMs: 25,
        redealDelayMs: 25,
        idleCloseMs: 60_000,
        botDelayMs: [1, 5],
      },
    });
    port = await server.listen();
  }
  console.log(`[e2e] target ws://127.0.0.1:${port}/ws  db=${dbPath}  external=${external}`);

  // 1. One scripted human creates the room (auto-seated at 0 as host).
  const human = await TestClient.connect(port);
  watchHintLeaks(human, 'human');
  const welcome = (await human.hello({ nickname: 'e2e-human' })) as WelcomeMsg;
  assert(welcome.t === 'welcome', `expected welcome, got ${JSON.stringify(welcome)}`);
  assert(welcome.seat === 0, `host should sit at seat 0, got ${welcome.seat}`);
  const roomCode = human.roomCode;
  const sessionToken = human.token;
  console.log(`[e2e] room ${roomCode} created, seat 0, token ${sessionToken.slice(0, 8)}…`);

  // 2. Fill seats 1-3 with bots via lobby commands.
  for (const seat of [1, 2, 3] as Seat[]) {
    const confirmed = human.next(
      (m) => m.t === 'room' && m.room.seats[seat]?.kind === 'bot',
      10_000,
      `bot at seat ${seat}`,
    );
    human.lobby({ type: 'addBot', seat });
    await confirmed;
  }
  console.log('[e2e] bots seated at 1,2,3');

  // Optional short match against production timers.
  if (winTargetArg !== undefined) {
    const target = Number(winTargetArg);
    const confirmed = human.next(
      (m) => m.t === 'room' && m.room.config.winTarget === target,
      10_000,
      'config patch',
    );
    human.lobby({ type: 'setConfig', patch: { winTarget: target } });
    await confirmed;
    console.log(`[e2e] winTarget set to ${target}`);
  }

  // 3. Start the match and auto-play the human's turns from received hints.
  attachDriver(human);
  const started = human.next(
    (m) => m.t === 'update' && m.view.deal !== null,
    15_000,
    'first deal to start',
  );
  human.lobby({ type: 'startMatch' });
  await started;
  console.log('[e2e] match started (deal 0 dealt)');

  // 4. Mid-deal reconnect: wait until we are mid-trick, then drop the socket.
  const midTrick = (await human.next(
    (m) => m.t === 'update' && m.view.deal?.phase.name === 'follow',
    60_000,
    'mid-trick phase',
  )) as UpdateMsg;
  const seqAtDrop = midTrick.seq;
  human.terminate();
  console.log(`[e2e] human socket TERMINATED mid-trick at seq ${seqAtDrop}`);
  await sleep(external ? 1_000 : 250);

  const human2 = await TestClient.connect(port);
  watchHintLeaks(human2, 'human2');
  // History arrives right after the final update — register the waiter early.
  const historyPromise = human2.next((m) => m.t === 'history', overallMs, 'history message');
  const welcome2 = (await human2.hello({
    roomCode,
    sessionToken,
    nickname: 'e2e-human',
  })) as WelcomeMsg;
  assert(welcome2.t === 'welcome', `reconnect: expected welcome, got ${JSON.stringify(welcome2)}`);
  assert(welcome2.sessionToken === sessionToken, 'reconnect must keep the same sessionToken');
  assert(welcome2.seat === 0, `reconnect must restore seat 0, got ${welcome2.seat}`);
  assert(welcome2.view !== null, 'reconnect welcome must carry a full snapshot view');
  assert(welcome2.view.deal !== null, 'reconnect snapshot must contain the live deal');
  assert(welcome2.seq >= seqAtDrop, `reconnect seq ${welcome2.seq} < seq at drop ${seqAtDrop}`);
  assert(
    welcome2.room.seats[0]?.connected === true,
    'reconnect welcome must show seat 0 connected',
  );
  console.log(
    `[e2e] RECONNECTED with token: seat 0, seq ${welcome2.seq}, ` +
      `deal phase ${welcome2.view.deal.phase.name} — snapshot resumed`,
  );
  attachDriver(human2);

  // 5. Run to a completed match.
  const ended = (await human2.next(
    (m) => m.t === 'update' && m.view.winnerSide !== null,
    overallMs,
    'match end',
  )) as UpdateMsg;
  console.log(
    `[e2e] MATCH COMPLETED: winnerSide=${ended.view.winnerSide} scores=${JSON.stringify(
      ended.view.scores,
    )} after deal ${ended.view.dealIndex + 1}`,
  );

  // 6. History message must arrive with the finished match.
  const history = (await historyPromise) as HistoryMsg;
  assert(history.matches.length >= 1, 'history must list at least one finished match');
  const last = history.matches[0];
  assert(last !== undefined, 'history entry missing');
  assert(last.winnerSide === ended.view.winnerSide, 'history winnerSide mismatch');
  console.log(
    `[e2e] history message OK: ${history.matches.length} match(es), ` +
      `winnerSide=${last.winnerSide}, deals=${last.deals}, finalScores=${JSON.stringify(
        last.finalScores,
      )}`,
  );

  // 7. Db rows: matches row finished with winner, deals rows recorded.
  await sleep(200); // let the final transaction settle
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const match = db
    .prepare(
      `SELECT m.id, m.status, m.winner_side, m.deals, m.final_score0, m.final_score1
         FROM matches m JOIN rooms r ON r.id = m.room_id
        WHERE r.code = ? AND m.status = 'finished'
        ORDER BY m.finished_at DESC LIMIT 1`,
    )
    .get(roomCode) as
    | {
        id: string;
        status: string;
        winner_side: number | null;
        deals: number;
        final_score0: number | null;
        final_score1: number | null;
      }
    | undefined;
  assert(match !== undefined, `no finished matches row for room ${roomCode}`);
  assert(match.winner_side !== null, 'matches.winner_side must be set');
  assert(match.deals >= 1, 'matches.deals must be >= 1');
  const dealRows = db
    .prepare('SELECT COUNT(*) AS c FROM deals WHERE match_id = ?')
    .get(match.id) as {
    c: number;
  };
  assert(dealRows.c >= 1, 'deals table must have rows for the match');
  assert(dealRows.c === match.deals, `deals rows ${dealRows.c} != matches.deals ${match.deals}`);
  db.close();
  console.log(
    `[e2e] db OK: match ${match.id.slice(0, 8)}… status=${match.status} ` +
      `winner_side=${match.winner_side} deals=${match.deals} ` +
      `finals=[${match.final_score0},${match.final_score1}] deal rows=${dealRows.c}`,
  );

  human2.close();
  if (server) await server.close();
  clearTimeout(watchdog);
  console.log('[e2e] PASS — full match over real WS with mid-deal reconnect, history and db rows');
  process.exit(0);
}

main().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exit(1);
});
