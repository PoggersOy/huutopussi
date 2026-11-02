/**
 * Arena CLI — head-to-head strength measurement between bot levels.
 *
 *   pnpm --filter @hp/bots arena -- --a expert --b hard --players 4 --deals 400 --seed 1
 *   pnpm --filter @hp/bots arena -- --a hard --b medium --mode matches --games 200
 *
 * DUPLICATE format (variance reduction): every deck is played twice with the
 * levels swapped between the seats, so the luck of the cards cancels and what
 * remains is skill. 4p: level A holds one partnership, B the other. 3p: A sits
 * at one seat (rotating) against two B bots; 2p: A vs B.
 *
 * Metrics (from A's point of view):
 *  - deals mode: mean deal differential per deal (own side's score delta
 *    minus the mean of the other sides'), with a 95% confidence interval;
 *  - matches mode: full matches to the win target; A's match win rate
 *    (baseline 50% in 2p/4p, 33% in 3p) plus the mean final-score margin.
 */
import { parseArgs } from 'node:util';
import {
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
  type RuleConfig,
  redactViewFor,
  type Seat,
  sideOf,
  validateAction,
} from '@hp/engine';
import {
  BOT_DIFFICULTIES,
  type BotDifficulty,
  HeuristicBot,
  type SkillProfile,
} from './heuristic.js';
import { mulberry32, shuffle } from './prng.js';

const DECK: readonly Card[] = makeDeck();

/** Contract statistics by who declared (A's side, B's side, nobody). */
const blank = () => ({ n: 0, bid: 0, contract: 0, made: 0 });
const STATS = { a: blank(), b: blank(), none: blank() };

/** --tune k=v,k=v: SkillProfile overrides applied to level A only. */
let TUNE_A: Partial<SkillProfile> = {};
/** --tuneB k=v,…: overrides for level B (e.g. an eager opener as the opponent). */
let TUNE_B: Partial<SkillProfile> = {};

function configOf(name: string, players: 2 | 3 | 4): RuleConfig {
  const base = name === 'default' ? DEFAULT_RULES : ILLISOFT_RULES;
  if (players === 4) return { ...base, players: 4 };
  return { ...base, players, talonSize: 3, openTalon: true };
}

/** Which level sits at `seat` in game variant `v` (duplicate rotation). */
function levelAt(seat: Seat, v: number, players: 2 | 3 | 4, a: BotDifficulty, b: BotDifficulty) {
  if (players === 4) return sideOf(seat, 4) === v % 2 ? a : b;
  return seat === v % players ? a : b;
}

/** The seat whose side counts as "A" in variant v. */
function aSeat(v: number, players: 2 | 3 | 4): Seat {
  return (players === 4 ? v % 2 : v % players) as Seat;
}

interface RunResult {
  deltas: number[];
  finished: boolean;
  winnerSide: number | null;
  finalScores: number[];
}

/**
 * Plays deals from a fixed deck stream. `maxDeals` = 1 → a single deal
 * (deals mode); otherwise until the match ends.
 */
function run(
  config: RuleConfig,
  deckSeed: number,
  botSeed: number,
  v: number,
  a: BotDifficulty,
  b: BotDifficulty,
  maxDeals: number,
): RunResult {
  const players = config.players;
  const seats = activeSeats(players);
  const deckRng = mulberry32(deckSeed);
  const bots = seats.map((s) => {
    const lvl = levelAt(s, v, players, a, b);
    const rng = mulberry32(botSeed * 7919 + s);
    const isA = levelAt(s, v, players, 'expert', 'easy') === 'expert';
    return new HeuristicBot(rng, lvl, isA ? TUNE_A : TUNE_B);
  });
  let state: MatchState = initialMatchState(config, (deckSeed % players) as Seat);
  const me = aSeat(v, players);
  const deltas: number[] = [];
  let deals = 0;
  for (let guard = 0; guard < 20000; guard++) {
    if (state.winnerSide !== null) break;
    const actor = expectedActor(state);
    if (actor === null) {
      const d = state.deal;
      if (d && d.phase.name === 'scored') {
        const sides = d.phase.result.sides;
        const mine = sideOf(me, players);
        let others = 0;
        for (let i = 0; i < sides.length; i++) if (i !== mine) others += sides[i]?.scoreDelta ?? 0;
        deltas.push((sides[mine]?.scoreDelta ?? 0) - others / (sides.length - 1));
        const r = d.phase.result;
        const who = r.declarer === null ? 'none' : sideOf(r.declarer, players) === mine ? 'a' : 'b';
        const st = STATS[who];
        st.n++;
        if (r.declarer !== null) {
          st.bid += r.bid ?? 0;
          st.contract += r.contract ?? 0;
          if (r.made) st.made++;
        }
        deals++;
        if (deals >= maxDeals) break;
      }
      state = applyEvent(state, nextDealEvent(state, shuffle(deckRng, DECK)));
      continue;
    }
    const hints = allowedActions(state, actor);
    for (const s of seats)
      if (s !== actor) (bots[s] as HeuristicBot).observe(redactViewFor(state, s));
    const action = (bots[actor] as HeuristicBot).onTurn(redactViewFor(state, actor), hints);
    const res = validateAction(state, actor, action);
    if (isRuleError(res))
      throw new Error(`arena: rejected ${JSON.stringify(action)} (${res.code})`);
    for (const ev of res) state = applyEvent(state, ev);
  }
  return {
    deltas,
    finished: state.winnerSide !== null,
    winnerSide: state.winnerSide,
    finalScores: [...state.scores],
  };
}

