/**
 * Koinipakka reveal memory (2-3p illisoft exchange). When the declarer takes
 * the talon the server snapshot simply shows a bigger hand — the wire carries
 * no "these cards came from the talon" field. This module watches consecutive
 * store snapshots and remembers the cards that appeared in the viewer's hand
 * the moment the talon pile emptied, so the discard sheet can highlight what
 * the koinipakka contained. Pure presentation: legality still comes only from
 * the server's `discardCards` hint.
 *
 * Best-effort by design: after a reload/resync mid-discard the diff is gone
 * and the sheet just omits the reveal (the cards are in the hand anyway).
 */
import type { Card } from '@hp/engine';
import { useSyncExternalStore } from 'react';
import { useStore } from '../../store';

interface TalonMemory {
  dealIndex: number;
  cards: Card[];
}

let memory: TalonMemory | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

useStore.subscribe((state, prev) => {
  const next = state.server.view;
  const before = prev.server.view;
  if (next === before) return;
  if (next === null || next.deal === null) {
    if (memory !== null) {
      memory = null;
      emit();
    }
    return;
  }
  if (memory !== null && memory.dealIndex !== next.dealIndex) {
    memory = null;
    emit();
  }
  const nextDeal = next.deal;
  const prevDeal = before !== null && before.dealIndex === next.dealIndex ? before.deal : null;
  if (prevDeal === null) return;
  const talonJustTaken =
    prevDeal.talonCount !== null &&
    prevDeal.talonCount > 0 &&
    nextDeal.talonCount === 0 &&
    nextDeal.hand.length > prevDeal.hand.length;
  if (!talonJustTaken) return;
  const gained = nextDeal.hand.filter((card) => !prevDeal.hand.includes(card));
  if (gained.length > 0) {
    memory = { dealIndex: next.dealIndex, cards: gained };
    emit();
  }
});

const NO_CARDS: Card[] | null = null;

/** The talon cards the viewer gained this deal, or null when unknown. */
export function useTalonCards(dealIndex: number): Card[] | null {
  return useSyncExternalStore(subscribe, () =>
    memory !== null && memory.dealIndex === dealIndex ? memory.cards : NO_CARDS,
  );
}
