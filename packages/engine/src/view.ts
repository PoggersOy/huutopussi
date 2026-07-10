/**
 * Redaction choke point: everything a client or bot sees passes through here.
 * PlayerView is structurally hidden-info-free: other hands appear only as
 * counts, exchange faces only for the exchanging side, the talon only as a
 * count (except avoin koini during the first trick, when its faces are public
 * to everyone), the 2p dummy hand and the declarer's discards only as counts,
 * and card-carrying events are emptied for non-privy recipients.
 */
import { sortHand } from './deck.js';
import type { Card, DealView, GameEvent, MatchState, PlayerView, Seat } from './types.js';
import { partnerOf, SEATS } from './types.js';

function countsOf(rec: Record<Seat, Card[]>): Record<Seat, number> {
  const out = { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<Seat, number>;
  for (const s of SEATS) out[s] = rec[s].length;
  return out;
}

/** The redacted view for `viewer` — the ONLY game state clients ever see. */
export function redactViewFor(state: MatchState, viewer: Seat | 'spectator'): PlayerView {
  let dealView: DealView | null = null;
  const deal = state.deal;
  if (deal) {
    const seatViewer = viewer === 'spectator' ? null : viewer;
    // 4p exchange faces are visible to the declarer's pair only.
    const privy =
      state.config.players === 4 &&
      seatViewer !== null &&
      deal.declarer !== null &&
      (seatViewer === deal.declarer || seatViewer === partnerOf(deal.declarer));
    // Avoin koini: the talon faces are public to ALL viewers for the whole
    // first trick (including contract-less deals where nobody took it).
    const talonPublic =
      state.config.openTalon &&
      deal.talon !== null &&
      deal.tricksPlayed === 0 &&
      (deal.phase.name === 'lead' || deal.phase.name === 'follow');
    dealView = {
      hand: seatViewer === null ? [] : sortHand(deal.hands[seatViewer]),
      handCounts: countsOf(deal.hands),
      capturedCounts: countsOf(deal.captured),
      tricksWon: { ...deal.tricksWon },
      tricksPlayed: deal.tricksPlayed,
      trump: deal.trump,
      declarations: [...deal.declarations],
      askedWhole: { ...deal.askedWhole },
      askedHalf: { ...deal.askedHalf },
      bidLog: [...deal.bidLog],
      bid: deal.bid,
      declarer: deal.declarer,
      contract: deal.contract,
      exchangeSeen: privy
        ? {
            given: deal.exchange.given ? [...deal.exchange.given] : null,
            returned: deal.exchange.returned ? [...deal.exchange.returned] : null,
          }
        : null,
      talonCount: deal.talon === null ? null : deal.talonTakenBy === null ? deal.talon.length : 0,
      talonSeen: talonPublic && deal.talon !== null ? [...deal.talon] : null,
      dummyHandCount: deal.dummyHand === null ? null : deal.dummyHand.length,
      discardedCount: deal.discarded === null ? null : deal.discarded.length,
      lastTrick: state.config.showLastTrick ? deal.lastTrick : null,
      phase: deal.phase,
    };
  }
  return {
    viewer,
    config: state.config,
    scores: [...state.scores],
    dealer: state.dealer,
    dealIndex: state.dealIndex,
    winnerSide: state.winnerSide,
    deal: dealView,
  };
}

/**
 * Per-recipient event redaction. null = omit the event entirely.
 * Card-carrying payloads are emptied for non-privy viewers: dealStarted
 * deck -> [] for everyone (clients get their hand via snapshots),
 * cardsGiven/cardsReturned cards -> [] except for the two exchanging seats,
 * cardsDiscarded cards -> [] except for the discarding declarer.
 */
export function redactEventFor(event: GameEvent, viewer: Seat | 'spectator'): GameEvent | null {
  switch (event.type) {
    case 'dealStarted':
      return { ...event, deck: [] };
    case 'cardsGiven':
    case 'cardsReturned':
      if (viewer === event.from || viewer === event.to) return event;
      return { ...event, cards: [] };
    case 'cardsDiscarded':
      if (viewer === event.seat) return event;
      return { ...event, cards: [] };
    default:
      return event;
  }
}
