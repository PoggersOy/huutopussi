/**
 * DealMemory — what a careful human remembers about the current deal, built
 * ONLY from the PlayerView snapshots a seat receives (the same snapshots a
 * human client renders). Nothing here can see hidden information: every fact
 * is either public (cards played, declarations) or privy to this seat (its own
 * hand, its exchange faces, its own discards, the open talon window).
 *
 * Facts kept:
 *  - every card played this deal, by whom, per trick (with trick winners);
 *  - per-seat EXCLUSIONS: cards a seat provably does not hold. Inferred
 *    rule-agnostically from the engine's own `legalPlays`: if seat X played p
 *    into a trick, any card c with p ∉ legalPlays([p, c], …) cannot be in X's
 *    hand (holding c would have made p illegal — failing to follow, to head,
 *    to trump, or the first-trick ace show). Pairwise testing is exact for the
 *    pakko rules because each obligation is triggered by holding ONE card of a
 *    class;
 *  - KNOWN HOLDINGS: cards provably in a specific seat's hand (4p exchange
 *    faces for the exchanging pair, declared own marriages, the taken open
 *    talon), and side-level knowledge (an asked marriage sits with the asking
 *    side, so the opponents hold neither half);
 *  - this seat's own discards (2-3p declarer).
 *
 * Memory survives across turns because the server keeps one bot instance per
 * seat. A bot created mid-deal (server restart, seat takeover) simply knows
 * less: `complete` is false and the sampler treats unseen played cards as
 * gone (see search.ts), which is always consistent with the view.
 */
import type { Card, DealView, PlayerView, RuleConfig, Seat, Suit, TrickPlay } from '@hp/engine';
import {
  activeSeats,
  legalPlays,
  makeCard,
  makeDeck,
  partnerOf,
  RANKS,
  rankOf,
  SEATS,
  sideOf,
  suitOf,
} from '@hp/engine';

export const ALL_CARDS: readonly Card[] = makeDeck();

export interface TrickRecord {
  plays: TrickPlay[];
  winner: Seat | null;
}

function emptySeatSets(): Record<Seat, Set<Card>> {
  return { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set() };
}

/** Trump in force during trick `k`: the latest declaration made at or before it. */
export function trumpDuringTrick(deal: DealView, k: number): Suit | null {
  let trump: Suit | null = null;
  for (const d of deal.declarations) if (d.trickIndex <= k) trump = d.suit;
  return trump;
}

export class DealMemory {
  /** Trick index → plays seen so far (in play order) and winner once known. */
  readonly tricks = new Map<number, TrickRecord>();
  readonly playedBy = new Map<Card, Seat>();
  readonly excluded: Record<Seat, Set<Card>> = emptySeatSets();
  /** Cards this seat discarded (2-3p declarer), as decided by this bot. */
  myDiscards: Card[] | null = null;
  /** Open-talon faces seen during the first trick (avoin koini). */
  talonSeen: Card[] | null = null;
  /** True when the history is known from the first trick (no gaps). */
  complete = true;

  private dealIndex = -1;
  private biddingHand = '';

  /** Ingests a snapshot; resets on a new deal or a redeal. */
  observe(view: PlayerView): void {
    const deal = view.deal;
    if (!deal) return;
    if (view.dealIndex !== this.dealIndex) {
      this.reset(view.dealIndex, deal);
    } else if (deal.phase.name === 'bidding') {
      // A redeal keeps dealIndex but deals a fresh hand.
      const sig = deal.hand.join(',');
      if (sig !== this.biddingHand) this.reset(view.dealIndex, deal);
    }
    if (deal.talonSeen) this.talonSeen = [...deal.talonSeen];

    const phase = deal.phase;
    if (deal.lastTrick && deal.tricksPlayed > 0) {
      this.ingestTrick(deal.tricksPlayed - 1, deal.lastTrick.plays, deal, view.config);
      const rec = this.tricks.get(deal.tricksPlayed - 1);
      if (rec) rec.winner = deal.lastTrick.winner;
    }
    if (phase.name === 'follow') {
      this.ingestTrick(deal.tricksPlayed, phase.plays, deal, view.config);
    }
    // A gap: tricks we never saw (no showLastTrick, or a mid-deal bot).
    for (let k = 0; k < deal.tricksPlayed; k++) {
      const rec = this.tricks.get(k);
      if (!rec || rec.plays.length < view.config.players) {
        this.complete = false;
        break;
      }
    }
  }

  /** Called by the bot when it decides its own discards (privy to it). */
  recordDiscards(cards: readonly Card[]): void {
    this.myDiscards = [...cards];
  }

  get played(): ReadonlySet<Card> {
    return new Set(this.playedBy.keys());
  }

  private reset(dealIndex: number, deal: DealView): void {
    this.tricks.clear();
    this.playedBy.clear();
    for (const s of SEATS) this.excluded[s].clear();
    this.myDiscards = null;
    this.talonSeen = null;
    this.dealIndex = dealIndex;
    this.biddingHand = deal.phase.name === 'bidding' ? deal.hand.join(',') : '';
    this.complete = deal.tricksPlayed === 0;
  }

