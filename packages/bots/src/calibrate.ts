/**
 * Calibration CLI — fits the hand-evaluation models in evaluate.ts from
 * simulated deals and writes src/calibration.ts.
 *
 *   pnpm --filter @hp/bots calibrate -- --deals 60000 --seed 7
 *
 * Per player count, over a mix of the shipped rulesets, with `hard` bots
 * playing everything that is not scripted:
 *  pass 1 — FORCED DECLARE at the minimum, contract = minimum. Fits `bid`
 *    (raw total R from the bidding-time hand) and `contract` (R from the
 *    contract-time hand). Forcing a random seat removes the "only strong
 *    hands declare" selection bias: the fit is E[R | hand] for ANY hand.
 *  pass 2 — forced declare, but now the declarer picks its EV-optimal
 *    contract with the pass-1 models → fits `declare` (deal differential).
 *  pass 3 — FORCED PASS: one seat always passes, the others bid with the
 *    live models → fits `pass`. The others' bidding depends on `pass` itself,
 *    so this is iterated from a contract-less ("everybody passes") start
 *    until it settles (3 rounds).
 *
 * Deterministic for a given --seed. Re-run after changing play heuristics,
 * features or rule defaults, then commit the regenerated calibration.ts.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  type ActionHint,
  activeSeats,
  allowedActions,
  applyEvent,
  type Card,
  DEFAULT_RULES,
  expectedActor,
  ILLISOFT_RULES,
  initialMatchState,
  isRuleError,
  type MatchState,
  makeDeck,
  nextDealEvent,
  type PlayerAction,
  type RuleConfig,
  redactViewFor,
  type Seat,
  sideOf,
  validateAction,
} from '@hp/engine';
import { CALIBRATION } from './calibration.js';
import {
  type Calibration,
  FEATURE_NAMES,
  fitLinear,
  handFeatures,
  type LinearModel,
} from './evaluate.js';
import { HeuristicBot } from './heuristic.js';
import { mulberry32, type Prng, pickIndex, shuffle } from './prng.js';

const DECK: readonly Card[] = makeDeck();

/** Rulesets per player count, weighted by repetition (illisoft = the room default). */
const CONFIGS: Record<2 | 3 | 4, RuleConfig[]> = {
  4: [
    ILLISOFT_RULES,
    ILLISOFT_RULES,
    ILLISOFT_RULES,
    DEFAULT_RULES,
    { ...DEFAULT_RULES, cardPoints: 'B', lastTrickBonus: 20 },
  ],
  3: [
    { ...ILLISOFT_RULES, players: 3, talonSize: 3, openTalon: true },
    { ...ILLISOFT_RULES, players: 3, talonSize: 3, openTalon: true },
    { ...ILLISOFT_RULES, players: 3, talonSize: 6, openTalon: false },
    { ...DEFAULT_RULES, players: 3 },
  ],
  2: [
    { ...ILLISOFT_RULES, players: 2, talonSize: 3, openTalon: true },
    { ...ILLISOFT_RULES, players: 2, talonSize: 3, openTalon: false },
    { ...ILLISOFT_RULES, players: 2, talonSize: 6, openTalon: true },
  ],
};

interface Sample {
  /** The scripted seat (forced declarer / forced passer). */
  focus: Seat;
  bidX: Map<Seat, number[]>;
  contractX: number[] | null;
  contractSize: number;
  /** Raw total of the focus seat's side. */
  raw: number;
  /** Deal differential per seat (own side's delta minus the others' mean). */
  delta: Map<Seat, number>;
}

type Role = 'declare' | 'pass' | 'allPass';

function find<T extends ActionHint['type']>(hints: ActionHint[], t: T) {
  return hints.find((h) => h.type === t) as Extract<ActionHint, { type: T }> | undefined;
}

