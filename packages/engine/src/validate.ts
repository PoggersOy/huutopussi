/**
 * Action validation and legality hints. validateAction never throws; illegal
 * actions come back as RuleError values (codes are stable i18n keys). A valid
 * action returns its FULL consequence chain: validateAction applies each event
 * internally as it goes, so e.g. the 4th playCard of the 9th trick emits
 * [cardPlayed, trickWon, dealScored, matchEnded?] in one call.
 */

import type { RuleConfig } from './config.js';
import { theoreticalMaxPoints } from './config.js';
import { makeCard, marriageValue, rankIndex, rankOf, suitOf, winningPlay } from './deck.js';
import { declarableSuits, legalPlays } from './legality.js';
import { applyEvent, firstBidderOf } from './reduce.js';
import { scoreDeal } from './scoring.js';
import type {
  ActionHint,
  Card,
  DealPhase,
  DealState,
  DeclarationHow,
  GameEvent,
  MatchState,
  PlayerAction,
  RuleError,
  Seat,
  Suit,
  TrickPlay,
} from './types.js';
import { nextSeat, partnerOf, SUITS, sideOf } from './types.js';

function err(code: string, params?: Record<string, string | number>): RuleError {
  return params ? { error: true, code, params } : { error: true, code };
}

function redealEligible(hand: readonly Card[]): boolean {
  const sixes = hand.filter((c) => rankOf(c) === '6').length;
  const nothingAboveJack = hand.every((c) => rankIndex(rankOf(c)) >= rankIndex('J'));
  return sixes >= 3 || nothingAboveJack;
}

/** Highest legal bid amount (config.maxBid or the theoretical deal maximum). */
function maxBidOf(cfg: RuleConfig): number {
  return cfg.maxBid ?? theoreticalMaxPoints(cfg);
}

/**
 * Highest legal contract. Rules doc §5.3 only requires a contract to be a
 * bidStep multiple at least the winning bid, so the cap must track the bid cap
 * (maxBid, or theoreticalMaxPoints when unbounded): any winning bid — e.g. 440
 * under cardPoints 'A', where theoreticalMaxPoints is only 410 — must always
 * admit a legal contract, else the deal soft-locks in exchangeContract.
 */
function maxContractOf(cfg: RuleConfig): number {
  return maxBidOf(cfg);
}

function bidBanned(state: MatchState, seat: Seat): boolean {
  const t = state.config.bidBanThreshold;
  return t !== null && state.scores[sideOf(seat)] <= t;
}

/**
 * True when `seat` must open the bidding at >= minBid and may not pass:
 * the configured forced opener before any bid, or the last unpassed seat
 * when everyone else passed without a bid (the deal must get a declarer).
 */
function mustOpen(
  state: MatchState,
  ph: Extract<DealPhase, { name: 'bidding' }>,
  seat: Seat,
): boolean {
  if (ph.highBid !== null) return false;
  if (state.config.forcedOpening && seat === firstBidderOf(state.dealer, state.config)) {
    return true;
  }
  return ph.passed.length === 3;
}

function trumpSetEvent(suit: Suit, seat: Seat, how: DeclarationHow, cfg: RuleConfig): GameEvent {
  return {
    type: 'trumpSet',
    suit,
    seat,
    side: sideOf(seat),
    how,
    points: marriageValue(suit, cfg),
  };
}

/** Checks a distinct card set of exactly `count` cards, all present in `hand`. */
function checkCardSet(
  hand: readonly Card[],
  cards: readonly Card[],
  count: number,
): RuleError | null {
  if (cards.length !== count) return err('error.wrongCardCount', { expected: count });
  const remaining = [...hand];
  for (const c of cards) {
    const i = remaining.indexOf(c);
    if (i < 0) return err('error.cardNotInHand', { card: c });
    remaining.splice(i, 1);
  }
  return null;
}

