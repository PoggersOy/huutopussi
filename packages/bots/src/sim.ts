/**
 * Fuzz/simulation harness — the P2 gate (docs/plan.md): plays full random-bot
 * matches exclusively through the engine's public entry points and asserts
 * engine invariants after EVERY event application:
 *
 *   (a) 36 unique cards conserved across hands + captured + trick-in-progress
 *       + untaken talon + dummy hand + declarer discards
 *   (b) per-seat hand sizes consistent with the phase and mode (2/3/4
 *       players; talon pickup +talonSize and discard −talonSize; 4p exchange
 *       ±exchangeCount under both contractTiming orders; constant 2p dummy;
 *       contract-less deals skipping the exchange entirely)
 *   (c) trump never changes while a trick is in progress
 *   (d) each suit declared at most once per deal
 *   (e) dealScored: every SideBreakdown re-derived independently from the
 *       pre-score deal (captured card points, last-trick bonus, marriage and
 *       discard points, opponent rounding, −bid trickless opponents, declarer
 *       Porvoo scope/basis, the 2p läpäri top-up, contract-less no-penalty
 *       deals); match scores move by exactly the reported deltas (and never
 *       move on any other event); scores/sides arrays are sideCount long
 *   (f) no redacted view or event (active seats + spectator) contains a card
 *       hidden from that viewer — other hands, the dummy hand, the declarer's
 *       discards, the untaken talon — modulo the documented privy fields:
 *       the viewer's own hand, exchangeSeen for the 4p exchanging pair, the
 *       public open-talon window (avoin koini, trick 1 only), and the
 *       cardsDiscarded event to its own seat
 *   (g) replaying the collected event log from initialMatchState reproduces a
 *       deep-equal final state
 *   (h) hint/validate equivalence, probed exhaustively at every turn: all 36
 *       playCard candidates, bid/contract amounts at the hinted range edges
 *       ± step, every declaration option, exchange/discard card sets (incl.
 *       forbidden ace/ten discards), redeal demands, non-actor active seats
 *   (i) games terminate (maxDeals cap hits are counted, reported and fatal)
 *
 * Usage: pnpm sim -- --games 50000 --seed 1 [--maxDeals 60] [--offset 0]
 *                    [--bots random|heuristic|mixed]
 * Game i uses PRNG seed derived from (seed, offset+i). Configs rotate on
 * gameIndex mod 15 (see configFor): the päämuoto/B-points/bridge slots keep
 * their original mod-5 congruence classes (saved failure repros stay valid)
 * and five previously-default slots now run the illisoft modes (4p, 3p
 * talon3 open, 3p talon6 secret, 2p talon3 secret, 2p talon6 open).
 * --bots mixed seats HeuristicBots on side gameIndex%2 and RandomLegalBots
 * everywhere else and reports the average final match score per bot type
 * (multi-side modes average the random sides).
 * On violation the full event log is dumped to packages/bots/failures/ and
 * the process exits 1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ActionHint,
  activeSeats,
  allowedActions,
  applyEvent,
  type Card,
  DEFAULT_RULES,
  type DealResult,
  type DealState,
  expectedActor,
  type GameEvent,
  ILLISOFT_RULES,
  initialMatchState,
  isRuleError,
  type MatchState,
  makeDeck,
  nextDealEvent,
  type PlayerAction,
  partnerOf,
  type RuleConfig,
  redactEventFor,
  redactViewFor,
  SEATS,
  type Seat,
  SUITS,
  sideCount,
  sideOf,
  sumCardPoints,
  totalDealPoints,
  tricksPerDeal,
  validateAction,
} from '@hp/engine';
import { HeuristicBot } from './heuristic.js';
import { mulberry32, pickIndex, shuffle } from './prng.js';
import { RandomLegalBot } from './random.js';

type BotsMode = 'random' | 'heuristic' | 'mixed';

class Violation extends Error {}

function invariant(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Violation(`invariant: ${msg}`);
}

const ALL_CARDS: readonly Card[] = makeDeck();
const CARD_SET: ReadonlySet<string> = new Set(ALL_CARDS);
/** Matches any JSON-quoted card token, e.g. "H10", "SQ". */
const CARD_TOKEN_RE = /"([HDCS](?:10|[AKQJ6-9]))"/g;

function viewersOf(players: 2 | 3 | 4): ReadonlyArray<Seat | 'spectator'> {
  return [...activeSeats(players), 'spectator'];
}

