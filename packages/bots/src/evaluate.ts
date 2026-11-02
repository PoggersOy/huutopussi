/**
 * Calibrated hand evaluation + expected-value decisions for bidding and the
 * contract. The models are plain linear regressions over config-normalized
 * hand features, fitted OFFLINE by `pnpm calibrate` (src/calibrate.ts) from
 * simulated deals and committed as `calibration.ts`. At runtime this is a dot
 * product — no search, no I/O, fully deterministic.
 *
 * Models per player count (all from the seat's OWN hand only):
 *  - `bid`:      hand at bidding time → expected raw total R of the side if
 *                this seat declares (cards + last trick + marriages + koini
 *                discards).
 *  - `contract`: declarer's hand at contract time (after the exchange or the
 *                talon) → R and its residual σ. Keyed `${players}:${handSize}`
 *                since 4p 'afterExchange' sees 9 cards, 'beforeReturn' 12.
 *  - `declare`:  hand at bidding time → expected deal DIFFERENTIAL (own side's
 *                score delta minus the mean of the other sides') when this
 *                seat wins the auction at the minimum and then picks its
 *                EV-optimal contract.
 *  - `pass`:     hand at bidding time → expected deal differential when this
 *                seat passes and the others bid realistically (they may take
 *                the contract, or everybody passes into a contract-less deal).
 *
 * Bidding compares the two: bid while declare − priceLoss(price) − pass ≥ the
 * level's margin, where priceLoss is what a higher floor costs the contract.
 * Scoring recap (scoring.ts): a made contract scores exactly +C, a failed one
 * −C, so for R ~ N(μ, σ) the contract's EV is C · (2·P(R ≥ C) − 1).
 */
import type { Card, RuleConfig, Suit } from '@hp/engine';
import {
  cardPoints,
  makeCard,
  marriageValue,
  RANKS,
  rankOf,
  SUITS,
  suitOf,
  theoreticalMaxPoints,
} from '@hp/engine';
import { CALIBRATION } from './calibration.js';

export const FEATURE_NAMES = [
  'bias',
  'marriagePts',
  'bestMarriage',
  'halfPts',
  'aces',
  'tens',
  'aceTens',
  'loneTens',
  'kqjPts',
  'longest',
  'second',
  'voids',
  'trumpLen',
  'cards',
  'topSeq',
  'aceTenKing',
  'longTop',
] as const;

export interface LinearModel {
  /** Coefficients aligned with FEATURE_NAMES. */
  w: number[];
  /** Residual standard deviation (points). */
  sigma: number;
}

export interface Calibration {
  /** Keyed by player count ('2' | '3' | '4'). */
  bid: Record<string, LinearModel>;
  /** Keyed by `${players}:${handSize}`. */
  contract: Record<string, LinearModel>;
  declare: Record<string, LinearModel>;
  pass: Record<string, LinearModel>;
  /** Passing while an opponent holds the high bid (that opponent then declares). */
  passContested?: Record<string, LinearModel>;
}

/** Config-normalized features of a hand (see FEATURE_NAMES). */
export function handFeatures(hand: readonly Card[], config: RuleConfig): number[] {
  const bySuit: Record<Suit, Card[]> = { H: [], D: [], C: [], S: [] };
  for (const c of hand) bySuit[suitOf(c)].push(c);
  let marriagePts = 0;
  let bestMarriage = 0;
  let halfPts = 0;
  let aces = 0;
  let tens = 0;
  let aceTens = 0;
  let loneTens = 0;
  let kqjPts = 0;
  let voids = 0;
  let trumpLen = 0;
  // Sure tricks: per suit, the unbroken run from the ace down (A, A-10,
  // A-10-K…); suits holding A-10-K; and length beyond three behind an ace.
  // These separate a hand that can run the table (läpi: every trick, 120+20)
  // from the same aces and tens scattered across suits.
  let topSeq = 0;
  let aceTenKing = 0;
  let longTop = 0;
  const lengths: number[] = [];
  for (const s of SUITS) {
    const cards = bySuit[s];
    lengths.push(cards.length);
    if (cards.length === 0) voids++;
    const has = (r: (typeof RANKS)[number]): boolean => cards.includes(makeCard(s, r));
    const k = has('K');
    const q = has('Q');
    const value = marriageValue(s, config);
    if (k && q) {
      marriagePts += value;
      bestMarriage = Math.max(bestMarriage, value);
      trumpLen = Math.max(trumpLen, cards.length);
    } else if (k || q) {
      halfPts += value;
    }
    if (has('A')) aces++;
    if (has('10')) {
      tens++;
      if (has('A')) aceTens++;
      else if (cards.length <= 2) loneTens++;
    }
    for (const c of cards) {
      const r = rankOf(c);
      if (r === 'K' || r === 'Q' || r === 'J') kqjPts += cardPoints(c, config);
    }
    let run = 0;
    for (const r of RANKS) {
      if (!has(r)) break;
      run++;
    }
    topSeq += run;
    if (has('A') && has('10') && has('K')) aceTenKing++;
    if (has('A')) longTop += Math.max(0, cards.length - 3);
  }
  lengths.sort((a, b) => b - a);
  return [
    1,
    marriagePts,
    bestMarriage,
    halfPts,
    aces,
    tens,
    aceTens,
    loneTens,
    kqjPts,
    lengths[0] ?? 0,
    lengths[1] ?? 0,
    voids,
    trumpLen,
    hand.length,
    topSeq,
    aceTenKing,
    longTop,
  ];
}

