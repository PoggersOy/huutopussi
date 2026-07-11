/** Home recents / install affordance + History screen rendering. */
import type { MatchSummary } from '@hp/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { recordRecentRoom, recordRoomHistory } from '../src/history';
import i18n from '../src/i18n';
import { initInstallPrompt, installAvailable, promptInstall } from '../src/install';
import { serverApply } from '../src/store';

vi.mock('../src/socket', () => ({
  sendLobby: vi.fn(),
  sendAction: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  resync: vi.fn(),
}));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.clear();
  serverApply.reset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home', () => {
  it('does not list rooms on Home (they live on History now)', () => {
    // Even with remembered rooms, Home shows no room list — it moved to History.
    recordRecentRoom('AB2CD', Date.UTC(2026, 6, 1));
    recordRecentRoom('QWXYZ', Date.UTC(2026, 6, 2));
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.queryByText('Recent rooms')).toBeNull();
    expect(screen.queryByRole('button', { name: /AB2CD|QWXYZ/ })).toBeNull();
  });

  it('hides the install button by default', () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Install the app' })).toBeNull();
  });
});

describe('History screen', () => {
  it('renders persisted match summaries newest first', () => {
    const older: MatchSummary = {
      finishedAt: Date.UTC(2026, 5, 1),
      winnerSide: 1,
      finalScores: [340, 505],
      deals: 9,
    };
    const newer: MatchSummary = {
      finishedAt: Date.UTC(2026, 6, 1),
      winnerSide: 0,
      finalScores: [510, 220],
      deals: 6,
    };
    recordRoomHistory('AB2CD', [older]);
    recordRoomHistory('QWXYZ', [newer]);

    window.history.pushState({}, '', '/history');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Match history' })).toBeTruthy();
    expect(screen.getByText(/6 deals/)).toBeTruthy();
    expect(screen.getByText(/9 deals/)).toBeTruthy();
    expect(screen.getByText('QWXYZ')).toBeTruthy();
    expect(screen.getByText('AB2CD')).toBeTruthy();
    const results = screen.getAllByText(/Side \d won/).map((el) => el.textContent);
    expect(results).toEqual(['Side 1 won', 'Side 2 won']); // newest (side 0 win) first
  });

  it('shows an empty state without history', () => {
    window.history.pushState({}, '', '/history');
    render(<App />);
    expect(screen.getByText('No matches played yet.')).toBeTruthy();
  });

  it('lists live rooms from /api/rooms with a rejoin button, newest first', async () => {
    recordRecentRoom('AB2CD', Date.UTC(2026, 6, 1));
    recordRecentRoom('QWXYZ', Date.UTC(2026, 6, 2)); // newest → probed first
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        rooms: [
          { code: 'QWXYZ', status: 'playing', seatsFilled: 4, seatsTotal: 4 },
          { code: 'AB2CD', status: 'lobby', seatsFilled: 2, seatsTotal: 4 },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    window.history.pushState({}, '', '/history');
    render(<App />);

    expect(await screen.findByText('Open games')).toBeTruthy();
    expect(screen.getByRole('button', { name: /QWXYZ/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /AB2CD/ })).toBeTruthy();
    expect(screen.getByText(/In progress/)).toBeTruthy();
    expect(screen.getByText(/In lobby/)).toBeTruthy();
    expect(screen.getByText(/4\/4 seated/)).toBeTruthy();
    // Probed exactly the remembered codes (newest first), one request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms?codes=QWXYZ%2CAB2CD');
  });

  it('shows no open-games section when the probe returns nothing', async () => {
    recordRecentRoom('AB2CD', Date.UTC(2026, 6, 1));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rooms: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    window.history.pushState({}, '', '/history');
    render(<App />);
    // The probe fired…
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // …but with no live rooms and no finished matches, we fall to the empty state.
    expect(screen.getByText('No matches played yet.')).toBeTruthy();
    expect(screen.queryByText('Open games')).toBeNull();
  });
});

describe('install prompt affordance', () => {
  it('captures beforeinstallprompt and consumes it on promptInstall', async () => {
    initInstallPrompt();
    expect(installAvailable()).toBe(false);

    const prompt = vi.fn(() => Promise.resolve());
    const evt = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(evt, { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) });
    act(() => {
      window.dispatchEvent(evt);
    });
    expect(installAvailable()).toBe(true);
    expect(evt.defaultPrevented).toBe(true);

    await promptInstall();
    expect(prompt).toHaveBeenCalledOnce();
    expect(installAvailable()).toBe(false);
  });
});