/**
 * Alternate rule configs, derived deterministically from the game index.
 * The päämuoto/B-points/bridge entries keep the congruence classes of the
 * original mod-5 matrix (3→B, 4→bridge) so saved failure repros stay valid;
 * the illisoft modes occupy previously-default slots.
 */
function configFor(gameIndex: number): RuleConfig {
  switch (gameIndex % 15) {
    case 3:
    case 8:
    case 13:
      return { ...DEFAULT_RULES, cardPoints: 'B', lastTrickBonus: 20 };
    case 4:
    case 9:
    case 14:
      return { ...DEFAULT_RULES, trumpValues: 'bridge' };
    case 5:
      return ILLISOFT_RULES;
    case 6:
      return { ...ILLISOFT_RULES, players: 3, talonSize: 3, openTalon: true };
    case 7:
      return { ...ILLISOFT_RULES, players: 3, talonSize: 6, openTalon: false };
    case 10:
      return { ...ILLISOFT_RULES, players: 2, talonSize: 3, openTalon: false };
    case 11:
      return { ...ILLISOFT_RULES, players: 2, talonSize: 6, openTalon: true };
    default:
      return DEFAULT_RULES;
  }
}

// ── Invariants ────────────────────────────────────────────────────────────────

/** (b) Expected hand size per seat for the current phase, mode and exchange step. */
function checkHandSizes(deal: DealState, config: RuleConfig): void {
  const players = config.players;
  const active = activeSeats(players);
  const handSize = tricksPerDeal(config);
  const expected: Record<Seat, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const ph = deal.phase;
  const base = handSize - deal.tricksPlayed;
  switch (ph.name) {
    case 'bidding':
    case 'exchangeGive':
      for (const s of active) expected[s] = handSize;
      break;
    case 'exchangeDiscard': {
      // 2-3p only: +talonSize once the automatic talonTaken has landed.
      invariant(players !== 4, 'exchangeDiscard in a 4p deal');
      invariant(deal.declarer !== null, 'no declarer in phase exchangeDiscard');
      for (const s of active) expected[s] = handSize;
      if (deal.talonTakenBy !== null) expected[deal.declarer] += config.talonSize;
      break;
    }
    case 'exchangeContract': {
      invariant(deal.declarer !== null, 'no declarer in phase exchangeContract');
      for (const s of active) expected[s] = handSize;
      // 4p 'beforeReturn' sets the contract mid-exchange (give done, return
      // pending); 'afterExchange' and the 2-3p post-discard contract see
      // every hand back at handSize.
      if (players === 4 && config.contractTiming === 'beforeReturn') {
        expected[deal.declarer] = handSize + config.exchangeCount;
        expected[partnerOf(deal.declarer)] = handSize - config.exchangeCount;
      }
      break;
    }
    case 'exchangeReturn': {
      invariant(players === 4, 'exchangeReturn outside a 4p deal');
      invariant(deal.declarer !== null, 'no declarer in phase exchangeReturn');
      for (const s of active) expected[s] = handSize;
      expected[deal.declarer] = handSize + config.exchangeCount;
      expected[partnerOf(deal.declarer)] = handSize - config.exchangeCount;
      break;
    }
    case 'lead':
    case 'awaitWholeAnswer':
      for (const s of active) expected[s] = base;
      break;
    case 'follow': {
      for (const s of active) expected[s] = base;
      for (const p of ph.plays) expected[p.seat] = base - 1;
      break;
    }
    case 'scored':
      break; // every hand played out (expected stays 0)
  }
  for (const s of SEATS) {
    invariant(
      deal.hands[s].length === expected[s],
      `seat ${s} hand size ${deal.hands[s].length}, expected ${expected[s]} in phase ${ph.name}`,
    );
  }

  // Mode-shape invariants: constant 2p dummy, talon/discard sizes, 4p nulls.
  if (players === 2) {
    invariant(
      deal.dummyHand !== null && deal.dummyHand.length === handSize,
      `2p dummy hand has ${deal.dummyHand?.length ?? 'no'} cards, expected constant ${handSize}`,
    );
  } else {
    invariant(deal.dummyHand === null, 'dummy hand outside 2p');
  }
  if (players === 4) {
    invariant(
      deal.talon === null && deal.talonTakenBy === null && deal.discarded === null,
      '4p deal carries talon state',
    );
  } else {
    invariant(
      deal.talon !== null && deal.talon.length === config.talonSize,
      `talon has ${deal.talon?.length ?? 'no'} cards, expected ${config.talonSize}`,
    );
    invariant(
      deal.discarded === null || deal.discarded.length === config.talonSize,
      `discard pile has ${deal.discarded?.length} cards, expected ${config.talonSize}`,
    );
  }

  const tricksWon = SEATS.reduce((acc: number, s) => acc + deal.tricksWon[s], 0);
  invariant(
    tricksWon === deal.tricksPlayed,
    `tricksWon sum ${tricksWon} != tricksPlayed ${deal.tricksPlayed}`,
  );
}