export function predict(model: LinearModel, features: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < model.w.length; i++) sum += (model.w[i] ?? 0) * (features[i] ?? 0);
  return sum;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** EV of contract C when the side's raw total is ~N(mu, sigma). */
export function contractEv(c: number, mu: number, sigma: number): number {
  const p = 1 - normCdf((c - mu) / Math.max(1, sigma));
  return c * (2 * p - 1);
}

/**
 * Best contract ≥ `min` (absolute multiples of `step`, ≤ `max`) and its EV.
 * EV is unimodal in C, so the scan stops at the first decrease.
 */
export function bestContract(
  mu: number,
  sigma: number,
  min: number,
  max: number,
  step: number,
): { amount: number; ev: number } {
  const start = Math.ceil(min / step) * step;
  const cap = Math.floor(max / step) * step;
  let best = { amount: Math.max(min, Math.min(start, cap)), ev: contractEv(min, mu, sigma) };
  for (let c = start; c <= cap; c += step) {
    const ev = contractEv(c, mu, sigma);
    if (ev > best.ev) best = { amount: c, ev };
    else if (c > mu) break;
  }
  return best;
}

function modelFor(table: Record<string, LinearModel>, key: string): LinearModel | null {
  return table[key] ?? null;
}

export interface Estimate {
  mu: number;
  sigma: number;
}

/** Expected declarer-side raw total if this hand declares (bidding time). */
export function estimateAsDeclarer(hand: readonly Card[], config: RuleConfig): Estimate | null {
  const m = modelFor(CALIBRATION.bid, String(config.players));
  if (!m) return null;
  return { mu: predict(m, handFeatures(hand, config)), sigma: m.sigma };
}

/** Expected declarer-side raw total at contract time (post exchange/talon). */
export function estimateForContract(hand: readonly Card[], config: RuleConfig): Estimate | null {
  const m =
    modelFor(CALIBRATION.contract, `${config.players}:${hand.length}`) ??
    modelFor(CALIBRATION.bid, String(config.players));
  if (!m) return null;
  return { mu: predict(m, handFeatures(hand, config)), sigma: m.sigma };
}

/** Mean contract-time σ for a mode (how sharp the declarer's final read is). */
function contractSigma(config: RuleConfig): number | null {
  const prefix = `${config.players}:`;
  const sigmas = Object.entries(CALIBRATION.contract)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, m]) => m.sigma);
  return sigmas.length > 0 ? sigmas.reduce((a, b) => a + b, 0) / sigmas.length : null;
}

/**
 * What raising the winning price from the minimum to `price` costs the
 * declarer: the contract can no longer go below it.
 */
export function priceLoss(mu: number, sigma: number, price: number, config: RuleConfig): number {
  const cap = Math.max(price, config.maxBid ?? theoreticalMaxPoints(config));
  const free = bestContract(mu, sigma, config.minBid, cap, config.bidStep).ev;
  const forced = bestContract(mu, sigma, price, cap, config.bidStep).ev;
  return Math.max(0, free - forced);
}

