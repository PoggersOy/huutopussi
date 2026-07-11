/** Lobby: seats around the mini table, host vs guest powers, config panel. */
import { DEFAULT_RULES } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, SeatKind, ServerMsg } from '@hp/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { Lobby } from '../src/screens/Lobby';
import { serverApply } from '../src/store';

vi.mock('../src/socket', () => ({
  sendLobby: vi.fn(() => 'action-id'),
  sendAction: vi.fn(() => 'action-id'),
  connect: vi.fn(),
  disconnect: vi.fn(),
  resync: vi.fn(),
}));

import { sendLobby } from '../src/socket';

function seat(n: 0 | 1 | 2 | 3, kind: SeatKind, nickname: string | null = null): SeatInfo {
  return { seat: n, nickname, kind, connected: kind === 'human', botControlled: false };
}

function welcome(seats: RoomStatePublic['seats'], mySeat: 0 | 1 | 2 | 3 | null): void {
  const msg: Extract<ServerMsg, { t: 'welcome' }> = {
    t: 'welcome',
    v: 1,
    sessionToken: '123e4567-e89b-42d3-a456-426614174000',
    room: {
      code: 'AB2CD',
      seats,
      hostSeat: 0,
      config: DEFAULT_RULES,
      tableSettings: { autoplay: true, turnTimeoutSec: 90 },
      status: 'lobby',
    },
    seat: mySeat,
    seq: 1,
    view: null,
    turn: null,
  };
  serverApply.welcome(msg);
}

function renderLobby() {
  return render(
    <MemoryRouter>
      <Lobby />
    </MemoryRouter>,
  );
}

const partialSeats: RoomStatePublic['seats'] = [
  seat(0, 'human', 'Anna'),
  seat(1, 'empty'),
  seat(2, 'bot'),
  seat(3, 'empty'),
];

beforeEach(async () => {
  await i18n.changeLanguage('en');
  serverApply.reset();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('Lobby as host', () => {
  it('shows seat cards, host bot controls, and a gated start button', () => {
    welcome(partialSeats, 0);
    renderLobby();

    expect(screen.getByText('Anna')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Sit here' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Add a bot' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove bot' })).toBeTruthy();

    const start = screen.getByRole('button', { name: 'Start the game' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true); // two seats still empty
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a bot' })[0] as HTMLElement);
    expect(sendLobby).toHaveBeenCalledWith({ type: 'addBot', seat: expect.any(Number) });
  });

  it('enables start with four filled seats and submits startMatch', () => {
    welcome([seat(0, 'human', 'Anna'), seat(1, 'bot'), seat(2, 'bot'), seat(3, 'bot')], 0);
    renderLobby();
    const start = screen.getByRole('button', { name: 'Start the game' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(sendLobby).toHaveBeenCalledWith({ type: 'startMatch' });
  });

  it('edits the rule config through setConfig patches', () => {
    welcome(partialSeats, 0);
    renderLobby();

    fireEvent.change(screen.getByRole('combobox', { name: 'Point system' }), {
      target: { value: 'B' },
    });
    expect(sendLobby).toHaveBeenCalledWith({ type: 'setConfig', patch: { cardPoints: 'B' } });

    fireEvent.change(screen.getByRole('combobox', { name: 'Minimum bid' }), {
      target: { value: '75' },
    });
    expect(sendLobby).toHaveBeenCalledWith({ type: 'setConfig', patch: { minBid: 75 } });

    fireEvent.click(screen.getByLabelText('Show the last trick'));
    expect(sendLobby).toHaveBeenCalledWith({ type: 'setConfig', patch: { showLastTrick: false } });
  });
});

describe('Lobby as guest', () => {
  it('shows the config read-only and no host controls', () => {
    welcome(partialSeats, null);
    renderLobby();

    expect(screen.queryByRole('button', { name: 'Start the game' })).toBeNull();
    expect(screen.getByText('Waiting for the host to start…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove bot' })).toBeNull();
    expect(screen.getByText('Only the host can change the rules')).toBeTruthy();
    const pointSystem = screen.getByRole('combobox', { name: 'Point system' });
    expect((pointSystem as HTMLSelectElement).disabled).toBe(true);
    // Unseated guests can still take an empty seat.
    fireEvent.click(screen.getAllByRole('button', { name: 'Sit here' })[0] as HTMLElement);
    expect(sendLobby).toHaveBeenCalledWith({ type: 'takeSeat', seat: expect.any(Number) });
  });

  it('lets a seated non-host stand up', () => {
    welcome(
      [seat(0, 'human', 'Anna'), seat(1, 'human', 'Ben'), seat(2, 'bot'), seat(3, 'empty')],
      1,
    );
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Stand up' }));
    expect(sendLobby).toHaveBeenCalledWith({ type: 'leaveSeat' });
  });
});
