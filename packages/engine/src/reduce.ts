/**
 * Event-sourced reducer: the only way MatchState changes (plan.md, engine design).
 * `applyEvent` performs minimal, deterministic per-event transitions and throws
 * only on impossible states (engine-bug assertions). It never mutates its input
 * (structural sharing of unchanged parts). All game-rule checking lives in
 * validate.ts; events reaching this reducer are assumed already validated.
 */
import type { RuleConfig } from './config.js';
import { declarableSuits } from './legality.js';
import type { Card, DealPhase, DealState, GameEvent, MatchState, Seat } from './types.js';
import { nextSeat, partnerOf } from './types.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`engine bug: ${msg}`);
}

/** Fresh match with no deal in progress; `firstDealer` deals dealIndex 0. */
export function initialMatchState(config: RuleConfig, firstDealer: Seat): MatchState {
  return {
    config,
    scores: [0, 0],
    dealer: firstDealer,
    dealIndex: 0,
    deal: null,
    winnerSide: null,
  };
}

/** The seat that opens the bidding for a deal dealt by `dealer`. */
export function firstBidderOf(dealer: Seat, config: RuleConfig): Seat {
  return config.firstBidder === 'dealer' ? dealer : nextSeat(dealer);
}

function bySeat<T>(make: (seat: Seat) => T): Record<Seat, T> {
  return { 0: make(0), 1: make(1), 2: make(2), 3: make(3) };
}

/** Clockwise from `from`, the first seat not in `passed`; `from` if none. */
function nextUnpassed(from: Seat, passed: readonly Seat[]): Seat {
  let s = from;
  for (let i = 0; i < 3; i++) {
    s = nextSeat(s);
    if (!passed.includes(s)) return s;
  }
  return from;
}

function addUnique(seats: readonly Seat[], seat: Seat): Seat[] {
  return seats.includes(seat) ? [...seats] : [...seats, seat];
}

/** Removes exactly `cards` from `hand`, asserting every card is present. */
function removeCards(hand: readonly Card[], cards: readonly Card[]): Card[] {
  const out = [...hand];
  for (const c of cards) {
    const i = out.indexOf(c);
    assert(i >= 0, `card ${c} not in hand`);
    out.splice(i, 1);
  }
  return out;
}

function requireDeal(state: MatchState): DealState {
  assert(state.deal, 'no deal in progress');
  return state.deal;
}

function withDeal(state: MatchState, deal: DealState): MatchState {
  return { ...state, deal };
}

function requirePhase<N extends DealPhase['name']>(
  deal: DealState,
  name: N,
): Extract<DealPhase, { name: N }> {
  assert(deal.phase.name === name, `expected phase ${name}, got ${deal.phase.name}`);
  return deal.phase as Extract<DealPhase, { name: N }>;
}