/**
 * Probability that this hand, as declarer, collects at least `price` (the
 * contract can't go below the winning bid), from the bidding-time estimate and
 * σ. `muBonus` shifts the estimate (negative when an opponent's bid signals
 * strength against us). null without calibration.
 */
export function makeProbability(
  hand: readonly Card[],
  config: RuleConfig,
  price: number,
  muBonus = 0,
): number | null {
  const est = estimateAsDeclarer(hand, config);
  if (!est) return null;
  // Bidding-time σ: the exchange/talon is still unknown when we decide.
  return 1 - normCdf((price - (est.mu + muBonus)) / Math.max(1, est.sigma));
}

export interface BidValues {
  /** Expected differential of declaring at the current price. */
  declare: number;
  /** Expected differential of passing. */
  pass: number;
}

/**
 * Both sides of the bidding decision for `hand` at winning price `price`.
 * `muBonus` shifts the declarer's expected raw total (e.g. a partner who bid
 * signals strength). `contested` = an opponent holds the high bid, so passing
 * hands them the contract (the `passContested` model). null when this mode has
 * no calibration.
 */
export function bidValues(
  hand: readonly Card[],
  config: RuleConfig,
  price: number,
  muBonus = 0,
  contested = false,
): BidValues | null {
  const key = String(config.players);
  const decl = modelFor(CALIBRATION.declare, key);
  const pass =
    (contested && CALIBRATION.passContested ? modelFor(CALIBRATION.passContested, key) : null) ??
    modelFor(CALIBRATION.pass, key);
  const est = estimateAsDeclarer(hand, config);
  if (!decl || !pass || !est) return null;
  const x = handFeatures(hand, config);
  const sigma = contractSigma(config) ?? est.sigma;
  const mu = est.mu + muBonus;
  return {
    declare: predict(decl, x) + muBonus - priceLoss(mu, sigma, price, config),
    pass: predict(pass, x),
  };
}

// ── Least squares (used by the calibration CLI and tests) ───────────────────

/**
 * Ridge-regularized least squares via the normal equations + Gaussian
 * elimination with partial pivoting. `lambda` keeps rarely-active features
 * (e.g. voids in 4p) from exploding; the bias term is not regularized.
 */
export function fitLinear(xs: readonly number[][], ys: readonly number[], lambda = 1): LinearModel {
  const n = xs.length;
  const d = xs[0]?.length ?? 0;
  if (n === 0 || d === 0) throw new Error('fitLinear: no data');
  const a: number[][] = Array.from({ length: d }, () => new Array<number>(d + 1).fill(0));
  for (let r = 0; r < n; r++) {
    const x = xs[r] as number[];
    const y = ys[r] as number;
    for (let i = 0; i < d; i++) {
      const xi = x[i] as number;
      const row = a[i] as number[];
      for (let j = 0; j < d; j++) row[j] = (row[j] as number) + xi * (x[j] as number);
      row[d] = (row[d] as number) + xi * y;
    }
  }
  for (let i = 1; i < d; i++) {
    const row = a[i] as number[];
    row[i] = (row[i] as number) + lambda * n * 1e-3;
  }
  for (let col = 0; col < d; col++) {
    let pivot = col;
    for (let r = col + 1; r < d; r++) {
      if (
        Math.abs((a[r] as number[])[col] as number) >
        Math.abs((a[pivot] as number[])[col] as number)
      )
        pivot = r;
    }
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
    const prow = a[col] as number[];
    const pv = prow[col] as number;
    if (Math.abs(pv) < 1e-12) continue;
    for (let j = col; j <= d; j++) prow[j] = (prow[j] as number) / pv;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const row = a[r] as number[];
      const f = row[col] as number;
      if (f === 0) continue;
      for (let j = col; j <= d; j++) row[j] = (row[j] as number) - f * (prow[j] as number);
    }
  }
  const w = a.map((row) => row[d] as number);
  let sse = 0;
  for (let r = 0; r < n; r++) {
    let p = 0;
    const x = xs[r] as number[];
    for (let i = 0; i < d; i++) p += (w[i] as number) * (x[i] as number);
    sse += (p - (ys[r] as number)) ** 2;
  }
  return { w, sigma: Math.sqrt(sse / Math.max(1, n - d)) };
}
