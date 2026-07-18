/**
 * adminStats (the /stats endpoint's data source): counts today's games and the
 * unique HUMAN players in them — registered accounts deduped by account, guests
 * by session — plus lifetime sign-ups. Bots, unseated spectators, and yesterday's
 * rooms must not count.
 */
import { DEFAULT_RULES, type RuleConfig, type Seat } from '@hp/engine';
import { expect, test } from 'vitest';
import { Db } from '../src/db.js';

const config: RuleConfig = { ...DEFAULT_RULES, players: 4 };

/** Seat a session in a room. Fresh Db → saveSession stamps updated_at = now. */
function seat(
  db: Db,
  token: string,
  roomId: string,
  seatNo: Seat,
  userId: string | null,
  kind: 'human' | 'bot' = 'human',
): void {
  db.saveSession({ token, roomId, seat: seatNo, nickname: token, kind, userId });
}

test('adminStats counts today’s games, unique players, and total sign-ups', () => {
  const db = new Db(':memory:');
  const since = Date.now() - 60_000; // one minute ago → "today" for fresh rows

  // Three registered accounts; uC never plays today but still counts as a sign-up.
  for (const id of ['uA', 'uB', 'uC']) {
    db.upsertUserByGoogleSub({ id, googleSub: `g-${id}`, name: id, picture: null });
  }

  // Two games today, in two rooms.
  db.createMatch({ id: 'm1', roomId: 'r1', config, firstDealer: 0 });
  db.createMatch({ id: 'm2', roomId: 'r2', config, firstDealer: 0 });

  // r1: account uA + two guests, plus a bot and an unseated human (both ignored).
  seat(db, 'r1-uA', 'r1', 0, 'uA');
  seat(db, 'r1-g1', 'r1', 1, null);
  seat(db, 'r1-g2', 'r1', 2, null);
  seat(db, 'r1-bot', 'r1', 3, null, 'bot');
  db.saveSession({
    token: 'r1-watch',
    roomId: 'r1',
    seat: null,
    nickname: 'watch',
    kind: 'human',
    userId: null,
  });

  // r2: uA again (new session → same account, deduped) + a new account uB.
  seat(db, 'r2-uA', 'r2', 0, 'uA');
  seat(db, 'r2-uB', 'r2', 1, 'uB');

  // A game from days ago (old started_at + old session): excluded from "today".
  const old = since - 3 * 24 * 60 * 60 * 1000;
  db.raw
    .prepare(
      `INSERT INTO matches (id, room_id, config, first_dealer, status, started_at)
       VALUES ('mOld', 'rOld', ?, 0, 'finished', ?)`,
    )
    .run(JSON.stringify(config), old);
  db.raw
    .prepare(
      `INSERT INTO sessions (token, room_id, seat, nickname, kind, user_id, created_at, updated_at)
       VALUES ('rOld-uC', 'rOld', 0, 'uC', 'human', 'uC', ?, ?)`,
    )
    .run(old, old);

  const stats = db.adminStats(since);
  expect(stats.gamesToday).toBe(2);
  expect(stats.registeredPlayersToday).toBe(2); // uA (once) + uB
  expect(stats.guestPlayersToday).toBe(2); // g1 + g2
  expect(stats.uniquePlayersToday).toBe(4);
  expect(stats.registeredUsersTotal).toBe(3); // uA, uB, uC
  db.close();
});

test('adminStats on an empty db is all zeros', () => {
  const db = new Db(':memory:');
  expect(db.adminStats(Date.now() - 60_000)).toEqual({
    gamesToday: 0,
    uniquePlayersToday: 0,
    registeredPlayersToday: 0,
    guestPlayersToday: 0,
    registeredUsersTotal: 0,
  });
  db.close();
});