/** Pure reducer. Throws only on impossible states (engine-bug assertions). */
export function applyEvent(state: MatchState, event: GameEvent): MatchState {
  switch (event.type) {
    case 'dealStarted': {
      assert(event.deck.length === 36, 'dealStarted deck must contain 36 cards');
      const deal: DealState = {
        hands: bySeat((s) => event.deck.slice(s * 9, s * 9 + 9)),
        captured: bySeat<Card[]>(() => []),
        tricksWon: bySeat(() => 0),
        tricksPlayed: 0,
        trump: null,
        declarations: [],
        askedWhole: bySeat(() => false),
        bidLog: [],
        bid: null,
        declarer: null,
        contract: null,
        exchange: { given: null, returned: null },
        lastTrick: null,
        phase: {
          name: 'bidding',
          turn: firstBidderOf(event.dealer, state.config),
          highBid: null,
          passed: [],
          firstTurnTaken: [],
        },
      };
      return { ...state, dealer: event.dealer, dealIndex: event.dealIndex, deal };
    }

    case 'redealDemanded': {
      requirePhase(requireDeal(state), 'bidding');
      return { ...state, deal: null };
    }

    case 'bidPlaced': {
      const deal = requireDeal(state);
      const ph = requirePhase(deal, 'bidding');
      return withDeal(state, {
        ...deal,
        bidLog: [...deal.bidLog, { seat: event.seat, kind: 'bid', amount: event.amount }],
        phase: {
          ...ph,
          turn: nextUnpassed(event.seat, ph.passed),
          highBid: { seat: event.seat, amount: event.amount },
          firstTurnTaken: addUnique(ph.firstTurnTaken, event.seat),
        },
      });
    }

    case 'passed': {
      const deal = requireDeal(state);
      const ph = requirePhase(deal, 'bidding');
      const passed = addUnique(ph.passed, event.seat);
      return withDeal(state, {
        ...deal,
        bidLog: [...deal.bidLog, { seat: event.seat, kind: 'pass' }],
        phase: {
          ...ph,
          turn: nextUnpassed(event.seat, passed),
          passed,
          firstTurnTaken: addUnique(ph.firstTurnTaken, event.seat),
        },
      });
    }

    case 'biddingEnded': {
      const deal = requireDeal(state);
      requirePhase(deal, 'bidding');
      return withDeal(state, {
        ...deal,
        bid: { seat: event.declarer, amount: event.amount },
        declarer: event.declarer,
        phase: { name: 'exchangeGive' },
      });
    }

    case 'cardsGiven': {
      const deal = requireDeal(state);
      requirePhase(deal, 'exchangeGive');
      return withDeal(state, {
        ...deal,
        hands: {
          ...deal.hands,
          [event.from]: removeCards(deal.hands[event.from], event.cards),
          [event.to]: [...deal.hands[event.to], ...event.cards],
        },
        exchange: { ...deal.exchange, given: [...event.cards] },
        phase: { name: 'exchangeContract' },
      });
    }

    case 'contractSet': {
      const deal = requireDeal(state);
      requirePhase(deal, 'exchangeContract');
      return withDeal(state, {
        ...deal,
        contract: event.amount,
        phase: { name: 'exchangeReturn' },
      });
    }

    case 'cardsReturned': {
      const deal = requireDeal(state);
      requirePhase(deal, 'exchangeReturn');
      assert(event.from === deal.declarer, 'cardsReturned must come from the declarer');
      return withDeal(state, {
        ...deal,
        hands: {
          ...deal.hands,
          [event.from]: removeCards(deal.hands[event.from], event.cards),
          [event.to]: [...deal.hands[event.to], ...event.cards],
        },
        exchange: { ...deal.exchange, returned: [...event.cards] },
        phase: { name: 'lead', leader: event.from, canDeclare: false },
      });
    }

    case 'declaredOwn':
    case 'askedHalf': {
      const deal = requireDeal(state);
      const ph = requirePhase(deal, 'lead');
      assert(ph.canDeclare, 'declaration outside a declaration window');
      // The attempt is consumed; a trumpSet may still follow.
      return withDeal(state, {
        ...deal,
        phase: { name: 'lead', leader: ph.leader, canDeclare: false },
      });
    }

    case 'askedWhole': {
      const deal = requireDeal(state);
      const ph = requirePhase(deal, 'lead');
      assert(ph.canDeclare, 'askedWhole outside a declaration window');
      const partner = partnerOf(event.seat);
      const options = declarableSuits(
        deal.hands[partner],
        deal.declarations.map((d) => d.suit),
      );
      const phase: DealPhase =
        options.length >= 2
          ? { name: 'awaitWholeAnswer', leader: ph.leader }
          : { name: 'lead', leader: ph.leader, canDeclare: false };
      return withDeal(state, {
        ...deal,
        askedWhole: { ...deal.askedWhole, [event.seat]: true },
        phase,
      });
    }

    case 'answeredWhole': {
      const deal = requireDeal(state);
      if (deal.phase.name === 'awaitWholeAnswer') {
        return withDeal(state, {
          ...deal,
          phase: { name: 'lead', leader: deal.phase.leader, canDeclare: false },
        });
      }
      // Auto-answer (0 or 1 declarable marriages): askedWhole already closed the attempt.
      requirePhase(deal, 'lead');
      return state;
    }

    case 'answeredHalf': {
      requirePhase(requireDeal(state), 'lead');
      return state; // informational; a trumpSet follows on a yes
    }

    case 'trumpSet': {
      const deal = requireDeal(state);
      assert(
        !deal.declarations.some((d) => d.suit === event.suit),
        `suit ${event.suit} already declared this deal`,
      );
      return withDeal(state, {
        ...deal,
        trump: event.suit,
        declarations: [
          ...deal.declarations,
          {
            suit: event.suit,
            seat: event.seat,
            side: event.side,
            how: event.how,
            trickIndex: deal.tricksPlayed,
            points: event.points,
          },
        ],
      });
    }

    case 'cardPlayed': {
      const deal = requireDeal(state);
      const hands = {
        ...deal.hands,
        [event.seat]: removeCards(deal.hands[event.seat], [event.card]),
      };
      if (deal.phase.name === 'lead') {
        assert(event.seat === deal.phase.leader, 'lead by a non-leader');
        return withDeal(state, {
          ...deal,
          hands,
          phase: {
            name: 'follow',
            leader: event.seat,
            plays: [{ seat: event.seat, card: event.card }],
          },
        });
      }
      const ph = requirePhase(deal, 'follow');
      const last = ph.plays[ph.plays.length - 1];
      assert(last && event.seat === nextSeat(last.seat), 'cardPlayed out of turn order');
      assert(ph.plays.length < 4, 'trick already has 4 cards');
      return withDeal(state, {
        ...deal,
        hands,
        phase: { ...ph, plays: [...ph.plays, { seat: event.seat, card: event.card }] },
      });
    }

    case 'trickWon': {
      const deal = requireDeal(state);
      const ph = requirePhase(deal, 'follow');
      assert(ph.plays.length === 4, 'trickWon on an incomplete trick');
      assert(event.trickIndex === deal.tricksPlayed, 'trickWon index mismatch');
      const winner = event.seat;
      return withDeal(state, {
        ...deal,
        captured: {
          ...deal.captured,
          [winner]: [...deal.captured[winner], ...ph.plays.map((p) => p.card)],
        },
        tricksWon: { ...deal.tricksWon, [winner]: deal.tricksWon[winner] + 1 },
        tricksPlayed: deal.tricksPlayed + 1,
        lastTrick: { plays: ph.plays, winner },
        phase: { name: 'lead', leader: winner, canDeclare: event.canDeclareNext },
      });
    }

    case 'dealScored': {
      const deal = requireDeal(state);
      assert(deal.tricksPlayed === 9, 'dealScored before 9 tricks');
      const { result } = event;
      return {
        ...state,
        scores: [
          state.scores[0] + result.sides[0].scoreDelta,
          state.scores[1] + result.sides[1].scoreDelta,
        ],
        deal: { ...deal, phase: { name: 'scored', result } },
      };
    }

    case 'matchEnded': {
      assert(state.winnerSide === null, 'match already ended');
      return { ...state, winnerSide: event.winnerSide };
    }
  }
}

/**
 * Returns the dealStarted event for the next deal given a shuffled deck:
 * the first deal and post-redeal deals keep dealer+dealIndex; after a scored
 * deal dealer=nextSeat(dealer) and dealIndex+1.
 */
export function nextDealEvent(state: MatchState, shuffledDeck: Card[]): GameEvent {
  assert(state.winnerSide === null, 'nextDealEvent after match end');
  assert(shuffledDeck.length === 36, 'shuffled deck must contain 36 cards');
  if (state.deal === null) {
    return {
      type: 'dealStarted',
      dealIndex: state.dealIndex,
      dealer: state.dealer,
      deck: [...shuffledDeck],
    };
  }
  assert(state.deal.phase.name === 'scored', 'nextDealEvent mid-deal');
  return {
    type: 'dealStarted',
    dealIndex: state.dealIndex + 1,
    dealer: nextSeat(state.dealer),
    deck: [...shuffledDeck],
  };
}
