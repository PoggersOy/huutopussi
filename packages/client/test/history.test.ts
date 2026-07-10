/** localStorage-backed recent rooms + per-room match history. */
import type { MatchSummary } from '@hp/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadAllHistory,
  loadRecentRooms,
  loadRoomHistory,
  RECENT_LIMIT,
  recordRecentRoom,
  recordRoomHistory,
} from '../src/history';

function summary(finishedAt: number, winnerSide: 0 | 1 = 0): MatchSummary {
  return { finishedAt, winnerSide, finalScores: [520, 310], deals: 7 };
}

/** A 2-3p (pirunpakka) summary: side === seat, so winnerSide can be 2. */
function summary3p(finishedAt: number, winnerSide: 0 | 1 | 2 = 2): MatchSummary {
  return { finishedAt, winnerSide, finalScores: [430, 380, 510], deals: 9 };
}

beforeEach(() => localStorage.clear());

describe('recent rooms', () => {
  it('records newest first, case-normalized, deduplicated', () => {
    recordRecentRoom('abcde', 1000);
    recordRecentRoom('QWXYZ', 2000);
    recordRecentRoom('ABCDE', 3000); // revisit moves it to the front
    expect(loadRecentRooms()).toEqual([
      { code: 'ABCDE', at: 3000 },
      { code: 'QWXYZ', at: 2000 },
    ]);
  });

  it('caps the list', () => {
    for (let i = 0; i < RECENT_LIMIT + 3; i++) recordRecentRoom(`ROOM${i}`, i);
    const rooms = loadRecentRooms();
    expect(rooms).toHaveLength(RECENT_LIMIT);
    expect(rooms[0]?.code).toBe(`ROOM${RECENT_LIMIT + 2}`); // newest kept
  });

  it('tolerates garbage in storage', () => {
    localStorage.setItem('hp:recentRooms', '{not json');
    expect(loadRecentRooms()).toEqual([]);
    localStorage.setItem('hp:recentRooms', JSON.stringify([{ nope: 1 }, { code: 'AB2CD', at: 5 }]));
    expect(loadRecentRooms()).toEqual([{ code: 'AB2CD', at: 5 }]);
  });
});

describe('room match history', () => {
  it('replaces a room list wholesale and reads it back', () => {
    recordRoomHistory('abcde', [summary(1)]);
    recordRoomHistory('ABCDE', [summary(1), summary(2, 1)]);
    expect(loadRoomHistory('abcde')).toHaveLength(2);
  });

  it('aggregates all rooms newest first', () => {
    recordRoomHistory('AAAAA', [summary(10), summary(30)]);
    recordRoomHistory('BBBBB', [summary(20)]);
    expect(loadAllHistory().map((e) => [e.roomCode, e.match.finishedAt])).toEqual([
      ['AAAAA', 30],
      ['BBBBB', 20],
      ['AAAAA', 10],
    ]);
  });

  it('filters malformed entries', () => {
    localStorage.setItem('hp:history:XXXXX', JSON.stringify([{ bogus: true }, summary(5)]));
    expect(loadRoomHistory('XXXXX')).toEqual([summary(5)]);
  });

  it('keeps 3-player summaries (winnerSide up to 2, three final scores)', () => {
    recordRoomHistory('TRI33', [summary3p(1, 0), summary3p(2, 1), summary3p(3, 2)]);
    expect(loadRoomHistory('TRI33')).toHaveLength(3);
    expect(
      loadAllHistory()
        .map((e) => e.match.winnerSide)
        .sort(),
    ).toEqual([0, 1, 2]);
  });

  it('rejects a winnerSide that does not index the final scores', () => {
    const bad: MatchSummary = {
      finishedAt: 9,
      winnerSide: 2 as 0 | 1,
      finalScores: [1, 2],
      deals: 4,
    };
    localStorage.setItem('hp:history:BADXX', JSON.stringify([bad, summary(7)]));
    expect(loadRoomHistory('BADXX')).toEqual([summary(7)]);
  });
});