type HiddenZone = Seat | 'dummy' | 'discard' | 'talon';

/** Every card currently hidden from public view, mapped to its zone. */
function hiddenCardOwners(deal: DealState): Map<Card, HiddenZone> {
  const owner = new Map<Card, HiddenZone>();
  for (const s of SEATS) for (const c of deal.hands[s]) owner.set(c, s);
  if (deal.dummyHand !== null) for (const c of deal.dummyHand) owner.set(c, 'dummy');
  if (deal.discarded !== null) for (const c of deal.discarded) owner.set(c, 'discard');
  if (deal.talon !== null && deal.talonTakenBy === null) {
    for (const c of deal.talon) owner.set(c, 'talon');
  }
  return owner;
}

/** (f) No serialized view contains a card hidden from its viewer. */
function checkViewLeaks(state: MatchState): void {
  const deal = state.deal;
  if (!deal) return;
  const cfg = state.config;
  const owner = hiddenCardOwners(deal);
  // Avoin koini: the talon faces are legitimately public during the whole
  // first trick and ONLY then — mirror the engine's window definition.
  const talonPublic =
    cfg.openTalon &&
    deal.talon !== null &&
    deal.tricksPlayed === 0 &&
    (deal.phase.name === 'lead' || deal.phase.name === 'follow');

  for (const viewer of viewersOf(cfg.players)) {
    const view = redactViewFor(state, viewer);
    const vd = view.deal;
    invariant(vd, `view for ${String(viewer)} lost the deal`);
    const seat = viewer === 'spectator' ? null : viewer;
    const privy =
      cfg.players === 4 &&
      seat !== null &&
      deal.declarer !== null &&
      (seat === deal.declarer || seat === partnerOf(deal.declarer));
    // Excluded per spec: the viewer's own hand; exchangeSeen for the two
    // privy 4p seats (for everyone else it must be null, so it stays
    // scanned); talonSeen while the talon is public (it must then be exactly
    // the original talon, and null at any other time).
    const strippedDeal: Record<string, unknown> = { ...vd };
    strippedDeal.hand = undefined;
    if (privy) strippedDeal.exchangeSeen = undefined;
    if (talonPublic) {
      invariant(
        deal.talon !== null &&
          vd.talonSeen !== null &&
          vd.talonSeen.length === deal.talon.length &&
          vd.talonSeen.every((c, i) => c === deal.talon?.[i]),
        `view for ${String(viewer)} has a wrong talonSeen inside the open-talon window`,
      );
      strippedDeal.talonSeen = undefined;
    } else {
      invariant(
        vd.talonSeen === null,
        `view for ${String(viewer)} shows talonSeen outside the open-talon window`,
      );
    }
    const json = JSON.stringify({ ...view, deal: strippedDeal });
    for (const m of json.matchAll(CARD_TOKEN_RE)) {
      const holder = owner.get(m[1] as Card);
      invariant(
        holder === undefined || holder === seat,
        `view for ${String(viewer)} leaks card ${m[1]} hidden in ${String(holder)}`,
      );
    }
  }
}

/** (f) Redacted events never carry a card hidden from their recipient. */
function checkEventLeaks(state: MatchState, event: GameEvent): void {
  const deal = state.deal;
  if (!deal) return;
  const owner = hiddenCardOwners(deal);
  for (const viewer of viewersOf(state.config.players)) {
    const redacted = redactEventFor(event, viewer);
    if (redacted === null) continue;
    const seat = viewer === 'spectator' ? null : viewer;
    // Documented privy payloads: exchange faces to the two exchanging seats,
    // discard faces to the discarding declarer — and nobody else.
    const allowed = new Set<Card>();
    if (
      (redacted.type === 'cardsGiven' || redacted.type === 'cardsReturned') &&
      (seat === redacted.from || seat === redacted.to)
    ) {
      for (const c of redacted.cards) allowed.add(c);
    }
    if (redacted.type === 'cardsDiscarded' && seat === redacted.seat) {
      for (const c of redacted.cards) allowed.add(c);
    }
    const json = JSON.stringify(redacted);
    for (const m of json.matchAll(CARD_TOKEN_RE)) {
      const card = m[1] as Card;
      if (allowed.has(card)) continue;
      const holder = owner.get(card);
      invariant(
        holder === undefined || holder === seat,
        `event ${event.type} leaks card ${card} hidden in ${String(holder)} to ${String(viewer)}`,
      );
    }
  }
}

