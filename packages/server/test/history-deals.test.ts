/**
 * The history deal-browser reads its data from `matchSummaries`, which must now
 * carry, per finished match: the player count, the seat-indexed names captured
 * at match end, and every deal's full DealResult in deal order. These are
 * already persisted (deals.result, matches.names) — this asserts they come back
 * out intact, and that a nameless finish still yields browsable deal detail.
 */
import { DEFAULT_RULES, type DealResult, type RuleConfig } from '@hp/engine';
import { expect, test } from 'vitest';
import { Db } from '../src/db.js';

/** One SideBreakdown per delta; card/raw/rounded mirror the delta for brevity. */
function sides(deltas: number[]): DealResult['sides'] {
  return deltas.map((d) => ({
    cardPoints: d,
    lastTrickBonus: 0,
    marriagePoints: 0,
    discardPoints: 0,
    rawTotal: d,
    roundedTotal: d,
    tricks: 1,
    porvoo: false,
    scoreDelta: d,
  }));
}

const config = (players: 2 | 3 | 4): RuleConfig => ({ ...DEFAULT_RULES, players });

test('matchSummaries carries players, names and per-deal DealResults in order', () => {
  const db = new Db(':memory:');
  db.createMatch({ id: 'm1', roomId: 'r1', config: config(3), firstDealer: 0 });

  const d0: DealResult = {
    declarer: 0,
    contract: 60,
    bid: 60,
    made: true,
    sides: sides([60, 25, 35]),
  };
  const d1: DealResult = {
    declarer: 1,
    contract: 70,
    bid: 70,
    made: false,
    sides: sides([10, -70, 20]),
  };
  // Recorded out of deal order to prove matchSummaries sorts by deal_index.
  db.recordDealResult('m1', 1, 1, d1);
  db.recordDealResult('m1', 0, 0, d0);
  db.finishMatch('m1', 0, [70, -45, 55], ['Samuli', 'Paikka 2', 'Paikka 3']);

  const summaries = db.matchSummaries('r1');
  expect(summaries).toHaveLength(1);
  const s = summaries[0];
  if (!s) throw new Error('missing summary');
  expect(s.players).toBe(3);
  expect(s.deals).toBe(2);
  expect(s.finalScores).toEqual([70, -45, 55]);
  expect(s.names).toEqual(['Samuli', 'Paikka 2', 'Paikka 3']);
  expect(s.dealResults).toHaveLength(2);
  expect(s.dealResults?.[0]).toEqual(d0); // deal_index 0 first
  expect(s.dealResults?.[1]).toEqual(d1);
  db.close();
});

test('finishMatch without names → summary has no names but still has deal detail', () => {
  const db = new Db(':memory:');
  db.createMatch({ id: 'm2', roomId: 'r2', config: config(2), firstDealer: 0 });
  db.recordDealResult('m2', 0, 0, {
    declarer: 0,
    contract: 60,
    bid: 60,
    made: true,
    sides: sides([60, 40]),
  });
  db.finishMatch('m2', 0, [60, 40]); // names omitted

  const s = db.matchSummaries('r2')[0];
  if (!s) throw new Error('missing summary');
  expect(s.names).toBeUndefined();
  expect(s.players).toBe(2);
  expect(s.dealResults).toHaveLength(1);
  db.close();
});

test('matchSummaries returns only the newest bounded window', () => {
  const db = new Db(':memory:');
  for (let i = 1; i <= 30; i++) {
    const id = `m-${i}`;
    db.createMatch({ id, roomId: 'r-limit', config: config(2), firstDealer: 0 });
    db.finishMatch(id, 0, [i, 0]);
    db.raw.prepare('UPDATE matches SET finished_at = ? WHERE id = ?').run(i, id);
  }

  const summaries = db.matchSummaries('r-limit');
  expect(summaries).toHaveLength(25);
  expect(summaries[0]?.finishedAt).toBe(6);
  expect(summaries.at(-1)?.finishedAt).toBe(30);
  expect(summaries.at(-1)?.finalScores).toEqual([30, 0]);
  db.close();
});