function apply(state: MatchState, seat: Seat, action: PlayerAction): MatchState | null {
  const res = validateAction(state, seat, action);
  if (isRuleError(res)) return null;
  let s = state;
  for (const ev of res) s = applyEvent(s, ev);
  return s;
}

/** Plays one scripted deal; null when the script could not hold (redeal, ban). */
export function playDeal(
  rng: Prng,
  config: RuleConfig,
  role: Role,
  useModelContract: boolean,
): Sample | null {
  const seats = activeSeats(config.players);
  let state = initialMatchState(config, pickIndex(rng, config.players) as Seat);
  state = applyEvent(state, nextDealEvent(state, shuffle(rng, DECK)));
  const declarer = seats[pickIndex(rng, seats.length)] as Seat;
  const bots = seats.map(() => new HeuristicBot(rng, 'hard'));
  const bidHands = new Map<Seat, Card[]>();
  for (const s of seats) bidHands.set(s, [...(state.deal?.hands[s] ?? [])]);
  let contractX: number[] | null = null;
  let contractSize = 0;

  for (let guard = 0; guard < 500; guard++) {
    const deal = state.deal;
    if (!deal) return null;
    if (deal.phase.name === 'scored') break;
    const actor = expectedActor(state);
    if (actor === null) return null; // redeal demanded → needs a new deck
    const hints = allowedActions(state, actor);
    const view = redactViewFor(state, actor);
    let action: PlayerAction;
    const bid = find(hints, 'bid');
    if (bid) {
      if (role === 'declare' && actor === declarer) {
        if (bid.min > bid.max) return null;
        action = { type: 'bid', amount: bid.min };
      } else if (!bid.canPass) {
        action = { type: 'bid', amount: bid.min };
      } else if (role === 'pass' && actor !== declarer) {
        action = (bots[actor] as HeuristicBot).onTurn(view, hints) as PlayerAction;
        if (action.type === 'demandRedeal') return null;
      } else {
        action = { type: 'pass' };
      }
    } else if (find(hints, 'demandRedeal')) {
      return null;
    } else {
      const contract = find(hints, 'setContract');
      if (contract && actor === declarer) {
        contractX = handFeatures(deal.hands[actor], config);
        contractSize = deal.hands[actor].length;
        action = useModelContract
          ? ((bots[actor] as HeuristicBot).onTurn(view, hints) as PlayerAction)
          : { type: 'setContract', amount: contract.min };
      } else {
        action = (bots[actor] as HeuristicBot).onTurn(view, hints) as PlayerAction;
      }
    }
    const next = apply(state, actor, action);
    if (!next) return null;
    state = next;
  }
  const deal = state.deal;
  if (!deal || deal.phase.name !== 'scored') return null;
  if (role === 'declare' && deal.declarer !== declarer) return null;
  if (role === 'pass' && deal.declarer === declarer) return null;
  const sides = deal.phase.result.sides;
  const gains = sides.map((s) => s.scoreDelta);
  const delta = new Map<Seat, number>();
  const bidX = new Map<Seat, number[]>();
  for (const s of seats) {
    const side = sideOf(s, config.players);
    let others = 0;
    for (let i = 0; i < gains.length; i++) if (i !== side) others += gains[i] ?? 0;
    delta.set(s, (gains[side] ?? 0) - others / (gains.length - 1));
    bidX.set(s, handFeatures(bidHands.get(s) ?? [], config));
  }
  return {
    focus: declarer,
    bidX,
    contractX,
    contractSize,
    raw: sides[sideOf(declarer, config.players)]?.rawTotal ?? 0,
    delta,
  };
}

function collect(
  rng: Prng,
  players: 2 | 3 | 4,
  n: number,
  role: Role,
  modelContract: boolean,
): Sample[] {
  const out: Sample[] = [];
  const configs = CONFIGS[players];
  let i = 0;
  let attempts = 0;
  while (out.length < n && attempts < n * 20) {
    attempts++;
    const s = playDeal(rng, configs[i++ % configs.length] as RuleConfig, role, modelContract);
    if (s) out.push(s);
  }
  return out;
}

