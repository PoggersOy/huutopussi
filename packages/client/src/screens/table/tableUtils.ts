/** Shared helpers for the Table screen and its sheets/overlays. */
import { type DealView, nextSeat, partnerOf, type Seat, type Suit } from '@hp/engine';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';

export const SUIT_GLYPH: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠' };

/** Position of `other` relative to `me` around the table: 0=self/bottom, 1=left, 2=partner/top, 3=right. */
export function relSeat(me: Seat, other: Seat): 0 | 1 | 2 | 3 {
  return ((other - me + 4) % 4) as 0 | 1 | 2 | 3;
}

/** Seat display name: nickname when seated, localized seat label otherwise. */
export function useNameOf(): (seat: Seat) => string {
  const room = useStore((s) => s.server.room);
  const { t } = useTranslation();
  return (seat) => room?.seats[seat]?.nickname ?? t('table.seat', { seat: seat + 1 });
}

/**
 * The seat expected to act in the current phase — derived from the public
 * phase so waiting labels and the turn highlight work even for recipients
 * whose TurnInfo carries no hints.
 */
export function actorOf(deal: DealView, players: 2 | 3 | 4): Seat | null {
  const phase = deal.phase;
  switch (phase.name) {
    case 'bidding':
      return phase.turn;
    case 'exchangeGive':
      return deal.declarer !== null ? partnerOf(deal.declarer) : null;
    case 'exchangeDiscard':
    case 'exchangeContract':
    case 'exchangeReturn':
      return deal.declarer;
    case 'lead':
      return phase.leader;
    case 'awaitWholeAnswer':
      return partnerOf(phase.leader);
    case 'follow': {
      const lastPlay = phase.plays[phase.plays.length - 1];
      return lastPlay !== undefined ? nextSeat(lastPlay.seat, players) : phase.leader;
    }
    case 'scored':
      return null;
  }
}