/** (e) Independent re-derivation of the dealScored result from the pre-score deal. */
function checkDealScored(before: MatchState, result: DealResult, after: MatchState): void {
  const config = after.config;
  const players = config.players;
  const deal = before.deal;
  invariant(deal, 'dealScored without a deal in progress');
  invariant(deal.lastTrick !== null, 'dealScored without a last trick');
  const lastTrick = deal.lastTrick;
  const nSides = sideCount(config);
  invariant(
    result.sides.length === nSides,
    `dealScored has ${result.sides.length}/${nSides} sides`,
  );
  invariant(
    before.scores.length === nSides && after.scores.length === nSides,
    `match scores length != sideCount ${nSides}`,
  );
  invariant(result.declarer === deal.declarer, 'dealScored declarer mismatch');
  invariant(result.contract === deal.contract, 'dealScored contract mismatch');
  invariant(result.bid === (deal.bid?.amount ?? null), 'dealScored bid mismatch');

  const lastTrickSide = sideOf(lastTrick.winner, players);
  const declarerSide = deal.declarer === null ? null : sideOf(deal.declarer, players);
  const round = (raw: number): number =>
    config.opponentRounding === 'nearest5' ? Math.round(raw / 5) * 5 : raw;

  result.sides.forEach((b, side) => {
    const seats = activeSeats(players).filter((s) => sideOf(s, players) === side);
    const tricks = seats.reduce((acc: number, s) => acc + deal.tricksWon[s], 0);
    invariant(b.tricks === tricks, `side ${side} reports ${b.tricks} tricks, expected ${tricks}`);

    // 2p läpäri: the notional full deck replaces the actual captured points.
    const slam = players === 2 && tricks === tricksPerDeal(config);
    const capturedPts = seats.reduce(
      (acc: number, s) => acc + sumCardPoints(deal.captured[s], config),
      0,
    );
    const expCard = slam ? totalDealPoints(config) - config.lastTrickBonus : capturedPts;
    const expLast = lastTrickSide === side ? config.lastTrickBonus : 0;
    const expMarriage = deal.declarations.reduce(
      (acc, d) => (d.side === side ? acc + d.points : acc),
      0,
    );
    const expDiscard =
      !slam && side === declarerSide && deal.discarded !== null && tricks >= 1
        ? sumCardPoints(deal.discarded, config)
        : 0;
    invariant(b.cardPoints === expCard, `side ${side} cardPoints ${b.cardPoints} != ${expCard}`);
    invariant(
      b.lastTrickBonus === expLast,
      `side ${side} lastTrickBonus ${b.lastTrickBonus} != ${expLast}`,
    );
    invariant(
      b.marriagePoints === expMarriage,
      `side ${side} marriagePoints ${b.marriagePoints} != ${expMarriage}`,
    );
    invariant(
      b.discardPoints === expDiscard,
      `side ${side} discardPoints ${b.discardPoints} != ${expDiscard}`,
    );
    invariant(
      b.rawTotal === b.cardPoints + b.lastTrickBonus + b.marriagePoints + b.discardPoints,
      `side ${side} rawTotal ${b.rawTotal} inconsistent with its parts`,
    );
    invariant(
      b.roundedTotal === round(b.rawTotal),
      `side ${side} roundedTotal ${b.roundedTotal} != round(${b.rawTotal})`,
    );

    let expPorvoo: boolean;
    let expDelta: number;
    if (result.declarer === null) {
      // Contract-less deal: rounded raw totals, no penalties (pinned).
      invariant(
        result.contract === null && result.bid === null && result.made === null,
        'contract-less deal carries a contract/bid/made',
      );
      expPorvoo = false;
      expDelta = b.roundedTotal;
    } else if (side === declarerSide) {
      invariant(result.contract !== null && result.bid !== null, 'declarer without contract/bid');
      expPorvoo =
        config.declarerPorvooScope === 'seat'
          ? deal.tricksWon[result.declarer] === 0
          : tricks === 0;
      expDelta = expPorvoo
        ? -2 * (config.declarerPorvooBasis === 'bid' ? result.bid : result.contract)
        : b.rawTotal >= result.contract
          ? result.contract
          : -result.contract;
      invariant(
        result.made === (!expPorvoo && b.rawTotal >= result.contract),
        `made=${result.made} inconsistent with rawTotal ${b.rawTotal} vs contract ${result.contract}`,
      );
    } else {
      // Trickless opponents lose the BID (never the raised contract).
      invariant(result.bid !== null, 'opponent side scored without a bid');
      expPorvoo = tricks === 0;
      expDelta = expPorvoo ? -result.bid : b.roundedTotal;
    }
    invariant(b.porvoo === expPorvoo, `side ${side} porvoo ${b.porvoo}, expected ${expPorvoo}`);
    invariant(
      b.scoreDelta === expDelta,
      `side ${side} scoreDelta ${b.scoreDelta}, expected ${expDelta}`,
    );

    const beforeScore = before.scores[side];
    const afterScore = after.scores[side];
    invariant(
      beforeScore !== undefined && afterScore !== undefined,
      `side ${side} missing from the match scores array`,
    );
    invariant(
      afterScore === beforeScore + b.scoreDelta,
      `side ${side} score moved ${afterScore - beforeScore}, reported delta ${b.scoreDelta}`,
    );
  });

  // 4p captures all 36 cards, so card points + bonus must sum to the deal total.
  if (players === 4) {
    const pointSum = result.sides.reduce((acc, b) => acc + b.cardPoints + b.lastTrickBonus, 0);
    invariant(
      pointSum === totalDealPoints(config),
      `dealScored cardPoints+lastTrickBonus ${pointSum} != totalDealPoints ${totalDealPoints(config)}`,
    );
  }
}

