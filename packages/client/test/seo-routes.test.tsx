import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App';
import i18n from '../src/i18n';

describe('public SEO routes', () => {
  afterEach(() => cleanup());

  it('renders /saannot with route-specific metadata', async () => {
    await i18n.changeLanguage('fi');
    window.history.pushState({}, '', '/saannot');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Huutopussin säännöt' }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.title).toMatch(/^Huutopussin säännöt/);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
        'https://huutopussi.online/saannot',
      );
      expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(
        /^index/,
      );
    });
  });

  it('renders /opettele with route-specific metadata', async () => {
    await i18n.changeLanguage('fi');
    window.history.pushState({}, '', '/opettele');
    render(<App />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Opettele pelaamaan Huutopussia',
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.title).toMatch(/^Opettele Huutopussi/);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
        'https://huutopussi.online/opettele',
      );
    });
  });
});
