/** App shell smoke: router + i18n + store wire up and Home renders at '/'. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App';
import '../src/i18n';
import i18n from '../src/i18n';

describe('App', () => {
  afterEach(cleanup);

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
});