/** Invariants (a)–(f), run after every single event application. */
function checkAfterEvent(before: MatchState, event: GameEvent, after: MatchState): void {
  const config = after.config;

  // (e) Only dealScored moves the scores, and exactly by the re-derived deltas.
  if (event.type === 'dealScored') {
    checkDealScored(before, event.result, after);
  } else {
    invariant(
      after.scores.length === before.scores.length &&
        after.scores.every((v, i) => v === before.scores[i]),
      `scores changed on ${event.type}`,
    );
  }

  const deal = after.deal;
  if (!deal) return;

  // (a) 36 unique cards across hands + captured piles + trick-in-progress
  //     + untaken talon + dummy hand + discards.
  const zone = new Set<string>();
  const add = (c: Card): void => {
    invariant(CARD_SET.has(c), `unknown card ${c}`);
    invariant(!zone.has(c), `card ${c} present in two zones`);
    zone.add(c);
  };
  for (const s of SEATS) for (const c of deal.hands[s]) add(c);
  for (const s of SEATS) for (const c of deal.captured[s]) add(c);
  if (deal.phase.name === 'follow') for (const p of deal.phase.plays) add(p.card);
  if (deal.talon !== null && deal.talonTakenBy === null) for (const c of deal.talon) add(c);
  if (deal.dummyHand !== null) for (const c of deal.dummyHand) add(c);
  if (deal.discarded !== null) for (const c of deal.discarded) add(c);
  invariant(zone.size === 36, `${zone.size}/36 cards in play after ${event.type}`);

  // (b)
  checkHandSizes(deal, config);

  // (c) Trump is fixed while a trick is in progress (declarations happen on leads).
  const bd = before.deal;
  if (bd && bd.phase.name === 'follow') {
    invariant(
      deal.trump === bd.trump,
      `trump changed ${bd.trump} -> ${deal.trump} mid-trick on ${event.type}`,
    );
  }

  // (d) Each suit declared at most once per deal.
  const declared = deal.declarations.map((d) => d.suit);
  invariant(new Set(declared).size === declared.length, 'a suit was declared twice in one deal');

  // (f)
  checkViewLeaks(after);
  checkEventLeaks(after, event);
}

// ── (h) Exhaustive hint/validate equivalence probing ─────────────────────────

function findHint<T extends ActionHint['type']>(
  hints: readonly ActionHint[],
  type: T,
): Extract<ActionHint, { type: T }> | undefined {
  return hints.find((h) => h.type === type) as Extract<ActionHint, { type: T }> | undefined;
}

function rangeProbes(hint: { min: number; max: number; step: number } | undefined): number[] {
  if (!hint) return [DEFAULT_RULES.minBid];
  return [
    ...new Set([
      hint.min - hint.step,
      hint.min,
      hint.min + 1,
      hint.min + hint.step,
      hint.max - hint.step,
      hint.max,
      hint.max + hint.step,
    ]),
  ];
}