  private ingestTrick(
    k: number,
    plays: readonly TrickPlay[],
    deal: DealView,
    config: RuleConfig,
  ): void {
    let rec = this.tricks.get(k);
    if (!rec) {
      rec = { plays: [], winner: null };
      this.tricks.set(k, rec);
    }
    const trump = trumpDuringTrick(deal, k);
    const rules = k === 0 ? config.firstTrickRules : 'free';
    for (let i = rec.plays.length; i < plays.length; i++) {
      const play = plays[i] as TrickPlay;
      rec.plays.push(play);
      this.playedBy.set(play.card, play.seat);
      const before = plays.slice(0, i);
      for (const c of ALL_CARDS) {
        if (c === play.card || this.excluded[play.seat].has(c)) continue;
        if (!legalPlays([play.card, c], before, trump, rules).includes(play.card)) {
          this.excluded[play.seat].add(c);
        }
      }
    }
  }
}

/**
 * Everything the bot provably knows about where unplayed cards are, derived
 * from the memory plus the current view. `held[s]` = cards certainly in seat
 * s's hand; `excluded[s]` = cards certainly NOT in it.
 */
export interface Knowledge {
  me: Seat;
  played: ReadonlySet<Card>;
  held: Record<Seat, Set<Card>>;
  excluded: Record<Seat, Set<Card>>;
}

export function knowledgeOf(view: PlayerView, memory: DealMemory): Knowledge {
  const deal = view.deal;
  if (!deal || view.viewer === 'spectator') throw new Error('knowledgeOf: needs a seated view');
  const me = view.viewer;
  const config = view.config;
  const seats = activeSeats(config.players);
  const played = memory.played;
  const held = emptySeatSets();
  const excluded = emptySeatSets();
  for (const s of seats) for (const c of memory.excluded[s]) excluded[s].add(c);

  const hand = new Set(deal.hand);
  for (const c of hand) held[me].add(c);
  const place = (seat: Seat, card: Card): void => {
    if (played.has(card) || hand.has(card) || seat === me) return;
    held[seat].add(card);
  };

  // 4p exchange faces (declarer + partner only).
  if (deal.exchangeSeen && deal.declarer !== null) {
    const declarer = deal.declarer;
    const partner = partnerOf(declarer);
    const given = deal.exchangeSeen.given ?? [];
    const returned = deal.exchangeSeen.returned ?? [];
    for (const c of given) if (!returned.includes(c)) place(declarer, c);
    for (const c of returned) place(partner, c);
  }

  // Taken open talon: the declarer holds those faces (minus own discards,
  // which only the declarer itself can know — and then they are in `hand`).
  if (memory.talonSeen && deal.declarer !== null && config.players !== 4) {
    for (const c of memory.talonSeen) place(deal.declarer, c);
  }

  // Declarations: own → the declarer holds K+Q; wholeAsk → the answering
  // partner holds both; halfAsk → one each, so only side-level knowledge.
  for (const d of deal.declarations) {
    const k = makeCard(d.suit, 'K');
    const q = makeCard(d.suit, 'Q');
    if (d.how === 'own') {
      place(d.seat, k);
      place(d.seat, q);
    } else if (d.how === 'wholeAsk') {
      place(partnerOf(d.seat), k);
      place(partnerOf(d.seat), q);
    } else {
      const side = sideOf(d.seat, config.players);
      for (const s of seats) {
        if (sideOf(s, config.players) !== side) {
          excluded[s].add(k);
          excluded[s].add(q);
        }
      }
    }
  }

  // A card certainly held by one seat is excluded from every other seat.
  for (const s of seats) {
    for (const c of held[s]) for (const o of seats) if (o !== s) excluded[o].add(c);
  }
  // My own hand is fully known: everything else is excluded from me.
  for (const c of ALL_CARDS) if (!hand.has(c)) excluded[me].add(c);
  return { me, played, held, excluded };
}

/** Unplayed cards of `suit` ranked above `card` (excluding `card`). */
export function higherUnplayed(card: Card, played: ReadonlySet<Card>): Card[] {
  const suit = suitOf(card);
  const idx = RANKS.indexOf(rankOf(card));
  const out: Card[] = [];
  for (let i = 0; i < idx; i++) {
    const c = makeCard(suit, RANKS[i] as (typeof RANKS)[number]);
    if (!played.has(c)) out.push(c);
  }
  return out;
}

/** Unplayed cards of `suit` not in `hand` (could be in someone else's hand). */
export function outstandingOf(
  suit: Suit,
  hand: readonly Card[],
  played: ReadonlySet<Card>,
): Card[] {
  return ALL_CARDS.filter((c) => suitOf(c) === suit && !played.has(c) && !hand.includes(c));
}
