/** Lobby: seats around the mini table, host vs guest powers, config panel. */
import { DEFAULT_RULES } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, SeatKind, ServerMsg } from '@hp/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { Lobby } from '../src/screens/Lobby';
import { serverApply, useStore } from '../src/store';

vi.mock('../src/socket', () => ({
  sendLobby: vi.fn(() => 'action-id'),
  sendAction: vi.fn(() => 'action-id'),
  connect: vi.fn(),
  disconnect: vi.fn(),
  resync: vi.fn(),
}));

import { disconnect, sendLobby } from '../src/socket';

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
      configName: null,
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
    // Seats are server-assigned now — there is no "Sit here" picker.
    expect(screen.queryByRole('button', { name: 'Sit here' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Add a bot' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove bot' })).toBeTruthy();

    // Two seats empty: the Start button is greyed (aria-disabled) but stays
    // pressable so a tap explains the block via a toast — it must NOT start.
    const start = screen.getByRole('button', { name: 'Start the game' });
    expect(start.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(start);
    expect(sendLobby).not.toHaveBeenCalledWith({ type: 'startMatch' });
    expect(useStore.getState().ui.toasts.some((x) => x.code === 'lobby.needAllSeats')).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Add a bot' })[0] as HTMLElement);
    expect(sendLobby).toHaveBeenCalledWith({ type: 'addBot', seat: expect.any(Number) });
  });

  it('names bots in seat order (Matt, Mary, Carl)', () => {
    welcome([seat(0, 'human', 'Anna'), seat(1, 'bot'), seat(2, 'bot'), seat(3, 'bot')], 0);
    renderLobby();
    expect(screen.getByText('Matt')).toBeTruthy();
    expect(screen.getByText('Mary')).toBeTruthy();
    expect(screen.getByText('Carl')).toBeTruthy();
  });

  it('enables start with four filled seats and submits startMatch', () => {
    welcome([seat(0, 'human', 'Anna'), seat(1, 'bot'), seat(2, 'bot'), seat(3, 'bot')], 0);
    renderLobby();
    const start = screen.getByRole('button', { name: 'Start the game' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(sendLobby).toHaveBeenCalledWith({ type: 'startMatch' });
  });

  it('changes the player count with a resolved setConfig patch', () => {
    welcome(partialSeats, 0);
    renderLobby();

    fireEvent.change(screen.getByRole('combobox', { name: 'Players' }), {
      target: { value: '3' },
    });
    // The default config, resolved for 3 players: exchangeCount (a 4p field) is
    // stripped and players is overridden; configName stays the default (null).
    expect(sendLobby).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'setConfig',
        configName: null,
        patch: expect.objectContaining({ players: 3 }),
      }),
    );
    const [call] = (sendLobby as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect((call?.[0] as { patch: Record<string, unknown> }).patch).not.toHaveProperty(
      'exchangeCount',
    );
  });

  it('lists saved configs in the ruleset dropdown and applies the chosen one', () => {
    welcome(partialSeats, 0);
    useStore.setState((s) => ({
      auth: {
        ...s.auth,
        ruleConfigs: [
          { id: 'x1', name: 'House rules', config: { ...DEFAULT_RULES, winTarget: 300 } },
        ],
      },
    }));
    renderLobby();

    const ruleset = screen.getByRole('combobox', { name: 'Ruleset' });
    expect(within(ruleset).getByText('Default')).toBeTruthy();
    expect(within(ruleset).getByText('House rules')).toBeTruthy();

    fireEvent.change(ruleset, { target: { value: 'x1' } });
    expect(sendLobby).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'setConfig',
        configName: 'House rules',
        patch: expect.objectContaining({ winTarget: 300, players: 4 }),
      }),
    );
  });
});

describe('View all rules overlay', () => {
  it('opens from the config panel and surfaces rules the editable panel hides', () => {
    welcome(partialSeats, 0);
    renderLobby();

    // Hidden rules (e.g. the bid increment) are not on screen until opened.
    expect(screen.queryByText('Bid increment')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View all rules in play' }));
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getByText('Rules in play')).toBeTruthy();
    // The room uses the built-in default config (configName null) → "Default".
    expect(dialog.getByText('Default')).toBeTruthy();
    // Fields the editable panel never exposes:
    expect(dialog.getByText('Bid increment')).toBeTruthy();
    expect(dialog.getByText('Maximum bid')).toBeTruthy();
    expect(dialog.getByText('First-trick constraints')).toBeTruthy();
    // Values are derived from the live config:
    expect(dialog.getByText('440')).toBeTruthy(); // DEFAULT_RULES.maxBid
    expect(dialog.getByText('No constraints')).toBeTruthy(); // firstTrickRules 'free'
    // 4p omits the 2-3p talon rows and shows the exchange instead.
    expect(dialog.queryByText('Talon size')).toBeNull();
    expect(dialog.getByText('Cards exchanged')).toBeTruthy();

    // Two dismiss affordances share the "Close" name: the corner × and the
    // footer button. Either closes the overlay.
    const closeButtons = dialog.getAllByRole('button', { name: 'Close' });
    expect(closeButtons).toHaveLength(2);
    const [cornerClose] = closeButtons;
    if (!cornerClose) throw new Error('expected a corner close button');
    fireEvent.click(cornerClose);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    welcome(partialSeats, 0);
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'View all rules in play' }));

    const backdrop = screen.getByRole('dialog');
    // A click that originates inside the panel must not dismiss.
    fireEvent.click(within(backdrop).getByText('Rules in play'));
    expect(screen.queryByRole('dialog')).toBeTruthy();

    // A click on the backdrop itself dismisses.
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on the Escape key', () => {
    welcome(partialSeats, 0);
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'View all rules in play' }));
    expect(screen.queryByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is available to non-host guests too', () => {
    welcome(partialSeats, null);
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'View all rules in play' }));
    expect(within(screen.getByRole('dialog')).getByText('Rules in play')).toBeTruthy();
  });
});

describe('Lobby as guest', () => {
  it('shows the config read-only and no host or seat controls', () => {
    welcome(partialSeats, null);
    renderLobby();

    expect(screen.queryByRole('button', { name: 'Start the game' })).toBeNull();
    expect(screen.getByText('Waiting for the host to start…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove bot' })).toBeNull();
    // Seats are server-assigned: no "Sit here" / "Stand up" controls for anyone.
    expect(screen.queryByRole('button', { name: 'Sit here' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stand up' })).toBeNull();
    expect(screen.getByText('Only the host can change the rules')).toBeTruthy();
    // The player-count select is disabled, and the ruleset shows as plain text
    // (not an editable dropdown) for a guest.
    const players = screen.getByRole('combobox', { name: 'Players' });
    expect((players as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Ruleset' })).toBeNull();
  });

  it('offers a Back-to-menu escape so a guest is never trapped waiting on the host', () => {
    welcome(partialSeats, null);
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Back to menu' }));
    expect(disconnect).toHaveBeenCalled();
  });
});
