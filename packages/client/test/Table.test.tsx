/**
 * Table screen: hint-gated sheets, two-step card play, exchange selection,
 * declaration flow, speech bubbles and the scored/match overlays. All
 * interactivity must come from server-sent hints (socket layer mocked).
 */
import { type Card, DEFAULT_RULES, type DealView, type PlayerView, type Seat } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, ServerMsg, TurnInfo } from '@hp/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { Table } from '../src/screens/Table';
import { serverApply } from '../src/store';

vi.mock('../src/socket', () => ({
  sendAction: vi.fn(() => 'action-id'),
  sendLobby: vi.fn(() => 'lobby-id'),
  disconnect: vi.fn(),
}));

import { disconnect, sendAction, sendLobby } from '../src/socket';

function seatInfo(seat: Seat): SeatInfo {
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
    render(<Table />, { wrapper: MemoryRouter });

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
    render(<Table />, { wrapper: MemoryRouter });

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
    render(<Table />, { wrapper: MemoryRouter });

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
    render(<Table />, { wrapper: MemoryRouter });

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
    render(<Table />, { wrapper: MemoryRouter });

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
    render(<Table />, { wrapper: MemoryRouter });

    fireEvent.click(screen.getByRole('button', { name: /Hearts \+100/ }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'declareOwn', suit: 'H' });

    fireEvent.click(screen.getByRole('button', { name: 'Ask partner for a marriage' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'askWhole' });

    // Half-ask sub-picker: holding ♠K asks for ♠Q.
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a half…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Got ♠Q?' }));
    expect(sendAction).toHaveBeenCalledWith({ type: 'askHalf', suit: 'S', rankHeld: 'K' });
  });

  it('lets you just lead a card while the declaration sheet is open', () => {
    applyWelcome(declView(), declTurn());
    render(<Table />, { wrapper: MemoryRouter });

    // The sheet is only a prompt: the hand stays live, so leading a card
    // directly is how you decline to declare (no "just lead" button needed).
    expect(screen.getByText('Declaration')).toBeTruthy();

    const card = screen.getByRole('button', { name: 'S6' });
    fireEvent.click(card); // raise
    fireEvent.click(card); // confirm
    expect(sendAction).toHaveBeenCalledWith({ type: 'playCard', card: 'S6' });
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
    render(<Table />, { wrapper: MemoryRouter });

    expect(screen.getByText('60!')).toBeTruthy();
  });

  it('shows a coloured trump bubble with a suit-tinted glyph when a marriage is made', () => {
    applyWelcome(makeView(makeDeal()), null);
    serverApply.update({
      t: 'update',
      seq: 2,
      view: makeView(
        makeDeal({
          trump: 'H',
          declarations: [{ suit: 'H', seat: 0, side: 0, how: 'own', trickIndex: 0, points: 40 }],
        }),
      ),
      event: { type: 'trumpSet', suit: 'H', seat: 0, side: 0, how: 'own', points: 40 },
      turn: null,
    });
    render(<Table />, { wrapper: MemoryRouter });

    // The whole announcement renders, carrying the special trump styling.
    const bubble = screen.getByText(/\+40/).closest('.bubble') as HTMLElement;
    expect(bubble).toBeTruthy();
    expect(bubble.classList.contains('bubble--trump')).toBe(true);
    // The suit glyph is wrapped so it can be tinted by colour.
    const glyph = within(bubble).getByText('♥');
    expect(glyph.classList.contains('suit--H')).toBe(true);
  });
});