/** Probes every action candidate: accepted must equal hinted, both ways. */
function probeTurn(state: MatchState, actor: Seat, hints: readonly ActionHint[]): void {
  const deal = state.deal;
  invariant(deal, 'probe without a deal in progress');
  const phase = deal.phase.name;

  const check = (action: PlayerAction, hinted: boolean): void => {
    const res = validateAction(state, actor, action);
    const accepted = !isRuleError(res);
    if (accepted !== hinted) {
      throw new Violation(
        `hint/validate mismatch in phase ${phase}: seat ${actor} ${JSON.stringify(action)} ` +
          `accepted=${accepted} hinted=${hinted}${isRuleError(res) ? ` (${res.code})` : ''}`,
      );
    }
  };

  // All 36 playCard candidates, every turn regardless of phase.
  const playHint = findHint(hints, 'playCard');
  for (const card of ALL_CARDS) {
    check({ type: 'playCard', card }, playHint?.legal.includes(card) ?? false);
  }

  // Bidding: pass, redeal demand, amounts at the hinted range edges ± step.
  // (Reopened bidding after a full bid-ban pass-out probes identically: the
  // hint carries the reopened round's range.) The redeal demand is also
  // hinted standalone during exchange phases (redealWindow 'bidAndExchange').
  const bidHint = findHint(hints, 'bid');
  check({ type: 'pass' }, bidHint?.canPass ?? false);
  check(
    { type: 'demandRedeal' },
    (bidHint?.canDemandRedeal ?? false) || findHint(hints, 'demandRedeal') !== undefined,
  );
  for (const amount of rangeProbes(bidHint)) {
    check(
      { type: 'bid', amount },
      bidHint !== undefined &&
        amount % bidHint.step === 0 &&
        amount >= bidHint.min &&
        amount <= bidHint.max,
    );
  }

  // Contract amounts at the hinted range edges ± step.
  const contractHint = findHint(hints, 'setContract');
  for (const amount of rangeProbes(contractHint)) {
    check(
      { type: 'setContract', amount },
      contractHint !== undefined &&
        amount % contractHint.step === 0 &&
        amount >= contractHint.min &&
        amount <= contractHint.max,
    );
  }

  // Every declaration option.
  const declHint = findHint(hints, 'declaration');
  for (const suit of SUITS) {
    check({ type: 'declareOwn', suit }, declHint?.ownSuits.includes(suit) ?? false);
  }
  check({ type: 'askWhole' }, declHint?.canAskWhole ?? false);
  for (const suit of SUITS) {
    for (const rankHeld of ['K', 'Q'] as const) {
      check(
        { type: 'askHalf', suit, rankHeld },
        declHint?.halfAsks.some((h) => h.suit === suit && h.rankHeld === rankHeld) ?? false,
      );
    }
  }
  const answerHint = findHint(hints, 'answerWhole');
  for (const suit of SUITS) {
    check({ type: 'answerWhole', suit }, answerHint?.suits.includes(suit) ?? false);
  }

  // Exchange card sets: the right set accepted iff hinted; wrong counts and
  // duplicated cards never.
  const hand = deal.hands[actor];
  const count = state.config.exchangeCount;
  const goodSet = hand.slice(0, count);
  const shortSet = hand.slice(0, count - 1);
  check({ type: 'giveCards', cards: goodSet }, findHint(hints, 'giveCards') !== undefined);
  check({ type: 'giveCards', cards: shortSet }, false);
  check({ type: 'returnCards', cards: goodSet }, findHint(hints, 'returnCards') !== undefined);
  check({ type: 'returnCards', cards: shortSet }, false);
  const first = hand[0];
  if (first !== undefined && count >= 2) {
    check({ type: 'giveCards', cards: [first, ...hand.slice(0, count - 1)] }, false);
  }

  // 2-3p koini discard sets: per-card probes with legal fillers (a set is
  // accepted iff every card is hinted-legal — aces/tens and cards outside
  // the hand must reject), plus wrong counts and duplicates.
  const discardHint = findHint(hints, 'discardCards');
  if (discardHint) {
    const { legal, count: dCount } = discardHint;
    invariant(legal.length >= dCount, `discard hint offers ${legal.length}/${dCount} cards`);
    invariant(
      legal.every((c) => hand.includes(c)),
      'discard hint offers a card outside the hand',
    );
    for (const card of ALL_CARDS) {
      const fillers = legal.filter((c) => c !== card).slice(0, dCount - 1);
      check({ type: 'discardCards', cards: [card, ...fillers] }, legal.includes(card));
    }
    check({ type: 'discardCards', cards: legal.slice(0, dCount - 1) }, false);
    const l0 = legal[0];
    if (l0 !== undefined && dCount >= 2) {
      check({ type: 'discardCards', cards: [l0, ...legal.slice(0, dCount - 1)] }, false);
    }
  } else {
    check({ type: 'discardCards', cards: hand.slice(0, state.config.talonSize) }, false);
  }

  // Non-actor active seats: no hints, and representative actions are rejected.
  for (const s of activeSeats(state.config.players)) {
    if (s === actor) continue;
    invariant(allowedActions(state, s).length === 0, `non-actor seat ${s} has hints in ${phase}`);
    invariant(isRuleError(validateAction(state, s, { type: 'pass' })), `non-actor ${s} may pass`);
    const c = deal.hands[s][0];
    if (c !== undefined) {
      invariant(
        isRuleError(validateAction(state, s, { type: 'playCard', card: c })),
        `non-actor seat ${s} may play a card in ${phase}`,
      );
    }
  }
}

