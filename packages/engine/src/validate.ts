/**
 * Action validation and legality hints. validateAction never throws; illegal
 * actions come back as RuleError values (codes are stable i18n keys). A valid
 * action returns its FULL consequence chain: validateAction applies each event
 * internally as it goes, so e.g. the last playCard of the last trick emits
 * [cardPlayed, trickWon, dealScored, matchEnded?] in one call, and the bid
 * that ends a 2-3p auction emits [bidPlaced, biddingEnded, talonTaken].
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
  DealResult,
  DealState,
  DeclarationHow,
  GameEvent,
  MatchState,
  PlayerAction,
  RuleError,
  Seat,
  Side,
  Suit,
  TrickPlay,
} from './types.js';
import { activeSeats, nextSeat, partnerOf, SUITS, sideOf, tricksPerDeal } from './types.js';

function err(code: string, params?: Record<string, string | number>): RuleError {
  return params ? { error: true, code, params } : { error: true, code };
}

function isExchangePhase(name: DealPhase['name']): boolean {
  return (
    name === 'exchangeGive' ||
    name === 'exchangeDiscard' ||
    name === 'exchangeContract' ||
    name === 'exchangeReturn'
  );
}

/** Whether `seat`'s cards currently satisfy config.redealCondition. */
function redealHandEligible(state: MatchState, deal: DealState, seat: Seat): boolean {
  const cfg = state.config;
  if (cfg.redealCondition === null) return false;
  if (cfg.redealCondition === 'fourSixes') {
    // 4p: the PAIR's combined hands count (illisoft spec §3).
    const cards =
      cfg.players === 4 ? [...deal.hands[seat], ...deal.hands[partnerOf(seat)]] : deal.hands[seat];
    return cards.filter((c) => rankOf(c) === '6').length === 4;
  }
  const hand = deal.hands[seat];
  const sixes = hand.filter((c) => rankOf(c) === '6').length;
  const nothingAboveJack = hand.every((c) => rankIndex(rankOf(c)) >= rankIndex('J'));
  return sixes >= 3 || nothingAboveJack;
}

/** Highest legal bid amount (config.maxBid or the theoretical deal maximum). */
function maxBidOf(cfg: RuleConfig): number {
  return cfg.maxBid ?? theoreticalMaxPoints(cfg);
}

/**
 * Lowest legal opening bid: config.minBid rounded UP to the next bidStep
 * multiple. Rules doc §5.2 requires every bid to be a bidStep multiple, but
 * RuleConfig (and the lobby config patch) admit a minBid that is not one
 * (e.g. 52 with step 5). Using raw cfg.minBid as the forced-opening amount
 * would advertise an un-biddable hint minimum and — combined with the bid
 * ban, whose only exception is the forced opening — soft-lock the deal with
 * zero legal actions. All forced-opening/hint logic must use this value.
 */
function minBidOf(cfg: RuleConfig): number {
  return Math.ceil(cfg.minBid / cfg.bidStep) * cfg.bidStep;
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
  return t !== null && (state.scores[sideOf(seat, state.config.players)] ?? 0) <= t;
}

/** Active seats participating in the current bidding round. */
function eligibleBidders(
  cfg: RuleConfig,
  ph: Extract<DealPhase, { name: 'bidding' }>,
): readonly Seat[] {
  return activeSeats(cfg.players).filter((s) => !ph.excluded.includes(s));
}

/**
 * True when `seat` must open the bidding at >= minBid and may not pass:
 * the configured forced opener before any bid, or (allPassOutcome
 * 'forceLastSeat') the last eligible unpassed seat when everyone else passed
 * without a bid — the deal must get a declarer.
 */
function mustOpen(
  state: MatchState,
  ph: Extract<DealPhase, { name: 'bidding' }>,
  seat: Seat,
): boolean {
  if (ph.highBid !== null) return false;
  const cfg = state.config;
  if (cfg.forcedOpening && seat === firstBidderOf(state.dealer, cfg)) return true;
  if (cfg.allPassOutcome !== 'forceLastSeat') return false;
  return eligibleBidders(cfg, ph).every((s) => s === seat || ph.passed.includes(s));
}

