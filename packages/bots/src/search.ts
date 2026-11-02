/**
 * Determinized Monte Carlo search (PIMC) for the expert level.
 *
 * The bot never sees MatchState. Instead it builds HYPOTHETICAL full states
 * ("determinizations") that are consistent with everything its own view and
 * memory prove: its hand, cards played, per-seat exclusions (voids, failed
 * heads, ace show), known holdings (exchange faces, declarations, the open
 * talon) and every count in the view. Each candidate action is applied to the
 * same set of samples (common random numbers) and the deal is played out with
 * a fast policy; the action with the best mean deal differential wins.
 *
 * Determinism: all sampling draws from the bot's injected PRNG, and the
 * budget is a fixed sample count (never wall-clock), so a seeded bot replays
 * identically — the sim/arena harnesses rely on it.
 */
import type {
  ActionHint,
  Card,
  DealState,
  MatchState,
  PlayerAction,
  PlayerView,
  Seat,
} from '@hp/engine';
import {
  activeSeats,
  allowedActions,
  applyEvent,
  expectedActor,
  isRuleError,
  rankOf,
  sideOf,
  validateAction,
} from '@hp/engine';
import { ALL_CARDS, type DealMemory, type Knowledge } from './memory.js';
import { type Prng, shuffle } from './prng.js';

type Sink = { kind: 'seat'; seat: Seat } | { kind: 'talon' | 'dummy' | 'discard' | 'gone' };

interface Destination {
  sink: Sink;
  need: number;
  accepts: (c: Card) => boolean;
}

/**
 * One hypothetical MatchState consistent with the view + knowledge, or null
 * when the constraints could not be satisfied (the caller then relaxes them).
 */
