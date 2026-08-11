/** App shell smoke: router + i18n + store wire up and Home renders at '/'. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import '../src/i18n';
import i18n from '../src/i18n';

const socketMocks = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('../src/socket', () => ({
  ...socketMocks,
  findMatch: vi.fn(),
  loadSessionToken: vi.fn(() => 'room-session'),
  resync: vi.fn(),
  sendAction: vi.fn(),
  sendLobby: vi.fn(),
}));

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the Home screen at /', async () => {
    await i18n.changeLanguage('en');
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Huutopussi' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create a room' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Room code')).toBeTruthy();
  });

  it('switches language to Finnish', async () => {
    await i18n.changeLanguage('fi');
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByRole('button', { name: 'Luo huone' })).toBeTruthy();
  });

  it('disconnects when browser navigation leaves a room route', async () => {
    await i18n.changeLanguage('en');
    window.history.pushState({}, '', '/r/AB2CD');
    render(<App />);
    await vi.waitFor(() => expect(socketMocks.connect).toHaveBeenCalled());

    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.waitFor(() => expect(socketMocks.disconnect).toHaveBeenCalledTimes(1));
  });
});
