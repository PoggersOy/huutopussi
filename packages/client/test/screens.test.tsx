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
afterEach(cleanup);

describe('Home', () => {
  it('lists recent rooms from localStorage', () => {
    recordRecentRoom('AB2CD', Date.UTC(2026, 6, 1));
    recordRecentRoom('QWXYZ', Date.UTC(2026, 6, 2));
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByText('Recent rooms')).toBeTruthy();
    const rows = screen.getAllByRole('button', { name: /AB2CD|QWXYZ/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('QWXYZ'); // newest first
  });

  it('hides the recents panel and install button by default', () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.queryByText('Recent rooms')).toBeNull();
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
