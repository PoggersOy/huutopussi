/**
 * Fuzz/simulation harness — the P2 gate (docs/plan.md): plays full random-bot
 * matches exclusively through the engine's public entry points and asserts
 * engine invariants after EVERY event application:
 *
 *   (a) 36 unique cards conserved across hands + captured + trick-in-progress
 *   (b) per-seat hand sizes consistent with the phase
 *   (c) trump never changes while a trick has 1–3 plays
 *   (d) each suit declared at most once per deal
 *   (e) dealScored: card points + last-trick bonus sum exactly to
 *       totalDealPoints(config); match scores move by exactly the reported
 *       deltas (and never move on any other event)
 *   (f) no redacted view (4 seats + spectator) contains a card that is in
 *       another seat's hand (regex scan of the serialized view, excluding the
 *       viewer's own hand / privy exchangeSeen fields)
 *   (g) replaying the collected event log from initialMatchState reproduces a
 *       deep-equal final state
 *   (h) hint/validate equivalence, probed exhaustively at every turn: all 36
 *       playCard candidates, bid/contract amounts at the hinted range edges
 *       ± step, every declaration option, exchange card sets, non-actor seats
 *   (i) games terminate (maxDeals cap hits are counted, reported and fatal)
 *
 * Usage: pnpm sim -- --games 50000 --seed 1 [--maxDeals 60] [--offset 0]
 *                    [--bots random|heuristic|mixed]
 * Game i uses PRNG seed derived from (seed, offset+i); 20% of games run with
 * cardPoints 'B' + lastTrickBonus 20 and 20% with trumpValues 'bridge',
 * derived deterministically from the global game index.
 * --bots mixed seats HeuristicBots on one side and RandomLegalBots on the
 * other (the heuristic side alternates by game index) and reports the average
 * final match score per bot type.
 * On violation the full event log is dumped to packages/bots/failures/ and
 * the process exits 1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ActionHint,
  allowedActions,
  applyEvent,
  type Card,
  DEFAULT_RULES,
  type DealState,
  expectedActor,
  type GameEvent,
  initialMatchState,
  isRuleError,
  type MatchState,
  makeDeck,
  nextDealEvent,
  type PlayerAction,
  partnerOf,
  type RuleConfig,
  redactViewFor,
  SEATS,
  type Seat,
  type Side,
  SUITS,
  sideOf,
  totalDealPoints,
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
const VIEWERS: ReadonlyArray<Seat | 'spectator'> = [0, 1, 2, 3, 'spectator'];

/** Alternate rule configs, derived deterministically from the game index. */
function configFor(gameIndex: number): RuleConfig {
  switch (gameIndex % 5) {
    case 3:
      return { ...DEFAULT_RULES, cardPoints: 'B', lastTrickBonus: 20 };
    case 4:
      return { ...DEFAULT_RULES, trumpValues: 'bridge' };
    default:
      return DEFAULT_RULES;
  }
}

// ── Invariants ────────────────────────────────────────────────────────────────

/** (b) Expected hand size per seat for the current phase. */
function checkHandSizes(deal: DealState, config: RuleConfig): void {
  const expected: Record<Seat, number> = { 0: 9, 1: 9, 2: 9, 3: 9 };
  const ph = deal.phase;
  const base = 9 - deal.tricksPlayed;
  switch (ph.name) {
    case 'bidding':
    case 'exchangeGive':
      break;
    case 'exchangeContract':
    case 'exchangeReturn': {
      invariant(deal.declarer !== null, `no declarer in phase ${ph.name}`);
      expected[deal.declarer] = 9 + config.exchangeCount;
      expected[partnerOf(deal.declarer)] = 9 - config.exchangeCount;
      break;
    }
    case 'lead':
    case 'awaitWholeAnswer':
      for (const s of SEATS) expected[s] = base;
      break;
    case 'follow': {
      for (const s of SEATS) expected[s] = base;
      for (const p of ph.plays) expected[p.seat] = base - 1;
      break;
    }
    case 'scored':
      for (const s of SEATS) expected[s] = 0;
      break;
  }
  for (const s of SEATS) {
    invariant(
      deal.hands[s].length === expected[s],
      `seat ${s} hand size ${deal.hands[s].length}, expected ${expected[s]} in phase ${ph.name}`,
    );
  }
  const tricksWon = SEATS.reduce((acc: number, s) => acc + deal.tricksWon[s], 0);
  invariant(
    tricksWon === deal.tricksPlayed,
    `tricksWon sum ${tricksWon} != tricksPlayed ${deal.tricksPlayed}`,
  );
}