const focusX = (s: Sample): number[] => s.bidX.get(s.focus) as number[];
const focusDelta = (s: Sample): number => s.delta.get(s.focus) as number;

function round(m: LinearModel): LinearModel {
  return { w: m.w.map((v) => Math.round(v * 1e4) / 1e4), sigma: Math.round(m.sigma * 100) / 100 };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { deals: { type: 'string' }, seed: { type: 'string' } },
  });
  const deals = Number(values.deals ?? 20000);
  const seed = Number(values.seed ?? 7);
  const rng = mulberry32(seed);
  const out: Calibration = { bid: {}, contract: {}, declare: {}, pass: {} };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  for (const players of [4, 3, 2] as const) {
    const t0 = Date.now();
    const key = String(players);
    // pass 1 — R models.
    const p1 = collect(rng, players, deals, 'declare', false);
    out.bid[key] = round(
      fitLinear(
        p1.map(focusX),
        p1.map((s) => s.raw),
      ),
    );
    const bySize = new Map<number, Sample[]>();
    for (const s of p1) {
      if (!s.contractX) continue;
      const list = bySize.get(s.contractSize) ?? [];
      list.push(s);
      bySize.set(s.contractSize, list);
    }
    for (const [size, list] of bySize) {
      if (list.length < 500) continue;
      out.contract[`${players}:${size}`] = round(
        fitLinear(
          list.map((s) => s.contractX as number[]),
          list.map((s) => s.raw),
        ),
      );
    }
    CALIBRATION.bid[key] = out.bid[key] as LinearModel;
    for (const [k, m] of Object.entries(out.contract)) CALIBRATION.contract[k] = m;

    // pass 2 — declaring value with model contracts.
    const half = Math.ceil(deals / 2);
    const p2 = collect(rng, players, half, 'declare', true);
    out.declare[key] = round(fitLinear(p2.map(focusX), p2.map(focusDelta)));
    CALIBRATION.declare[key] = out.declare[key] as LinearModel;

    // pass 3 — passing value, iterated from the all-pass baseline.
    const p0 = collect(rng, players, Math.ceil(half / players), 'allPass', true);
    const allX = p0.flatMap((s) => [...s.bidX.values()]);
    const allY = p0.flatMap((s) => [...s.bidX.keys()].map((k) => s.delta.get(k) as number));
    let passModel = round(fitLinear(allX, allY));
    for (let round_ = 0; round_ < 3; round_++) {
      CALIBRATION.pass[key] = passModel;
      const p3 = collect(rng, players, half, 'pass', true);
      passModel = round(fitLinear(p3.map(focusX), p3.map(focusDelta)));
    }
    out.pass[key] = passModel;
    CALIBRATION.pass[key] = passModel;
    console.log(
      `[calibrate] ${players}p in ${Date.now() - t0}ms — R̄=${mean(p1.map((s) => s.raw)).toFixed(1)} ` +
        `σ_bid=${out.bid[key]?.sigma} declareΔ̄=${mean(p2.map(focusDelta)).toFixed(1)} ` +
        `contract models: ${[...bySize.keys()].join(',')}`,
    );
  }

  const header = `/**
 * GENERATED by \`pnpm --filter @hp/bots calibrate -- --deals ${deals} --seed ${seed}\`
 * (src/calibrate.ts) — do not edit by hand. Weights align with FEATURE_NAMES:
 * ${FEATURE_NAMES.join(', ')}.
 */
import type { Calibration } from './evaluate.js';

export const CALIBRATION: Calibration = ${JSON.stringify(out, null, 2)};
`;
  writeFileSync(new URL('./calibration.ts', import.meta.url), header);
  console.log('[calibrate] wrote src/calibration.ts');
}

if (process.argv[1]?.endsWith('calibrate.ts')) main();