function trumpSetEvent(suit: Suit, seat: Seat, how: DeclarationHow, cfg: RuleConfig): GameEvent {
  return {
    type: 'trumpSet',
    suit,
    seat,
    side: sideOf(seat, cfg.players),
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

/** biddingEnded plus, for 2-3p, the automatic talon take opening the discard phase. */
function biddingEndedEvents(cfg: RuleConfig, declarer: Seat, amount: number): GameEvent[] {
  const events: GameEvent[] = [{ type: 'biddingEnded', declarer, amount }];
  if (cfg.players !== 4) events.push({ type: 'talonTaken', seat: declarer });
  return events;
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
    if (
      cfg.redealCondition === null ||
      ph.firstTurnTaken.includes(seat) ||
      !redealHandEligible(state, deal, seat)
    ) {
      return err('error.redealNotEligible');
    }
    return [{ type: 'redealDemanded', seat }];
  }

  const eligible = eligibleBidders(cfg, ph);

  if (action.type === 'pass') {
    if (mustOpen(state, ph, seat)) return err('error.forcedOpening', { min: minBidOf(cfg) });
    const events: GameEvent[] = [{ type: 'passed', seat }];
    const passedAfter = ph.passed.includes(seat) ? ph.passed.length : ph.passed.length + 1;
    if (ph.highBid !== null) {
      if (passedAfter >= eligible.length - 1) {
        events.push(...biddingEndedEvents(cfg, ph.highBid.seat, ph.highBid.amount));
      }
    } else if (passedAfter >= eligible.length) {
      // Nobody bid and every eligible seat passed.
      if (ph.excluded.length > 0) {
        events.push({ type: 'biddingReopened', seats: [...ph.excluded] });
      } else {
        // Only reachable with allPassOutcome 'contractlessDeal' (mustOpen
        // forces the last seat otherwise).
        events.push({ type: 'allPassed' });
      }
    }
    return events;
  }

  const { amount } = action;
  // Päämuoto bid ban: the forced opening is the banned side's only legal bid.
  // With bidBanReopen banned seats never hold the turn (or nobody is banned).
  if (
    !cfg.bidBanReopen &&
    bidBanned(state, seat) &&
    !(mustOpen(state, ph, seat) && amount === minBidOf(cfg))
  ) {
    return err('error.bidBanned');
  }
  if (amount % cfg.bidStep !== 0) return err('error.bidNotMultiple', { step: cfg.bidStep });
  const min = ph.highBid === null ? minBidOf(cfg) : ph.highBid.amount + cfg.bidStep;
  if (amount < min) return err('error.bidTooLow', { min });
  if (amount > maxBidOf(cfg)) return err('error.bidTooHigh', { max: maxBidOf(cfg) });

  const events: GameEvent[] = [{ type: 'bidPlaced', seat, amount }];
  // Reaching maxBid ends bidding immediately; so does a bid when every other
  // eligible seat has already passed.
  if ((cfg.maxBid !== null && amount >= cfg.maxBid) || ph.passed.length >= eligible.length - 1) {
    events.push(...biddingEndedEvents(cfg, seat, amount));
  }
  return events;
}

/** RuleError if `seat` may not declare from its own hand (ask lockouts), else null. */
function declareOwnLock(deal: DealState, seat: Seat, cfg: RuleConfig): RuleError | null {
  if (cfg.askLockouts === 'illisoft') {
    const halfLocked =
      deal.askedHalf[seat] || (cfg.players === 4 && deal.askedHalf[partnerOf(seat)]);
    return deal.askedWhole[seat] || halfLocked ? err('error.declarationLocked') : null;
  }
  return deal.askedWhole[seat] ? err('error.askedWholeLock') : null;
}

/** RuleError if `seat` may not ask a whole (4p ask lockouts), else null. */
function askWholeLock(deal: DealState, seat: Seat, cfg: RuleConfig): RuleError | null {
  if (cfg.askLockouts === 'illisoft') {
    return deal.askedHalf[seat] || deal.askedHalf[partnerOf(seat)]
      ? err('error.declarationLocked')
      : null;
  }
  return deal.askedWhole[partnerOf(seat)] ? err('error.askedWholeLock') : null;
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
    const lock = declareOwnLock(deal, seat, cfg);
    if (lock) return lock;
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
    if (cfg.players !== 4) return err('error.noPartner');
    const lock = askWholeLock(deal, seat, cfg);
    if (lock) return lock;
    const partner = partnerOf(seat);
    const options = declarableSuits(deal.hands[partner], declared);
    const events: GameEvent[] = [{ type: 'askedWhole', seat }];
    const only = options[0];
    if (options.length === 0) {
      events.push({ type: 'answeredWhole', seat: partner, suit: null });
    } else if (options.length === 1 && only) {
      events.push({ type: 'answeredWhole', seat: partner, suit: only });
      // ohje 587: a whole-ask trump is credited to the seat that HELD the
      // marriage (the partner), not the asker.
      events.push(trumpSetEvent(only, partner, 'wholeAsk', cfg));
    }
    // 2+ declarable marriages: the partner chooses (awaitWholeAnswer phase).
    return events;
  }

  // askHalf
  if (cfg.players !== 4) return err('error.noPartner');
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

/** 'aceShow' when the first-trick constraints apply to plays right now. */
function firstTrickModeOf(state: MatchState, deal: DealState): 'aceShow' | 'free' {
  return state.config.firstTrickRules === 'aceShow' && deal.tricksPlayed === 0 ? 'aceShow' : 'free';
}

/** The exact RuleError for a card outside legalPlays (reason derivation). */
function playError(
  hand: readonly Card[],
  plays: readonly TrickPlay[],
  trump: Suit | null,
  card: Card,
  firstTrick: 'aceShow' | 'free',
): RuleError {
  const first = plays[0];
  if (!first) {
    // Leads are only ever constrained by the first-trick ace/spade rule.
    if (firstTrick === 'aceShow') {
      if (hand.some((c) => rankOf(c) === 'A')) return err('error.mustLeadAce');
      if (hand.some((c) => suitOf(c) === 'S')) return err('error.mustLeadSpade');
    }
    return err('error.notInPhase'); // unreachable: free leads are unconstrained
  }
  const led = suitOf(first.card);
  if (
    firstTrick === 'aceShow' &&
    rankOf(first.card) !== 'A' &&
    hand.includes(makeCard(led, 'A')) &&
    card !== makeCard(led, 'A')
  ) {
    return err('error.aceMustShow');
  }
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

/** The winning side after a scored deal, or null to keep playing. */
function matchWinner(state: MatchState, result: DealResult): Side | null {
  const cfg = state.config;
  const target = cfg.winTarget;
  const crossed: Side[] = [];
  state.scores.forEach((score, i) => {
    if (cfg.winCondition === 'reach' ? score >= target : score > target) crossed.push(i as Side);
  });
  if (crossed.length === 0) return null;
  if (crossed.length === 1) return crossed[0] ?? null;
  // Several sides crossed in the same deal.
  const declarerSide = result.declarer === null ? null : sideOf(result.declarer, cfg.players);
  if (cfg.winTiebreak === 'declarer' && declarerSide !== null && crossed.includes(declarerSide)) {
    return declarerSide;
  }
  const top = Math.max(...crossed.map((s) => state.scores[s] ?? 0));
  const tops = crossed.filter((s) => (state.scores[s] ?? 0) === top);
  // An exact tie at the top means another deal is played.
  return tops.length === 1 ? (tops[0] ?? null) : null;
}

function validatePlay(
  state: MatchState,
  deal: DealState,
  seat: Seat,
  card: Card,
): GameEvent[] | RuleError {
  const cfg = state.config;
  const ph = deal.phase;
  if (ph.name !== 'lead' && ph.name !== 'follow') return err('error.notInPhase');
  if (expectedActor(state) !== seat) return err('error.notYourTurn');
  const hand = deal.hands[seat];
  if (!hand.includes(card)) return err('error.cardNotInHand', { card });
  const plays = ph.name === 'lead' ? [] : ph.plays;
  const firstTrick = firstTrickModeOf(state, deal);
  const legal = legalPlays(hand, plays, deal.trump, firstTrick);
  if (!legal.includes(card)) return playError(hand, plays, deal.trump, card, firstTrick);

  const events: GameEvent[] = [{ type: 'cardPlayed', seat, card }];
  if (plays.length < cfg.players - 1) return events;

  // Last card of the trick: resolve it.
  const leader = ph.name === 'lead' ? seat : ph.leader;
  const allPlays: TrickPlay[] = [...plays, { seat, card }];
  const winner = winningPlay(allPlays, deal.trump).seat;
  const trickIndex = deal.tricksPlayed;
  const lastIndex = tricksPerDeal(cfg) - 1;
  const canDeclareNext =
    trickIndex < lastIndex && (cfg.declareRight === 'anyWonTrick' || winner === leader);
  events.push({ type: 'trickWon', seat: winner, trickIndex, canDeclareNext });
  if (trickIndex < lastIndex) return events;

  // Final trick: score the deal, possibly end the match.
  let cur = state;
  for (const e of events) cur = applyEvent(cur, e);
  const scoredDeal = cur.deal;
  if (!scoredDeal) return err('error.notInPhase'); // unreachable
  const result = scoreDeal(scoredDeal, cfg);
  events.push({ type: 'dealScored', result });
  cur = applyEvent(cur, { type: 'dealScored', result });
  const winnerSide = matchWinner(cur, result);
  if (winnerSide !== null) events.push({ type: 'matchEnded', winnerSide });
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
  const cfg = state.config;

  switch (action.type) {
    case 'bid':
    case 'pass': {
      if (ph.name !== 'bidding') return err('error.notInPhase');
      if (ph.turn !== seat) return err('error.notYourTurn');
      return validateBidTurn(state, deal, ph, seat, action);
    }

    case 'demandRedeal': {
      if (ph.name === 'bidding') {
        if (ph.turn !== seat) return err('error.notYourTurn');
        return validateBidTurn(state, deal, ph, seat, action);
      }
      if (isExchangePhase(ph.name) && cfg.redealWindow === 'bidAndExchange') {
        if (expectedActor(state) !== seat) return err('error.notYourTurn');
        if (cfg.redealCondition === null || !redealHandEligible(state, deal, seat)) {
          return err('error.redealNotEligible');
        }
        return [{ type: 'redealDemanded', seat }];
      }
      return err('error.notInPhase');
    }

    case 'giveCards': {
      if (ph.name !== 'exchangeGive') return err('error.notInPhase');
      const declarer = deal.declarer;
      if (declarer === null || seat !== partnerOf(declarer)) return err('error.notYourTurn');
      const bad = checkCardSet(deal.hands[seat], action.cards, cfg.exchangeCount);
      if (bad) return bad;
      return [{ type: 'cardsGiven', from: seat, to: declarer, cards: [...action.cards] }];
    }

    case 'discardCards': {
      if (ph.name !== 'exchangeDiscard') return err('error.notInPhase');
      if (seat !== deal.declarer) return err('error.notYourTurn');
      const bad = checkCardSet(deal.hands[seat], action.cards, cfg.talonSize);
      if (bad) return bad;
      for (const c of action.cards) {
        const r = rankOf(c);
        if (r === 'A' || r === '10') return err('error.cannotDiscardAceOrTen', { card: c });
      }
      return [{ type: 'cardsDiscarded', seat, cards: [...action.cards] }];
    }

    case 'setContract': {
      if (ph.name !== 'exchangeContract') return err('error.notInPhase');
      if (seat !== deal.declarer) return err('error.notYourTurn');
      const { amount } = action;
      const min = deal.bid?.amount ?? minBidOf(cfg);
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
      const bad = checkCardSet(deal.hands[seat], action.cards, cfg.exchangeCount);
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
        // ohje 587: credit the whole-ask trump to the marriage HOLDER (the
        // answering partner `seat`), not the asker (`ph.leader`).
        trumpSetEvent(action.suit, seat, 'wholeAsk', cfg),
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
    case 'exchangeDiscard':
    case 'exchangeContract':
    case 'exchangeReturn':
      return deal.declarer;
    case 'lead':
      return ph.leader;
    case 'awaitWholeAnswer':
      return partnerOf(ph.leader);
    case 'follow': {
      const last = ph.plays[ph.plays.length - 1];
      return last ? nextSeat(last.seat, state.config.players) : ph.leader;
    }
    case 'scored':
      return null;
  }
}

/** Appends a demandRedeal hint during exchange phases when the window allows it. */
function withRedealHint(
  state: MatchState,
  deal: DealState,
  seat: Seat,
  hints: ActionHint[],
): ActionHint[] {
  if (
    state.config.redealWindow === 'bidAndExchange' &&
    state.config.redealCondition !== null &&
    redealHandEligible(state, deal, seat)
  ) {
    hints.push({ type: 'demandRedeal' });
  }
  return hints;
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
      let min = ph.highBid === null ? minBidOf(cfg) : ph.highBid.amount + cfg.bidStep;
      let max = maxBidOf(cfg);
      let canPass = !forced;
      if (!cfg.bidBanReopen && bidBanned(state, seat)) {
        if (forced) {
          // The forced opening is the banned side's only legal bid.
          min = minBidOf(cfg);
          max = minBidOf(cfg);
        } else {
          // No legal bid at all: min > max signals "pass (or redeal) only".
          max = min - cfg.bidStep;
          canPass = true;
        }
      }
      const canDemandRedeal =
        cfg.redealCondition !== null &&
        !ph.firstTurnTaken.includes(seat) &&
        redealHandEligible(state, deal, seat);
      return [{ type: 'bid', min, max, step: cfg.bidStep, canPass, canDemandRedeal, forced }];
    }

    case 'exchangeGive':
      return withRedealHint(state, deal, seat, [{ type: 'giveCards', count: cfg.exchangeCount }]);

    case 'exchangeDiscard': {
      const legal = deal.hands[seat].filter((c) => rankOf(c) !== 'A' && rankOf(c) !== '10');
      return withRedealHint(state, deal, seat, [
        { type: 'discardCards', count: cfg.talonSize, legal },
      ]);
    }

    case 'exchangeContract':
      return withRedealHint(state, deal, seat, [
        {
          type: 'setContract',
          min: deal.bid?.amount ?? minBidOf(cfg),
          max: maxContractOf(cfg),
          step: cfg.bidStep,
        },
      ]);

    case 'exchangeReturn':
      return withRedealHint(state, deal, seat, [{ type: 'returnCards', count: cfg.exchangeCount }]);

    case 'lead': {
      const hints: ActionHint[] = [];
      if (ph.canDeclare) {
        const declared = deal.declarations.map((d) => d.suit);
        const hand = deal.hands[seat];
        const ownSuits = declareOwnLock(deal, seat, cfg) ? [] : declarableSuits(hand, declared);
        const canAskWhole = cfg.players === 4 && askWholeLock(deal, seat, cfg) === null;
        const halfAsks: Array<{ suit: Suit; rankHeld: 'K' | 'Q' }> = [];
        if (cfg.players === 4) {
          for (const s of SUITS) {
            if (declared.includes(s)) continue;
            for (const r of ['K', 'Q'] as const) {
              if (!cfg.askHalfMustHoldCard || hand.includes(makeCard(s, r))) {
                halfAsks.push({ suit: s, rankHeld: r });
              }
            }
          }
        }
        if (ownSuits.length > 0 || canAskWhole || halfAsks.length > 0) {
          hints.push({ type: 'declaration', ownSuits, canAskWhole, halfAsks });
        }
      }
      hints.push({
        type: 'playCard',
        legal: legalPlays(deal.hands[seat], [], deal.trump, firstTrickModeOf(state, deal)),
      });
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
      return [
        {
          type: 'playCard',
          legal: legalPlays(deal.hands[seat], ph.plays, deal.trump, firstTrickModeOf(state, deal)),
        },
      ];

    case 'scored':
      return [];
  }
}
