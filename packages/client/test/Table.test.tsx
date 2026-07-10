/**
 * Table screen: hint-gated sheets, two-step card play, exchange selection,
 * declaration flow, speech bubbles and the scored/match overlays. All
 * interactivity must come from server-sent hints (socket layer mocked).
 */
import { type Card, DEFAULT_RULES, type DealView, type PlayerView, type Seat } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, ServerMsg, TurnInfo } from '@hp/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { Table } from '../src/screens/Table';
import { serverApply } from '../src/store';

vi.mock('../src/socket', () => ({
  sendAction: vi.fn(() => 'action-id'),
  sendLobby: vi.fn(() => 'lobby-id'),
}));

import { sendAction, sendLobby } from '../src/socket';

function seatInfo(seat: Seat): SeatInfo {
  return { seat, nickname: `p${seat}`, kind: 'human', connected: true, botControlled: false };
}

const room: RoomStatePublic = {
  code: 'ABCDE',
  seats: [seatInfo(0), seatInfo(1), seatInfo(2), seatInfo(3)],
  hostSeat: 0,
  config: DEFAULT_RULES,
  status: 'playing',
};

const HAND: Card[] = ['HA', 'H10', 'HK', 'HQ', 'DJ', 'D9', 'C8', 'C7', 'S6'];

function makeDeal(overrides: Partial<DealView> = {}): DealView {
  return {
    hand: [...HAND],
    handCounts: { 0: 9, 1: 9, 2: 9, 3: 9 },
    capturedCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
    tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0 },
    tricksPlayed: 0,
    trump: null,
    declarations: [],
    askedWhole: { 0: false, 1: false, 2: false, 3: false },
    askedHalf: { 0: false, 1: false, 2: false, 3: false },
    bidLog: [],
    bid: null,
    declarer: null,
    contract: null,
    exchangeSeen: null,
    talonCount: null,
    talonSeen: null,
    dummyHandCount: null,
    discardedCount: null,
    lastTrick: null,
    phase: {
      name: 'bidding',
      turn: 0,
      highBid: null,
      passed: [],
      firstTurnTaken: [],
      excluded: [],
    },
    ...overrides,
  };
}

function makeView(deal: DealView | null, overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    viewer: 0,
    config: DEFAULT_RULES,
    scores: [0, 0],
    dealer: 3,
    dealIndex: 0,
    winnerSide: null,
    deal,
    ...overrides,
  };
}

function myTurn(hints: TurnInfo['hints']): TurnInfo {
  return { seat: 0, deadline: Date.now() + 45_000, hints };
}

function applyWelcome(view: PlayerView, turn: TurnInfo | null): void {
  const msg: Extract<ServerMsg, { t: 'welcome' }> = {
    t: 'welcome',
    v: 1,
    sessionToken: '123e4567-e89b-42d3-a456-426614174000',
    room,
    seat: 0,
    seq: 1,
    view,
    turn,
  };
  serverApply.welcome(msg);
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  serverApply.reset();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('bidding sheet', () => {
  it('shows the high bid and sends a stepped bid from hints', () => {
    applyWelcome(
      makeView(
        makeDeal({
          phase: {
            name: 'bidding',
            turn: 0,
            highBid: { seat: 1, amount: 60 },
            passed: [],
            firstTurnTaken: [0, 1],
            excluded: [],
          },
        }),
      ),
      myTurn([
        {
          type: 'bid',
          min: 65,
          max: 440,
          step: 5,
          canPass: true,
          canDemandRedeal: false,
          forced: false,
        },
      ]),
    );
    render(<Table />);

    expect(screen.getByText('High bid 60 — p1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bid 70' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'bid', amount: 70 });

    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'pass' });
  });

  it('shows the forced-bid notice and the redeal demand button when hinted', () => {
    applyWelcome(
      makeView(makeDeal()),
      myTurn([
        {
          type: 'bid',
          min: 50,
          max: 440,
          step: 5,
          canPass: false,
          canDemandRedeal: true,
          forced: true,
        },
      ]),
    );
    render(<Table />);

    expect(screen.getByText('Forced opening: you must bid at least 50')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pass' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Demand a redeal' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'demandRedeal' });
  });

  it('shows a waiting note without hints (not my turn)', () => {
    applyWelcome(
      makeView(
        makeDeal({
          phase: {
            name: 'bidding',
            turn: 2,
            highBid: null,
            passed: [],
            firstTurnTaken: [],
            excluded: [],
          },
        }),
      ),
      { seat: 2, deadline: Date.now() + 45_000, hints: null },
    );
    render(<Table />);

    // Appears both in the top bar and in the passive bidding sheet.
    expect(screen.getAllByText('No bids yet').length).toBeGreaterThan(0);
    expect(screen.getByText('Waiting for p2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bid/ })).toBeNull();
  });
});

describe('two-step play', () => {
  it('raises a legal card on first tap, plays it on second, keeps illegal cards disabled', () => {
    applyWelcome(
      makeView(
        makeDeal({
          trump: 'H',
          phase: { name: 'follow', leader: 1, plays: [{ seat: 1, card: 'S10' }] },
        }),
      ),
      myTurn([{ type: 'playCard', legal: ['S6'] }]),
    );
    render(<Table />);

    const illegal = screen.getByRole('button', { name: 'HA' });
    expect((illegal as HTMLButtonElement).disabled).toBe(true);

    const legal = screen.getByRole('button', { name: 'S6' });
    fireEvent.click(legal);
    expect(legal.className).toContain('hand__card--raised');
    expect(sendAction).not.toHaveBeenCalled();

    fireEvent.click(legal);
    expect(sendAction).toHaveBeenCalledWith({ type: 'playCard', card: 'S6' });
  });
});