function validateBidTurn(
  state: MatchState,
  deal: DealState,
  ph: Extract<DealPhase, { name: 'bidding' }>,
  seat: Seat,
  action: Extract<PlayerAction, { type: 'bid' | 'pass' | 'demandRedeal' }>,
): GameEvent[] | RuleError {
  const cfg = state.config;

  if (action.type === 'demandRedeal') {
    if (!cfg.redealRule || ph.firstTurnTaken.includes(seat) || !redealEligible(deal.hands[seat])) {
      return err('error.redealNotEligible');
    }
    return [{ type: 'redealDemanded', seat }];
  }

  if (action.type === 'pass') {
    if (mustOpen(state, ph, seat)) return err('error.forcedOpening', { min: cfg.minBid });
    const events: GameEvent[] = [{ type: 'passed', seat }];
    if (ph.highBid !== null && ph.passed.length + 1 >= 3) {
      events.push({
        type: 'biddingEnded',
        declarer: ph.highBid.seat,
        amount: ph.highBid.amount,
      });
    }
    return events;
  }

  const { amount } = action;
  if (bidBanned(state, seat) && !(mustOpen(state, ph, seat) && amount === cfg.minBid)) {
    return err('error.bidBanned');
  }
  if (amount % cfg.bidStep !== 0) return err('error.bidNotMultiple', { step: cfg.bidStep });
  const min = ph.highBid === null ? cfg.minBid : ph.highBid.amount + cfg.bidStep;
  if (amount < min) return err('error.bidTooLow', { min });
  if (amount > maxBidOf(cfg)) return err('error.bidTooHigh', { max: maxBidOf(cfg) });

  const events: GameEvent[] = [{ type: 'bidPlaced', seat, amount }];
  // Reaching maxBid ends bidding immediately; so does a bid after 3 passes.
  if ((cfg.maxBid !== null && amount >= cfg.maxBid) || ph.passed.length >= 3) {
    events.push({ type: 'biddingEnded', declarer: seat, amount });
  }
  return events;
}

function validateDeclaration(
  state: MatchState,
  deal: DealState,
  seat: Seat,
  action: Extract<PlayerAction, { type: 'declareOwn' | 'askWhole' | 'askHalf' }>,
): GameEvent[] | RuleError {
  const cfg = state.config;
  const declared = deal.declarations.map((d) => d.suit);
  const hand = deal.hands[seat];

  if (action.type === 'declareOwn') {
    if (deal.askedWhole[seat]) return err('error.askedWholeLock');
    if (declared.includes(action.suit)) return err('error.suitAlreadyDeclared');
    if (!hand.includes(makeCard(action.suit, 'K')) || !hand.includes(makeCard(action.suit, 'Q'))) {
      return err('error.noMarriageInHand');
    }
    return [
      { type: 'declaredOwn', seat, suit: action.suit },
      trumpSetEvent(action.suit, seat, 'own', cfg),
    ];
  }

  if (action.type === 'askWhole') {
    const partner = partnerOf(seat);
    if (deal.askedWhole[partner]) return err('error.askedWholeLock');
    const options = declarableSuits(deal.hands[partner], declared);
    const events: GameEvent[] = [{ type: 'askedWhole', seat }];
    const only = options[0];
    if (options.length === 0) {
      events.push({ type: 'answeredWhole', seat: partner, suit: null });
    } else if (options.length === 1 && only) {
      events.push({ type: 'answeredWhole', seat: partner, suit: only });
      events.push(trumpSetEvent(only, seat, 'wholeAsk', cfg));
    }
    // 2+ declarable marriages: the partner chooses (awaitWholeAnswer phase).
    return events;
  }

  // askHalf
  if (declared.includes(action.suit)) return err('error.suitAlreadyDeclared');
  if (cfg.askHalfMustHoldCard && !hand.includes(makeCard(action.suit, action.rankHeld))) {
    return err('error.notHoldingHalf');
  }
  const partner = partnerOf(seat);
  const complement = action.rankHeld === 'K' ? 'Q' : 'K';
  const yes = deal.hands[partner].includes(makeCard(action.suit, complement));
  const events: GameEvent[] = [
    { type: 'askedHalf', seat, suit: action.suit, rankHeld: action.rankHeld },
    { type: 'answeredHalf', seat: partner, yes },
  ];
  if (yes) events.push(trumpSetEvent(action.suit, seat, 'halfAsk', cfg));
  return events;
}

/** The exact RuleError for a card outside legalPlays (reason derivation). */
function playError(
  hand: readonly Card[],
  plays: readonly TrickPlay[],
  trump: Suit | null,
  card: Card,
): RuleError {
  const first = plays[0];
  if (!first) return err('error.notInPhase'); // unreachable: leads are unconstrained
  const led = suitOf(first.card);
  if (hand.some((c) => suitOf(c) === led)) {
    if (suitOf(card) !== led) return err('error.mustFollowSuit', { suit: led });
    return err('error.mustHeadTrick');
  }
  if (trump !== null && hand.some((c) => suitOf(c) === trump)) {
    if (suitOf(card) !== trump) return err('error.mustTrump', { suit: trump });
    return err('error.mustOvertrump');
  }
  return err('error.notInPhase'); // unreachable: void + no trump plays anything
}