export function determinize(
  view: PlayerView,
  know: Knowledge,
  memory: DealMemory,
  rng: Prng,
  relax = false,
): MatchState | null {
  const deal = view.deal;
  if (!deal || view.viewer === 'spectator') return null;
  const config = view.config;
  const me = view.viewer;
  const seats = activeSeats(config.players);

  const hands: Record<Seat, Card[]> = { 0: [], 1: [], 2: [], 3: [] };
  hands[me] = [...deal.hand];
  const placed = new Set<Card>(deal.hand);
  for (const c of know.played) placed.add(c);
  for (const s of seats) {
    if (s === me) continue;
    for (const c of know.held[s]) {
      if (placed.has(c)) continue;
      hands[s].push(c);
      placed.add(c);
    }
  }

  // Captured piles from remembered tricks; unseen tricks leave a deficit
  // that the 'gone' sink fills.
  const captured: Record<Seat, Card[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const [k, rec] of memory.tricks) {
    if (k >= deal.tricksPlayed || rec.winner === null || rec.plays.length < config.players)
      continue;
    for (const p of rec.plays) captured[rec.winner].push(p.card);
  }
  // Current-trick plays are on the table, not captured; they are "played".
  const tablePlays = deal.phase.name === 'follow' ? deal.phase.plays.map((p) => p.card) : [];
  for (const c of tablePlays) placed.add(c);

  const myDiscards = deal.declarer === me ? memory.myDiscards : null;
  if (myDiscards) for (const c of myDiscards) placed.add(c);
  const talonKnown =
    memory.talonSeen && deal.talonCount !== null && deal.talonCount > 0 ? memory.talonSeen : null;
  if (talonKnown) for (const c of talonKnown) placed.add(c);

  const dests: Destination[] = [];
  for (const s of seats) {
    if (s === me) continue;
    const need = deal.handCounts[s] - hands[s].length;
    if (need < 0) return null;
    const ex = know.excluded[s];
    dests.push({ sink: { kind: 'seat', seat: s }, need, accepts: (c) => relax || !ex.has(c) });
  }
  if (deal.talonCount !== null && deal.talonCount > 0 && !talonKnown) {
    dests.push({ sink: { kind: 'talon' }, need: deal.talonCount, accepts: () => true });
  }
  if (deal.dummyHandCount !== null && deal.dummyHandCount > 0) {
    dests.push({ sink: { kind: 'dummy' }, need: deal.dummyHandCount, accepts: () => true });
  }
  if (deal.discardedCount !== null && deal.discardedCount > 0 && !myDiscards) {
    dests.push({
      sink: { kind: 'discard' },
      need: deal.discardedCount,
      accepts: (c) => relax || (rankOf(c) !== 'A' && rankOf(c) !== '10'),
    });
  }

  const pool = ALL_CARDS.filter((c) => !placed.has(c));
  const needTotal = dests.reduce((a, d) => a + d.need, 0);
  const goneNeed = pool.length - needTotal;
  if (goneNeed < 0) return null;
  // Unseen played cards can only be in captured piles (deficits per seat).
  const deficits: Record<Seat, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let deficitTotal = 0;
  for (const s of seats) {
    deficits[s] = Math.max(0, deal.capturedCounts[s] - captured[s].length);
    deficitTotal += deficits[s];
  }
  if (goneNeed > 0) {
    dests.push({
      sink: { kind: 'gone' },
      need: goneNeed,
      accepts: () => true,
    });
  }

  // Most-constrained-first greedy assignment with random tie-breaking.
  const order = shuffle(rng, pool);
  const allowed = (c: Card): Destination[] => dests.filter((d) => d.accepts(c));
  order.sort((a, b) => allowed(a).length - allowed(b).length);
  const filled = new Map<Destination, Card[]>();
  for (const d of dests) filled.set(d, []);
  for (const c of order) {
    const options = allowed(c).filter((d) => (filled.get(d) as Card[]).length < d.need);
    if (options.length === 0) return null;
    let total = 0;
    for (const d of options) total += d.need - (filled.get(d) as Card[]).length;
    let r = rng() * total;
    let chosen = options[options.length - 1] as Destination;
    for (const d of options) {
      r -= d.need - (filled.get(d) as Card[]).length;
      if (r < 0) {
        chosen = d;
        break;
      }
    }
    (filled.get(chosen) as Card[]).push(c);
  }

  let talon: Card[] | null = null;
  let dummy: Card[] | null = null;
  let discarded: Card[] | null = myDiscards ? [...myDiscards] : null;
  let gone: Card[] = [];
  for (const [d, cards] of filled) {
    switch (d.sink.kind) {
      case 'seat':
        hands[d.sink.seat].push(...cards);
        break;
      case 'talon':
        talon = cards;
        break;
      case 'dummy':
        dummy = cards;
        break;
      case 'discard':
        discarded = cards;
        break;
      case 'gone':
        gone = cards;
        break;
    }
  }
  if (talonKnown) talon = [...talonKnown];
  // Spread unseen captured cards over the per-seat deficits.
  if (gone.length > 0 && deficitTotal === gone.length) {
    let i = 0;
    for (const s of seats)
      for (let n = 0; n < deficits[s]; n++) captured[s].push(gone[i++] as Card);
  } else if (gone.length > 0) {
    const winner = seats.find((s) => deficits[s] > 0) ?? me;
    captured[winner].push(...gone);
  }

  const players = config.players;
  let talonState: Card[] | null = null;
  let talonTakenBy: Seat | null = null;
  if (players !== 4) {
    if (deal.talonCount !== null && deal.talonCount > 0) {
      talonState = talon ?? [];
    } else {
      // Taken (or contract-less & consumed): only the faces matter for the
      // open-talon view, which a rollout never renders for scoring.
      talonState = memory.talonSeen ? [...memory.talonSeen] : [];
      talonTakenBy = deal.declarer;
    }
  }

  const dealState: DealState = {
    hands,
    captured,
    tricksWon: { ...deal.tricksWon },
    tricksPlayed: deal.tricksPlayed,
    trump: deal.trump,
    declarations: [...deal.declarations],
    askedWhole: { ...deal.askedWhole },
    askedHalf: { ...deal.askedHalf },
    deniedHalves: [],
    bidLog: [...deal.bidLog],
    bid: deal.bid,
    declarer: deal.declarer,
    contract: deal.contract,
    exchange: {
      given: deal.exchangeSeen?.given ? [...deal.exchangeSeen.given] : null,
      returned: deal.exchangeSeen?.returned ? [...deal.exchangeSeen.returned] : null,
    },
    talon: talonState,
    talonTakenBy,
    dummyHand: players === 2 ? (dummy ?? []) : null,
    discarded,
    lastTrick: deal.lastTrick,
    phase: deal.phase,
  };
  return {
    config,
    scores: [...view.scores],
    dealer: view.dealer,
    dealIndex: view.dealIndex,
    deal: dealState,
    winnerSide: null,
  };
}