describe('exchange sheet', () => {
  it('enables confirm only at the exact count and sends the selection', () => {
    applyWelcome(
      makeView(
        makeDeal({ declarer: 2, bid: { seat: 2, amount: 100 }, phase: { name: 'exchangeGive' } }),
      ),
      myTurn([{ type: 'giveCards', count: 3 }]),
    );
    render(<Table />);

    expect(screen.getByText('Give 3 cards to the declarer (p2)')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /Confirm/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'HA' }));
    fireEvent.click(screen.getByRole('button', { name: 'H10' }));
    fireEvent.click(screen.getByRole('button', { name: 'HK' }));
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirm);
    expect(sendAction).toHaveBeenCalledWith({ type: 'giveCards', cards: ['HA', 'H10', 'HK'] });
  });
});

describe('declaration sheet', () => {
  const declTurn = () =>
    myTurn([
      {
        type: 'declaration',
        ownSuits: ['H'],
        canAskWhole: true,
        halfAsks: [{ suit: 'S', rankHeld: 'K' }],
      },
      { type: 'playCard', legal: [...HAND] },
    ]);

  const declView = () =>
    makeView(
      makeDeal({
        declarer: 0,
        contract: 100,
        bid: { seat: 0, amount: 100 },
        phase: { name: 'lead', leader: 0, canDeclare: true },
      }),
    );

  it('offers own suits, whole ask and the half-ask picker from hints', () => {
    applyWelcome(declView(), declTurn());
    render(<Table />);

    fireEvent.click(screen.getByRole('button', { name: /Hearts \+100/ }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'declareOwn', suit: 'H' });

    fireEvent.click(screen.getByRole('button', { name: 'Ask partner for a marriage' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'askWhole' });

    // Half-ask sub-picker: holding ♠K asks for ♠Q.
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a half…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Got ♠Q?' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'askHalf', suit: 'S', rankHeld: 'K' });
  });

  it('"Just lead" dismisses the sheet and leaves a reopen chip', () => {
    applyWelcome(declView(), declTurn());
    render(<Table />);

    fireEvent.click(screen.getByRole('button', { name: 'Just lead' }));
    expect(screen.queryByText('Declaration')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Declare…' }));
    expect(screen.getByText('Declaration')).toBeTruthy();
  });
});

describe('speech bubbles', () => {
  it('derives a bid bubble from the update event', () => {
    const view = makeView(makeDeal());
    applyWelcome(view, null);
    serverApply.update({
      t: 'update',
      seq: 2,
      view: makeView(
        makeDeal({
          phase: {
            name: 'bidding',
            turn: 2,
            highBid: { seat: 1, amount: 60 },
            passed: [],
            firstTurnTaken: [0, 1],
            excluded: [],
          },
        }),
      ),
      event: { type: 'bidPlaced', seat: 1, amount: 60 },
      turn: null,
    });
    render(<Table />);

    expect(screen.getByText('60!')).toBeTruthy();
  });
});

describe('overlays', () => {
  it('shows the deal-scored breakdown with Porvoo and running totals', () => {
    applyWelcome(
      makeView(
        makeDeal({
          declarer: 0,
          contract: 60,
          bid: { seat: 0, amount: 60 },
          tricksPlayed: 9,
          phase: {
            name: 'scored',
            result: {
              declarer: 0,
              contract: 60,
              bid: 60,
              made: true,
              sides: [
                {
                  cardPoints: 70,
                  lastTrickBonus: 10,
                  marriagePoints: 40,
                  discardPoints: 0,
                  rawTotal: 120,
                  roundedTotal: 120,
                  tricks: 9,
                  porvoo: false,
                  scoreDelta: 120,
                },
                {
                  cardPoints: 10,
                  lastTrickBonus: 0,
                  marriagePoints: 0,
                  discardPoints: 0,
                  rawTotal: 10,
                  roundedTotal: 10,
                  tricks: 0,
                  porvoo: true,
                  scoreDelta: -60,
                },
              ],
            },
          },
        }),
        { scores: [120, -60] },
      ),
      null,
    );
    render(<Table />);

    expect(screen.getByText('Contract 60 made — p0')).toBeTruthy();
    expect(screen.getByText('Card points')).toBeTruthy();
    expect(screen.getByText('+120')).toBeTruthy();
    expect(screen.getByText('-60')).toBeTruthy();
    expect(screen.getByText('Porvoo (läpäri)!')).toBeTruthy();
    expect(screen.getByText('Standing: 120 — -60')).toBeTruthy();
  });

  it('shows the match-ended overlay with the rematch button for the host', () => {
    applyWelcome(makeView(makeDeal(), { winnerSide: 0, scores: [505, 210] }), null);
    render(<Table />);

    expect(screen.getByText('You win!')).toBeTruthy();
    expect(screen.getByText('Winners: p0 & p2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rematch' }));
    expect(sendLobby).toHaveBeenCalledWith({ type: 'rematch' });
  });
});