// ── Game runner ───────────────────────────────────────────────────────────────

interface GameStats {
  deals: number;
  events: number;
  actions: number;
  hitMaxDeals: boolean;
  /** Final match scores per side (sideCount(config) entries). */
  finalScores: number[];
}

interface GameCtx {
  baseSeed: number;
  gameIndex: number;
  gameSeed: number;
  config: RuleConfig;
  botsMode: BotsMode;
  /** Side seated with HeuristicBots in --bots mixed (alternates per game). */
  heurSide: 0 | 1;
  firstDealer: Seat;
  log: GameEvent[];
  stats: GameStats;
}

function applyChecked(state: MatchState, event: GameEvent, ctx: GameCtx): MatchState {
  const after = applyEvent(state, event);
  ctx.log.push(event);
  ctx.stats.events++;
  checkAfterEvent(state, event, after);
  return after;
}

function runGame(ctx: GameCtx, maxDeals: number): void {
  const rng = mulberry32(ctx.gameSeed);
  const players = ctx.config.players;
  ctx.firstDealer = pickIndex(rng, players) as Seat;
  let state = initialMatchState(ctx.config, ctx.firstDealer);
  const bots: Array<RandomLegalBot | HeuristicBot> = activeSeats(players).map((s) => {
    const heuristic =
      ctx.botsMode === 'heuristic' ||
      (ctx.botsMode === 'mixed' && sideOf(s, players) === ctx.heurSide);
    return heuristic ? new HeuristicBot(rng) : new RandomLegalBot(rng);
  });

  while (state.winnerSide === null) {
    invariant(ctx.stats.events < 100_000, 'runaway game: event cap exceeded');
    const actor = expectedActor(state);
    if (actor === null) {
      // Server role: author the next deal with a PRNG-shuffled deck.
      if (ctx.stats.deals >= maxDeals) {
        // (i) counted and reported by the caller.
        ctx.stats.hitMaxDeals = true;
        break;
      }
      state = applyChecked(state, nextDealEvent(state, shuffle(rng, ALL_CARDS)), ctx);
      ctx.stats.deals++;
      continue;
    }

    const hints = allowedActions(state, actor);
    invariant(hints.length > 0, `no hints for expected actor ${actor}`);
    probeTurn(state, actor, hints);

    const bot = bots[actor] as RandomLegalBot | HeuristicBot;
    const action = bot.onTurn(redactViewFor(state, actor), hints);
    const res = validateAction(state, actor, action);
    if (isRuleError(res)) {
      throw new Violation(
        `hinted action rejected (${res.code}): seat ${actor} ${JSON.stringify(action)}`,
      );
    }
    ctx.stats.actions++;
    for (const ev of res) state = applyChecked(state, ev, ctx);
  }

  // (g) Replay determinism: the log alone reproduces the final state.
  let replayed = initialMatchState(ctx.config, ctx.firstDealer);
  for (const ev of ctx.log) replayed = applyEvent(replayed, ev);
  invariant(
    JSON.stringify(replayed) === JSON.stringify(state),
    'replaying the event log did not reproduce the final state',
  );

  ctx.stats.finalScores = [...state.scores];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function dumpFailure(ctx: GameCtx, error: unknown): string {
  const dir = new URL('../failures/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`failure-seed${ctx.baseSeed}-game${ctx.gameIndex}.json`, dir);
  const payload = {
    baseSeed: ctx.baseSeed,
    gameIndex: ctx.gameIndex,
    gameSeed: ctx.gameSeed,
    firstDealer: ctx.firstDealer,
    config: ctx.config,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    eventLog: ctx.log,
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return fileURLToPath(file);
}

function intFlag(raw: string | undefined, name: string, fallback: number): number {
  const v = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(v) || v < 0) {
    console.error(`[sim] --${name} must be a non-negative integer, got ${raw}`);
    process.exit(2);
  }
  return v;
}

function main(): void {
  // pnpm forwards the `--` separator of `pnpm sim -- --games N`; drop it so
  // parseArgs keeps reading the flags that follow.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args,
    options: {
      games: { type: 'string' },
      seed: { type: 'string' },
      maxDeals: { type: 'string' },
      offset: { type: 'string' },
      bots: { type: 'string' },
    },
  });
  const games = intFlag(values.games, 'games', 500);
  const seed = intFlag(values.seed, 'seed', 1);
  const maxDeals = intFlag(values.maxDeals, 'maxDeals', 60);
  const offset = intFlag(values.offset, 'offset', 0);
  const botsMode = (values.bots ?? 'random') as BotsMode;
  if (botsMode !== 'random' && botsMode !== 'heuristic' && botsMode !== 'mixed') {
    console.error(`[sim] --bots must be random | heuristic | mixed, got ${values.bots}`);
    process.exit(2);
  }

  const totals = { deals: 0, events: 0, actions: 0 };
  /** Cumulative final match scores per bot type (--bots mixed only). */
  const mixedScores = { heuristic: 0, random: 0 };
  const maxDealsHits: number[] = [];
  const t0 = performance.now();

  for (let i = 0; i < games; i++) {
    const gameIndex = offset + i;
    const ctx: GameCtx = {
      baseSeed: seed,
      gameIndex,
      gameSeed: (seed + gameIndex * 0x9e3779b1) >>> 0,
      config: configFor(gameIndex),
      botsMode,
      heurSide: (gameIndex % 2) as 0 | 1,
      firstDealer: 0,
      log: [],
      stats: { deals: 0, events: 0, actions: 0, hitMaxDeals: false, finalScores: [] },
    };
    try {
      runGame(ctx, maxDeals);
    } catch (error) {
      const file = dumpFailure(ctx, error);
      console.error(
        `[sim] FAILURE in game ${gameIndex} (--seed ${seed}, gameSeed ${ctx.gameSeed})`,
      );
      console.error(`[sim] ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[sim] event log dumped to ${file}`);
      process.exit(1);
    }
    if (ctx.stats.hitMaxDeals) maxDealsHits.push(gameIndex);
    totals.deals += ctx.stats.deals;
    totals.events += ctx.stats.events;
    totals.actions += ctx.stats.actions;
    if (botsMode === 'mixed') {
      const scores = ctx.stats.finalScores;
      mixedScores.heuristic += scores[ctx.heurSide] ?? 0;
      const others = scores.filter((_, side) => side !== ctx.heurSide);
      if (others.length > 0) {
        mixedScores.random += others.reduce((a, b) => a + b, 0) / others.length;
      }
    }
    if ((i + 1) % 1000 === 0) {
      const rate = (i + 1) / ((performance.now() - t0) / 1000);
      console.error(`[sim] ${i + 1}/${games} games ok (${rate.toFixed(1)} games/s)`);
    }
  }

  const secs = (performance.now() - t0) / 1000;
  const summary =
    `games=${games} offset=${offset} seed=${seed} bots=${botsMode} deals=${totals.deals} ` +
    `actions=${totals.actions} events=${totals.events} ` +
    `elapsed=${secs.toFixed(1)}s rate=${(games / secs).toFixed(1)} games/s`;
  if (maxDealsHits.length > 0) {
    console.error(
      `[sim] FAILURE: maxDeals cap (${maxDeals}) hit in games: ${maxDealsHits.join(', ')}`,
    );
    console.error(`[sim] ${summary}`);
    process.exit(1);
  }
  if (botsMode === 'mixed' && games > 0) {
    console.log(
      `[sim] mixed avg final score: heuristic=${(mixedScores.heuristic / games).toFixed(1)} ` +
        `random=${(mixedScores.random / games).toFixed(1)}`,
    );
  }
  console.log(`[sim] OK: all games clean. ${summary}`);
}

main();