/** Samples with retries; falls back to relaxed exclusions, then gives up. */
export function sampleStates(
  view: PlayerView,
  know: Knowledge,
  memory: DealMemory,
  rng: Prng,
  count: number,
): MatchState[] {
  const out: MatchState[] = [];
  let failures = 0;
  while (out.length < count && failures < count * 4) {
    const s = determinize(view, know, memory, rng, failures >= count * 2);
    if (s) out.push(s);
    else failures++;
  }
  return out;
}

/**
 * The deal differential for `me` once the deal is scored: own side's score
 * delta minus the mean delta of the other sides. null if the rollout stalled
 * (e.g. a redeal needs a fresh deck).
 */
export function dealValue(state: MatchState, me: Seat): number | null {
  const deal = state.deal;
  if (!deal || deal.phase.name !== 'scored') return null;
  const sides = deal.phase.result.sides;
  const mine = sideOf(me, state.config.players);
  let others = 0;
  let n = 0;
  for (let i = 0; i < sides.length; i++) {
    if (i === mine) continue;
    others += (sides[i] as { scoreDelta: number }).scoreDelta;
    n++;
  }
  return (sides[mine] as { scoreDelta: number }).scoreDelta - (n > 0 ? others / n : 0);
}

/** Applies `action` for `seat`; null when the hypothetical state rejects it. */
export function step(state: MatchState, seat: Seat, action: PlayerAction): MatchState | null {
  const res = validateAction(state, seat, action);
  if (isRuleError(res)) return null;
  let s = state;
  for (const ev of res) s = applyEvent(s, ev);
  return s;
}

/**
 * A rollout policy decides for `seat` in a HYPOTHETICAL state (one of the
 * bot's own determinizations — never the real MatchState). Implementations
 * must restrict themselves to what that seat could see in that world.
 */
export type RolloutPolicy = (state: MatchState, seat: Seat, hints: ActionHint[]) => PlayerAction;

/** Plays the deal out with `policy` for every seat. Caps runaway loops. */
export function rollout(state: MatchState, policy: RolloutPolicy): MatchState {
  let s = state;
  for (let guard = 0; guard < 400; guard++) {
    if (s.winnerSide !== null || !s.deal || s.deal.phase.name === 'scored') return s;
    const actor = expectedActor(s);
    if (actor === null) return s;
    const action = policy(s, actor, allowedActions(s, actor));
    const next = step(s, actor, action);
    if (!next) return s;
    s = next;
  }
  return s;
}

export interface CandidateScore<T> {
  candidate: T;
  mean: number;
  n: number;
}

/**
 * Scores each candidate action on the SAME samples; returns them best-first.
 * `toAction` maps a candidate to the action applied at the root.
 */
export function scoreCandidates<T>(
  samples: readonly MatchState[],
  me: Seat,
  candidates: readonly T[],
  toAction: (c: T) => PlayerAction,
  policy: RolloutPolicy,
): CandidateScore<T>[] {
  const scores = candidates.map((candidate) => ({ candidate, mean: 0, n: 0 }));
  for (const sample of samples) {
    for (const sc of scores) {
      const next = step(sample, me, toAction(sc.candidate));
      if (!next) continue;
      const v = dealValue(rollout(next, policy), me);
      if (v === null) continue;
      sc.mean += v;
      sc.n++;
    }
  }
  for (const sc of scores) sc.mean = sc.n > 0 ? sc.mean / sc.n : Number.NEGATIVE_INFINITY;
  return scores.sort((a, b) => b.mean - a.mean);
}

/**
 * Raw totals of my side over rollouts from each sample after `action` — used
 * to pick the EV-optimal contract from an empirical distribution.
 */
export function sideRawTotals(
  samples: readonly MatchState[],
  me: Seat,
  action: PlayerAction,
  policy: RolloutPolicy,
): Array<{ raw: number; tricks: number }> {
  const out: Array<{ raw: number; tricks: number }> = [];
  for (const sample of samples) {
    const next = step(sample, me, action);
    if (!next) continue;
    const end = rollout(next, policy);
    if (!end.deal || end.deal.phase.name !== 'scored') continue;
    const side = end.deal.phase.result.sides[sideOf(me, end.config.players)];
    if (side) out.push({ raw: side.rawTotal, tricks: side.tricks });
  }
  return out;
}