function validatePlay(
  state: MatchState,
  deal: DealState,
  seat: Seat,
  card: Card,
): GameEvent[] | RuleError {
  const ph = deal.phase;
  if (ph.name !== 'lead' && ph.name !== 'follow') return err('error.notInPhase');
  if (expectedActor(state) !== seat) return err('error.notYourTurn');
  const hand = deal.hands[seat];
  if (!hand.includes(card)) return err('error.cardNotInHand', { card });
  const plays = ph.name === 'lead' ? [] : ph.plays;
  const legal = legalPlays(hand, plays, deal.trump);
  if (!legal.includes(card)) return playError(hand, plays, deal.trump, card);

  const events: GameEvent[] = [{ type: 'cardPlayed', seat, card }];
  if (plays.length < 3) return events;

  // 4th card: resolve the trick.
  const leader = ph.name === 'lead' ? seat : ph.leader;
  const allPlays: TrickPlay[] = [...plays, { seat, card }];
  const winner = winningPlay(allPlays, deal.trump).seat;
  const trickIndex = deal.tricksPlayed;
  const canDeclareNext =
    trickIndex < 8 && (state.config.declareRight === 'anyWonTrick' || winner === leader);
  events.push({ type: 'trickWon', seat: winner, trickIndex, canDeclareNext });
  if (trickIndex < 8) return events;

  // 9th trick: score the deal, possibly end the match.
  let cur = state;
  for (const e of events) cur = applyEvent(cur, e);
  const scoredDeal = cur.deal;
  if (!scoredDeal) return err('error.notInPhase'); // unreachable
  const result = scoreDeal(scoredDeal, state.config);
  events.push({ type: 'dealScored', result });
  cur = applyEvent(cur, { type: 'dealScored', result });
  const [s0, s1] = cur.scores;
  const target = state.config.winTarget;
  if ((s0 >= target || s1 >= target) && s0 !== s1) {
    events.push({ type: 'matchEnded', winnerSide: s0 > s1 ? 0 : 1 });
  }
  return events;
}

/** Validates `action` by `seat`; returns the resulting events or a RuleError. */
export function validateAction(
  state: MatchState,
  seat: Seat,
  action: PlayerAction,
): GameEvent[] | RuleError {
  if (state.winnerSide !== null || state.deal === null) return err('error.notInPhase');
  const deal = state.deal;
  const ph = deal.phase;

  switch (action.type) {
    case 'bid':
    case 'pass':
    case 'demandRedeal': {
      if (ph.name !== 'bidding') return err('error.notInPhase');
      if (ph.turn !== seat) return err('error.notYourTurn');
      return validateBidTurn(state, deal, ph, seat, action);
    }

    case 'giveCards': {
      if (ph.name !== 'exchangeGive') return err('error.notInPhase');
      const declarer = deal.declarer;
      if (declarer === null || seat !== partnerOf(declarer)) return err('error.notYourTurn');
      const bad = checkCardSet(deal.hands[seat], action.cards, state.config.exchangeCount);
      if (bad) return bad;
      return [{ type: 'cardsGiven', from: seat, to: declarer, cards: [...action.cards] }];
    }

    case 'setContract': {
      if (ph.name !== 'exchangeContract') return err('error.notInPhase');
      if (seat !== deal.declarer) return err('error.notYourTurn');
      const cfg = state.config;
      const { amount } = action;
      const min = deal.bid?.amount ?? cfg.minBid;
      if (amount % cfg.bidStep !== 0) {
        return err('error.contractNotMultiple', { step: cfg.bidStep });
      }
      if (amount < min) return err('error.contractTooLow', { min });
      if (amount > maxContractOf(cfg)) {
        return err('error.contractTooHigh', { max: maxContractOf(cfg) });
      }
      return [{ type: 'contractSet', seat, amount }];
    }

    case 'returnCards': {
      if (ph.name !== 'exchangeReturn') return err('error.notInPhase');
      if (seat !== deal.declarer) return err('error.notYourTurn');
      const bad = checkCardSet(deal.hands[seat], action.cards, state.config.exchangeCount);
      if (bad) return bad;
      return [{ type: 'cardsReturned', from: seat, to: partnerOf(seat), cards: [...action.cards] }];
    }

    case 'declareOwn':
    case 'askWhole':
    case 'askHalf': {
      if (ph.name !== 'lead') return err('error.notInPhase');
      if (ph.leader !== seat) return err('error.notYourTurn');
      if (!ph.canDeclare) return err('error.declarationUsed');
      return validateDeclaration(state, deal, seat, action);
    }

    case 'answerWhole': {
      if (ph.name !== 'awaitWholeAnswer') return err('error.notInPhase');
      if (seat !== partnerOf(ph.leader)) return err('error.notYourTurn');
      const declared = deal.declarations.map((d) => d.suit);
      if (declared.includes(action.suit)) return err('error.suitAlreadyDeclared');
      if (!declarableSuits(deal.hands[seat], declared).includes(action.suit)) {
        return err('error.noMarriageInHand');
      }
      return [
        { type: 'answeredWhole', seat, suit: action.suit },
        trumpSetEvent(action.suit, ph.leader, 'wholeAsk', state.config),
      ];
    }

    case 'playCard':
      return validatePlay(state, deal, seat, action.card);
  }
}