describe('overlays', () => {
  it('shows the deal-scored breakdown with the trickless flag and running totals', () => {
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
    render(<Table />, { wrapper: MemoryRouter });

    expect(screen.getByText('Contract 60 made — p0')).toBeTruthy();
    expect(screen.getByText('Card points')).toBeTruthy();
    expect(screen.getByText('+120')).toBeTruthy();
    expect(screen.getByText('-60')).toBeTruthy();
    expect(screen.getByText('No tricks!')).toBeTruthy();
    expect(screen.getByText('Standing: 120 — -60')).toBeTruthy();
  });

  it('holds the score card for a beat after the final trick, then reveals it', () => {
    vi.useFakeTimers();
    try {
      // Live final trick: three cards down, my last card still in hand.
      applyWelcome(
        makeView(
          makeDeal({
            declarer: 0,
            contract: 60,
            bid: { seat: 0, amount: 60 },
            trump: 'H',
            tricksPlayed: 8,
            tricksWon: { 0: 5, 1: 3, 2: 0, 3: 0 },
            hand: ['H10'],
            handCounts: { 0: 1, 1: 0, 2: 0, 3: 0 },
            phase: {
              name: 'follow',
              leader: 1,
              plays: [
                { seat: 1, card: 'S6' },
                { seat: 2, card: 'S7' },
                { seat: 3, card: 'S8' },
              ],
            },
          }),
        ),
        null,
      );
      render(<Table />, { wrapper: MemoryRouter });

      // Playing the last card scores the deal: the server sends the cardPlayed
      // event with a view already advanced to `scored`.
      act(() => {
        serverApply.update({
          t: 'update',
          seq: 2,
          view: makeView(
            makeDeal({
              declarer: 0,
              contract: 60,
              bid: { seat: 0, amount: 60 },
              trump: 'H',
              tricksPlayed: 9,
              tricksWon: { 0: 6, 1: 3, 2: 0, 3: 0 },
              hand: [],
              handCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
              lastTrick: {
                plays: [
                  { seat: 1, card: 'S6' },
                  { seat: 2, card: 'S7' },
                  { seat: 3, card: 'S8' },
                  { seat: 0, card: 'H10' },
                ],
                winner: 0,
              },
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
                      porvoo: false,
                      scoreDelta: -60,
                    },
                  ],
                },
              },
            }),
            { scores: [120, -60] },
          ),
          event: { type: 'cardPlayed', seat: 0, card: 'H10' },
          turn: null,
        });
      });

      // Withheld at first so the final card + trick winner are visible.
      expect(screen.queryByText('Card points')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(screen.getByText('Card points')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the score card at once when a snapshot arrives already scored', () => {
    // Reconnect/resync into an already-scored deal: no final trick to watch, so
    // the score card must not be withheld.
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
                  porvoo: false,
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
    render(<Table />, { wrapper: MemoryRouter });

    expect(screen.getByText('Card points')).toBeTruthy();
  });

  it('shows the redeal countdown overlay when a redeal is demanded', () => {
    applyWelcome(makeView(makeDeal()), null);
    // The redeal demand clears the deal; every client gets the broadcast event.
    serverApply.update({
      t: 'update',
      seq: 2,
      view: makeView(null),
      event: { type: 'redealDemanded', seat: 1 },
      turn: null,
    });
    render(<Table />, { wrapper: MemoryRouter });

    expect(screen.getByText('New deal')).toBeTruthy();
    expect(screen.getByText('p1 demanded a redeal')).toBeTruthy();
    expect(screen.getByText(/Redealing in \d+…/)).toBeTruthy();
  });

  it('clears the redeal overlay once the fresh deal starts', () => {
    applyWelcome(makeView(makeDeal()), null);
    serverApply.update({
      t: 'update',
      seq: 2,
      view: makeView(null),
      event: { type: 'redealDemanded', seat: 1 },
      turn: null,
    });
    serverApply.update({
      t: 'update',
      seq: 3,
      view: makeView(makeDeal()),
      event: { type: 'dealStarted', dealIndex: 0, dealer: 3, deck: [] },
      turn: null,
    });
    render(<Table />, { wrapper: MemoryRouter });

    expect(screen.queryByText('New deal')).toBeNull();
  });

  it('shows the match-ended overlay with the rematch button for the host', () => {
    applyWelcome(makeView(makeDeal(), { winnerSide: 0, scores: [505, 210] }), null);
    render(<Table />, { wrapper: MemoryRouter });

    expect(screen.getByText('You win!')).toBeTruthy();
    expect(screen.getByText('Winners: p0 & p2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rematch' }));
    expect(sendLobby).toHaveBeenCalledWith({ type: 'rematch' });
  });
});

describe('host stop game', () => {
  it('the host stops the game only after confirming; cancel aborts', () => {
    applyWelcome(makeView(makeDeal()), null); // viewer is seat 0 = host, match ongoing
    render(<Table />, { wrapper: MemoryRouter });

    // Opening the confirm does NOT stop the game on its own.
    fireEvent.click(screen.getByRole('button', { name: 'Stop game' }));
    expect(screen.getByText('Stop the game?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Stop the game?')).toBeNull();
    expect(sendLobby).not.toHaveBeenCalled();

    // Confirming sends the stopMatch lobby command.
    fireEvent.click(screen.getByRole('button', { name: 'Stop game' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop game' }));
    expect(sendLobby).toHaveBeenCalledWith({ type: 'stopMatch' });
    expect(screen.queryByText('Stop the game?')).toBeNull();
    // ...and the host leaves for Home instead of waiting on the server's WS
    // close (which a proxy can turn into an endless "reconnecting…").
    expect(disconnect).toHaveBeenCalled();
  });

  it('hides the Stop button once the match is over', () => {
    applyWelcome(makeView(makeDeal(), { winnerSide: 0, scores: [505, 210] }), null);
    render(<Table />, { wrapper: MemoryRouter });
    expect(screen.queryByRole('button', { name: 'Stop game' })).toBeNull();
  });

  it('does not show the Stop button to a non-host', () => {
    const guestRoom = { ...room, hostSeat: 1 as Seat };
    const msg: Extract<ServerMsg, { t: 'welcome' }> = {
      t: 'welcome',
      v: 1,
      sessionToken: '123e4567-e89b-42d3-a456-426614174000',
      room: guestRoom,
      seat: 0,
      seq: 1,
      view: makeView(makeDeal()),
      turn: null,
    };
    serverApply.welcome(msg);
    render(<Table />, { wrapper: MemoryRouter });
    expect(screen.queryByRole('button', { name: 'Stop game' })).toBeNull();
  });
});
