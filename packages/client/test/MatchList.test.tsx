/**
 * MatchList: the shared match-summary rows (History screen + lobby panel). The
 * result headline names the winner(s): a single player in 2-3p ("Cecilia
 * voitti") and the winning pair in 4p ("Ben & Daniel voittivat", plural verb).
 * Bot seats (stored with a null name) get their localized bot name in seat
 * order. Summaries saved before the deal-browser feature lack names/players and
 * fall back to the plain "Puoli N voitti".
 */
import type { MatchSummary } from '@hp/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MatchList } from '../src/components/MatchList';
import type { HistoryEntry } from '../src/history';
import i18n from '../src/i18n';

beforeAll(async () => {
  await i18n.changeLanguage('fi');
});
afterEach(cleanup);

const entry = (match: MatchSummary): HistoryEntry => ({ roomCode: 'ABCDE', match });

describe('MatchList winner headline', () => {
  it('names the single winner in a 2-3p match ("<nimi> voitti")', () => {
    const match: MatchSummary = {
      finishedAt: 1000,
      winnerSide: 2,
      finalScores: [430, 380, 510],
      deals: 9,
      players: 3,
      names: ['Anni', 'Ben', 'Cecilia'],
    };
    render(<MatchList entries={[entry(match)]} showRoom={false} />);
    expect(screen.getByText('Cecilia voitti')).toBeTruthy();
  });

  it('names the winning pair (plural) in a 4p match ("A & B voittivat")', () => {
    const match: MatchSummary = {
      finishedAt: 1000,
      winnerSide: 1, // seats 1 & 3
      finalScores: [340, 505],
      deals: 6,
      players: 4,
      names: ['Anni', 'Ben', 'Cecilia', 'Daniel'],
    };
    render(<MatchList entries={[entry(match)]} showRoom={false} />);
    expect(screen.getByText('Ben & Daniel voittivat')).toBeTruthy();
  });

  it('names a bot winner slot with its localized bot name (seat order)', () => {
    // Two bot seats (2 & 3, both null): the lower-seat bot is the first name in
    // the pool ("Matti"), so the winning pair 0 & 2 reads "Anni & Matti".
    const match: MatchSummary = {
      finishedAt: 1000,
      winnerSide: 0, // seats 0 & 2
      finalScores: [520, 310],
      deals: 7,
      players: 4,
      names: ['Anni', 'Ben', null, null],
    };
    render(<MatchList entries={[entry(match)]} showRoom={false} />);
    expect(screen.getByText('Anni & Matti voittivat')).toBeTruthy();
  });

  it('names a solo bot winner in a 2-3p match', () => {
    const match: MatchSummary = {
      finishedAt: 1000,
      winnerSide: 1, // seat 1 (the only bot → first bot name)
      finalScores: [430, 510, 380],
      deals: 9,
      players: 3,
      names: ['Anni', null, 'Cecilia'],
    };
    render(<MatchList entries={[entry(match)]} showRoom={false} />);
    expect(screen.getByText('Matti voitti')).toBeTruthy();
  });

  it('falls back to the plain side headline for pre-feature summaries', () => {
    const match: MatchSummary = {
      finishedAt: 1000,
      winnerSide: 0,
      finalScores: [520, 310],
      deals: 7,
    };
    render(<MatchList entries={[entry(match)]} showRoom={false} />);
    expect(screen.getByText('Puoli 1 voitti')).toBeTruthy();
  });
});