/** The seat expected to act now, or null when no player action is pending. */
export function expectedActor(state: MatchState): Seat | null {
  if (state.winnerSide !== null || state.deal === null) return null;
  const deal = state.deal;
  const ph = deal.phase;
  switch (ph.name) {
    case 'bidding':
      return ph.turn;
    case 'exchangeGive':
      return deal.declarer === null ? null : partnerOf(deal.declarer);
    case 'exchangeContract':
    case 'exchangeReturn':
      return deal.declarer;
    case 'lead':
      return ph.leader;
    case 'awaitWholeAnswer':
      return partnerOf(ph.leader);
    case 'follow': {
      const last = ph.plays[ph.plays.length - 1];
      return last ? nextSeat(last.seat) : ph.leader;
    }
    case 'scored':
      return null;
  }
}

/** Server-computed legality hints for `seat` (empty when not their turn). */
export function allowedActions(state: MatchState, seat: Seat): ActionHint[] {
  if (state.deal === null || expectedActor(state) !== seat) return [];
  const deal = state.deal;
  const ph = deal.phase;
  const cfg = state.config;

  switch (ph.name) {
    case 'bidding': {
      const forced = mustOpen(state, ph, seat);
      let min = ph.highBid === null ? cfg.minBid : ph.highBid.amount + cfg.bidStep;
      let max = maxBidOf(cfg);
      let canPass = !forced;
      if (bidBanned(state, seat)) {
        if (forced) {
          // The forced opening is the banned side's only legal bid.
          min = cfg.minBid;
          max = cfg.minBid;
        } else {
          // No legal bid at all: min > max signals "pass (or redeal) only".
          max = min - cfg.bidStep;
          canPass = true;
        }
      }
      const canDemandRedeal =
        cfg.redealRule && !ph.firstTurnTaken.includes(seat) && redealEligible(deal.hands[seat]);
      return [{ type: 'bid', min, max, step: cfg.bidStep, canPass, canDemandRedeal, forced }];
    }

    case 'exchangeGive':
      return [{ type: 'giveCards', count: cfg.exchangeCount }];

    case 'exchangeContract':
      return [
        {
          type: 'setContract',
          min: deal.bid?.amount ?? cfg.minBid,
          max: maxContractOf(cfg),
          step: cfg.bidStep,
        },
      ];

    case 'exchangeReturn':
      return [{ type: 'returnCards', count: cfg.exchangeCount }];

    case 'lead': {
      const hints: ActionHint[] = [];
      if (ph.canDeclare) {
        const declared = deal.declarations.map((d) => d.suit);
        const hand = deal.hands[seat];
        const ownSuits = deal.askedWhole[seat] ? [] : declarableSuits(hand, declared);
        const canAskWhole = !deal.askedWhole[partnerOf(seat)];
        const halfAsks: Array<{ suit: Suit; rankHeld: 'K' | 'Q' }> = [];
        for (const s of SUITS) {
          if (declared.includes(s)) continue;
          for (const r of ['K', 'Q'] as const) {
            if (!cfg.askHalfMustHoldCard || hand.includes(makeCard(s, r))) {
              halfAsks.push({ suit: s, rankHeld: r });
            }
          }
        }
        if (ownSuits.length > 0 || canAskWhole || halfAsks.length > 0) {
          hints.push({ type: 'declaration', ownSuits, canAskWhole, halfAsks });
        }
      }
      hints.push({ type: 'playCard', legal: legalPlays(deal.hands[seat], [], deal.trump) });
      return hints;
    }

    case 'awaitWholeAnswer':
      return [
        {
          type: 'answerWhole',
          suits: declarableSuits(
            deal.hands[seat],
            deal.declarations.map((d) => d.suit),
          ),
        },
      ];

    case 'follow':
      return [{ type: 'playCard', legal: legalPlays(deal.hands[seat], ph.plays, deal.trump) }];

    case 'scored':
      return [];
  }
}