/** (f) No serialized view contains a card sitting in another seat's hand. */
function checkViewLeaks(state: MatchState): void {
  const deal = state.deal;
  if (!deal) return;
  const owner = new Map<string, Seat>();
  for (const s of SEATS) for (const c of deal.hands[s]) owner.set(c, s);

  for (const viewer of VIEWERS) {
    const view = redactViewFor(state, viewer);
    const vd = view.deal;
    invariant(vd, `view for ${String(viewer)} lost the deal`);
    const seat = viewer === 'spectator' ? null : viewer;
    const privy =
      seat !== null &&
      deal.declarer !== null &&
      (seat === deal.declarer || seat === partnerOf(deal.declarer));
    // Excluded per spec: the viewer's own hand, and exchangeSeen for the two
    // privy seats (for everyone else it must be null, so it stays scanned).
    const strippedDeal: Record<string, unknown> = { ...vd };
    strippedDeal.hand = undefined;
    if (privy) strippedDeal.exchangeSeen = undefined;
    const json = JSON.stringify({ ...view, deal: strippedDeal });
    for (const m of json.matchAll(CARD_TOKEN_RE)) {
      const holder = owner.get(m[1] as string);
      invariant(
        holder === undefined || holder === seat,
        `view for ${String(viewer)} leaks card ${m[1]} held by seat ${holder}`,
      );
    }
  }
}

/** Invariants (a)–(f), run after every single event application. */
function checkAfterEvent(before: MatchState, event: GameEvent, after: MatchState): void {
  const config = after.config;

  // (e) Only dealScored moves the scores, and exactly by the reported deltas.
  if (event.type === 'dealScored') {
    const { sides } = event.result;
    const pointSum =
      sides[0].cardPoints + sides[1].cardPoints + sides[0].lastTrickBonus + sides[1].lastTrickBonus;
    invariant(
      pointSum === totalDealPoints(config),
      `dealScored cardPoints+lastTrickBonus ${pointSum} != totalDealPoints ${totalDealPoints(config)}`,
    );
    for (const side of [0, 1] as const) {
      const b = sides[side];
      invariant(
        b.rawTotal === b.cardPoints + b.lastTrickBonus + b.marriagePoints,
        `side ${side} rawTotal ${b.rawTotal} inconsistent with its parts`,
      );
      invariant(
        after.scores[side] === before.scores[side] + b.scoreDelta,
        `side ${side} score moved ${after.scores[side] - before.scores[side]}, reported delta ${b.scoreDelta}`,
      );
    }
  } else {
    invariant(
      after.scores[0] === before.scores[0] && after.scores[1] === before.scores[1],
      `scores changed on ${event.type}`,
    );
  }

  const deal = after.deal;
  if (!deal) return;

  // (a) 36 unique cards across hands + captured piles + trick-in-progress.
  const zone = new Set<string>();
  const add = (c: Card): void => {
    invariant(CARD_SET.has(c), `unknown card ${c}`);
    invariant(!zone.has(c), `card ${c} present in two zones`);
    zone.add(c);
  };
  for (const s of SEATS) for (const c of deal.hands[s]) add(c);
  for (const s of SEATS) for (const c of deal.captured[s]) add(c);
  if (deal.phase.name === 'follow') for (const p of deal.phase.plays) add(p.card);
  invariant(zone.size === 36, `${zone.size}/36 cards in play after ${event.type}`);

  // (b)
  checkHandSizes(deal, config);

  // (c) Trump is fixed while a trick has 1–3 plays.
  const bd = before.deal;
  if (bd && bd.phase.name === 'follow' && bd.phase.plays.length <= 3) {
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
  const bidHint = findHint(hints, 'bid');
  check({ type: 'pass' }, bidHint?.canPass ?? false);
  check({ type: 'demandRedeal' }, bidHint?.canDemandRedeal ?? false);
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

  // Non-actor seats: no hints, and representative actions are rejected.
  for (const s of SEATS) {
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
  finalScores: [number, number];
}

interface GameCtx {
  baseSeed: number;
  gameIndex: number;
  gameSeed: number;
  config: RuleConfig;
  botsMode: BotsMode;
  /** Side seated with HeuristicBots in --bots mixed (alternates per game). */
  heurSide: Side;
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
  ctx.firstDealer = pickIndex(rng, 4) as Seat;
  let state = initialMatchState(ctx.config, ctx.firstDealer);
  const bots: Array<RandomLegalBot | HeuristicBot> = SEATS.map((s) => {
    const heuristic =
      ctx.botsMode === 'heuristic' || (ctx.botsMode === 'mixed' && sideOf(s) === ctx.heurSide);
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

  ctx.stats.finalScores = [state.scores[0], state.scores[1]];
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
      heurSide: (gameIndex % 2) as Side,
      firstDealer: 0,
      log: [],
      stats: { deals: 0, events: 0, actions: 0, hitMaxDeals: false, finalScores: [0, 0] },
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
      mixedScores.heuristic += ctx.stats.finalScores[ctx.heurSide];
      mixedScores.random += ctx.stats.finalScores[(1 - ctx.heurSide) as Side];
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
