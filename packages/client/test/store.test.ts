/** Store smoke tests: wholesale snapshot replacement + ui slice behavior. */
import { DEFAULT_RULES, type GameEvent, type PlayerView } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, ServerMsg } from '@hp/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { serverApply, useStore } from '../src/store';

function seatInfo(seat: 0 | 1 | 2 | 3): SeatInfo {
  return { seat, nickname: `p${seat}`, kind: 'human', connected: true, botControlled: false };
}

const room: RoomStatePublic = {
  code: 'ABCDE',
  seats: [seatInfo(0), seatInfo(1), seatInfo(2), seatInfo(3)],
  hostSeat: 0,
  config: DEFAULT_RULES,
  tableSettings: { autoplay: true, turnTimeoutSec: 90 },
  status: 'playing',
};

function makeView(dealIndex: number): PlayerView {
  return {
    viewer: 0,
    config: DEFAULT_RULES,
    scores: [0, 0],
    dealer: 0,
    dealIndex,
    winnerSide: null,
    deal: null,
  };
}

const welcome: Extract<ServerMsg, { t: 'welcome' }> = {
  t: 'welcome',
  v: 1,
  sessionToken: '123e4567-e89b-42d3-a456-426614174000',
  room,
  seat: 0,
  seq: 3,
  view: makeView(0),
  turn: null,
};

beforeEach(() => {
  serverApply.reset();
});

describe('server slice', () => {
  it('welcome populates the slice and marks connected', () => {
    serverApply.welcome(welcome);
    const { server } = useStore.getState();
    expect(server.connected).toBe(true);
    expect(server.seq).toBe(3);
    expect(server.seat).toBe(0);
    expect(server.room?.code).toBe('ABCDE');
    expect(server.view?.dealIndex).toBe(0);
  });

  it('update replaces the snapshot wholesale and clears interaction state', () => {
    serverApply.welcome(welcome);
    useStore.getState().setPendingAction('some-action-id');
    useStore.getState().raiseCard('HA');

    const next = makeView(1);
    serverApply.update({ t: 'update', seq: 9, view: next, event: null, turn: null });

    const { server, ui } = useStore.getState();
    expect(server.seq).toBe(9);
    expect(server.view).toBe(next); // replaced, not merged
    expect(server.turn).toBeNull();
    expect(ui.pendingActionId).toBeNull();
    expect(ui.raisedCard).toBeNull();
  });

  it('notable events produce info toasts', () => {
    const trumpSet: GameEvent = {
      type: 'trumpSet',
      suit: 'H',
      seat: 0,
      side: 0,
      how: 'own',
      points: 100,
    };
    serverApply.update({ t: 'update', seq: 1, view: makeView(0), event: trumpSet, turn: null });
    const { toasts } = useStore.getState().ui;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.code).toBe('event.trumpSet');
    expect(toasts[0]?.params).toEqual({ suit: 'H', points: 100 });
  });

  it('error sets lastError, toasts, and clears only the matching pending action', () => {
    useStore.getState().setPendingAction('aaa');
    serverApply.error({ t: 'error', refActionId: 'bbb', code: 'error.notYourTurn' });
    expect(useStore.getState().server.lastError?.code).toBe('error.notYourTurn');
    expect(useStore.getState().ui.pendingActionId).toBe('aaa'); // different action

    serverApply.error({ t: 'error', refActionId: 'aaa', code: 'error.mustHeadTrick' });
    expect(useStore.getState().ui.pendingActionId).toBeNull();
    expect(useStore.getState().ui.toasts.map((t) => t.kind)).toEqual(['error', 'error']);
  });

  it('disconnect keeps the stale view for the reconnect banner', () => {
    serverApply.welcome(welcome);
    serverApply.setConnected(false);
    const { server } = useStore.getState();
    expect(server.connected).toBe(false);
    expect(server.view).not.toBeNull();
  });
});

describe('ui slice', () => {
  it('two-step card raise toggles', () => {
    useStore.getState().raiseCard('S10');
    expect(useStore.getState().ui.raisedCard).toBe('S10');
    useStore.getState().raiseCard(null);
    expect(useStore.getState().ui.raisedCard).toBeNull();
  });

  it('toast queue is capped', () => {
    for (let i = 0; i < 8; i++) {
      useStore.getState().pushToast({ kind: 'info', code: `event.test${i}` });
    }
    const { toasts } = useStore.getState().ui;
    expect(toasts).toHaveLength(5);
    expect(toasts[4]?.code).toBe('event.test7'); // newest kept
  });

  it('dismissToast removes by id', () => {
    useStore.getState().pushToast({ kind: 'info', code: 'event.a' });
    useStore.getState().pushToast({ kind: 'info', code: 'event.b' });
    const first = useStore.getState().ui.toasts[0];
    expect(first).toBeDefined();
    if (first) useStore.getState().dismissToast(first.id);
    expect(useStore.getState().ui.toasts.map((t) => t.code)).toEqual(['event.b']);
  });
});
