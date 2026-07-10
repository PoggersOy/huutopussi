/** Shared helpers for the Table screen and its sheets/overlays. */
import { type DealView, nextSeat, partnerOf, type Seat, type Suit } from '@hp/engine';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';

export const SUIT_GLYPH: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠' };

/**
 * Visual felt slot of `other` relative to `me`: 0=self/bottom, 1=left,
 * 2=top/across, 3=right. Parametric on the game mode: 4p keeps the classic
 * layout (partner across), 3p seats the two opponents left+right, 2p seats
 * the single opponent across.
 */
export function feltSlot(me: Seat, other: Seat, players: 2 | 3 | 4): 0 | 1 | 2 | 3 {
  const rel = (other - me + players) % players;
  if (players === 2) return rel === 0 ? 0 : 2;
  if (players === 3) return rel === 0 ? 0 : rel === 1 ? 1 : 3;
  return rel as 0 | 1 | 2 | 3;
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