function meanCi(xs: readonly number[]): { mean: number; ci: number } {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
  return { mean, ci: 1.96 * Math.sqrt(variance / n) };
}

function parseLevel(raw: string | undefined, fallback: BotDifficulty): BotDifficulty {
  const v = (raw ?? fallback) as BotDifficulty;
  if (!BOT_DIFFICULTIES.includes(v)) throw new Error(`unknown level ${raw}`);
  return v;
}

export interface ArenaReport {
  a: BotDifficulty;
  b: BotDifficulty;
  players: 2 | 3 | 4;
  mode: 'deals' | 'matches';
  samples: number;
  meanDelta: number;
  ci: number;
  winRate?: number;
  ms: number;
}

/** Programmatic entry (tests use small counts). */
export function arena(opts: {
  a: BotDifficulty;
  b: BotDifficulty;
  players: 2 | 3 | 4;
  count: number;
  seed: number;
  mode: 'deals' | 'matches';
  rules?: string | undefined;
}): ArenaReport {
  const t0 = Date.now();
  const config = configOf(opts.rules ?? 'illisoft', opts.players);
  const variants = opts.players === 3 ? 3 : 2;
  const perBoard: number[] = [];
  let wins = 0;
  let games = 0;
  for (let i = 0; i < opts.count; i++) {
    const deckSeed = opts.seed * 100_003 + i;
    let boardSum = 0;
    for (let v = 0; v < variants; v++) {
      const r = run(
        config,
        deckSeed,
        deckSeed + v,
        v,
        opts.a,
        opts.b,
        opts.mode === 'deals' ? 1 : 200,
      );
      if (opts.mode === 'deals') {
        boardSum += r.deltas.reduce((s, x) => s + x, 0);
      } else {
        const mine = sideOf(aSeat(v, opts.players), opts.players);
        if (r.winnerSide === mine) wins++;
        games++;
        const own = r.finalScores[mine] ?? 0;
        const others = r.finalScores.filter((_, k) => k !== mine);
        boardSum += own - others.reduce((s, x) => s + x, 0) / others.length;
      }
    }
    perBoard.push(boardSum / variants);
  }
  const { mean, ci } = meanCi(perBoard);
  return {
    a: opts.a,
    b: opts.b,
    players: opts.players,
    mode: opts.mode,
    samples: opts.count,
    meanDelta: mean,
    ci,
    ...(opts.mode === 'matches' ? { winRate: wins / Math.max(1, games) } : {}),
    ms: Date.now() - t0,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((x) => x !== '--'),
    options: {
      a: { type: 'string' },
      b: { type: 'string' },
      players: { type: 'string' },
      deals: { type: 'string' },
      games: { type: 'string' },
      mode: { type: 'string' },
      seed: { type: 'string' },
      rules: { type: 'string' },
      tune: { type: 'string' },
      tuneB: { type: 'string' },
    },
  });
  const parseTune = (raw: string): Partial<SkillProfile> =>
    Object.fromEntries(
      raw.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        const n = Number(v);
        return [k, Number.isNaN(n) ? v : n];
      }),
    ) as Partial<SkillProfile>;
  if (values.tuneB) TUNE_B = parseTune(values.tuneB);
  if (values.tune) {
    TUNE_A = Object.fromEntries(
      values.tune.split(',').map((kv) => {
        const [k, raw] = kv.split('=');
        const n = Number(raw);
        return [k, Number.isNaN(n) ? raw : n];
      }),
    ) as Partial<SkillProfile>;
  }
  const mode = values.mode === 'matches' ? 'matches' : 'deals';
  const players = Number(values.players ?? 4) as 2 | 3 | 4;
  const report = arena({
    a: parseLevel(values.a, 'hard'),
    b: parseLevel(values.b, 'medium'),
    players,
    count: Number((mode === 'matches' ? values.games : values.deals) ?? 200),
    seed: Number(values.seed ?? 1),
    mode,
    rules: values.rules,
  });
  const unit = mode === 'deals' ? 'per deal' : 'final-score margin per match';
  console.log(
    `[arena] ${report.a} vs ${report.b} (${players}p, ${mode}, n=${report.samples}): ` +
      `${report.meanDelta.toFixed(1)} ± ${report.ci.toFixed(1)} ${unit}` +
      (report.winRate !== undefined ? `, win rate ${(report.winRate * 100).toFixed(1)}%` : '') +
      ` [${(report.ms / 1000).toFixed(1)}s]`,
  );
  const total = STATS.a.n + STATS.b.n + STATS.none.n;
  for (const [k, st] of Object.entries(STATS)) {
    if (k === 'none') {
      console.log(`  no contract: ${((100 * st.n) / total).toFixed(1)}%`);
      continue;
    }
    console.log(
      `  ${k === 'a' ? report.a : report.b} declared ${((100 * st.n) / total).toFixed(1)}%: ` +
        `bid ${(st.bid / st.n).toFixed(0)}, contract ${(st.contract / st.n).toFixed(0)}, ` +
        `made ${((100 * st.made) / st.n).toFixed(0)}%`,
    );
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) main();
