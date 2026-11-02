/**
 * Memory-aware card play ("smart" play, medium level and up). Pure functions
 * over the seat's own view + its Knowledge (memory.ts): no hidden information.
 *
 * Ideas a good club player uses, in priority order:
 *  LEAD
 *   1. Draw trumps: our side owns the trump, opponents may still hold trumps,
 *      and we hold the master trump → lead it.
 *   2. Cash a SAFE master: a card no opponent can beat (no higher outstanding
 *      card they could hold, and no opponent who could be void and ruff it).
 *      Highest points first — aces and tens are what the game is about.
 *   3. Partner ruff (4p): lead low in a suit the partner is known to be void
 *      in, while the partner may hold trumps.
 *   4. Otherwise lead low from the suit that costs least: never from a suit
 *      where we'd expose an unguarded ten, prefer short suits (to create a
 *      void for later ruffs) when we hold trumps, keep our trumps.
 *  FOLLOW (the pakko rules make "win or not" mostly forced)
 *   - Must head: win with the cheapest card that no later opponent can beat;
 *     if none is safe, win as cheaply as possible.
 *   - Cannot win: if the partner's card will stand, smear points onto it;
 *     otherwise dump the cheapest card, keeping masters and trumps.
 */
import type { Card, DealView, RuleConfig, Seat, Suit, TrickPlay } from '@hp/engine';
import {
  beats,
  cardPoints,
  nextSeat,
  partnerOf,
  rankIndex,
  rankOf,
  sideOf,
  suitOf,
  winningPlay,
} from '@hp/engine';
import { ALL_CARDS, type Knowledge } from './memory.js';

/** Smear onto the partner's trick when it holds with at least this probability. */
export const SMEAR_CONFIDENCE = 0.75;

export interface PlayContext {
  deal: DealView;
  me: Seat;
  config: RuleConfig;
  know: Knowledge;
  /** Cards to keep for a declaration whenever a choice exists. */
  reserved: ReadonlySet<Card>;
  /** Smear onto the partner's trick when it holds with at least this probability. */
  smearConfidence?: number;
}

function isOpponent(ctx: PlayContext, seat: Seat): boolean {
  return sideOf(seat, ctx.config.players) !== sideOf(ctx.me, ctx.config.players);
}

/** Could `seat` (≠ me) hold `card` right now? */
function couldHold(ctx: PlayContext, seat: Seat, card: Card): boolean {
  if (seat === ctx.me) return ctx.deal.hand.includes(card);
  if (ctx.know.played.has(card) || ctx.deal.hand.includes(card)) return false;
  return !ctx.know.excluded[seat].has(card);
}

function outstanding(ctx: PlayContext, pred: (c: Card) => boolean): Card[] {
  return ALL_CARDS.filter((c) => pred(c) && !ctx.know.played.has(c) && !ctx.deal.hand.includes(c));
}

/** Could `seat` take a trick currently won by `top` (led suit `led`)? */
function canBeat(ctx: PlayContext, seat: Seat, top: Card, led: Suit, trump: Suit | null): boolean {
  const ledCards = outstanding(ctx, (c) => suitOf(c) === led).filter((c) =>
    couldHold(ctx, seat, c),
  );
  const knownFollows = [...ctx.know.held[seat]].some((c) => suitOf(c) === led);
  if (ledCards.some((c) => beats(c, top, led, trump))) return true;
  // A seat that may be void in the led suit may ruff.
  const mayBeVoid = !knownFollows;
  if (mayBeVoid && trump !== null && led !== trump) {
    return outstanding(ctx, (c) => suitOf(c) === trump).some(
      (c) => couldHold(ctx, seat, c) && beats(c, top, led, trump),
    );
  }
  return false;
}

/** Seats still to play after me in the trick-in-progress. */
function seatsAfterMe(ctx: PlayContext, plays: readonly TrickPlay[]): Seat[] {
  const out: Seat[] = [];
  const total = ctx.config.players;
  let s = ctx.me;
  for (let i = plays.length + 1; i < total; i++) {
    s = nextSeat(s, ctx.config.players);
    out.push(s);
  }
  return out;
}

/**
 * A K or Q whose marriage could still be made: its suit is not yet declared
 * and the other half has not been played (it may be in our or our partner's
 * hand). Such a card is worth far more than its 3–4 points — giving it away
 * can cost a 40–100 point trump — so it is never smeared or dumped while
 * anything else will do.
 */
function liveMarriageHalf(ctx: PlayContext, c: Card): boolean {
  const r = rankOf(c);
  if (r !== 'K' && r !== 'Q') return false;
  const suit = suitOf(c);
  if (ctx.deal.declarations.some((d) => d.suit === suit)) return false;
  const other = `${suit}${r === 'K' ? 'Q' : 'K'}` as Card;
  return !ctx.know.played.has(other);
}

/** P(a hand of `h` cards drawn from a pool of `pool` holds none of `m` given cards). */
function noneOf(pool: number, m: number, h: number): number {
  if (m <= 0) return 1;
  if (m + h > pool) return 0;
  let p = 1;
  for (let i = 0; i < h; i++) p *= (pool - m - i) / (pool - i);
  return p;
}

/**
 * Probability that `top` (now winning) survives every later OPPONENT, from the
 * cards they could still hold (memory exclusions) and their hand sizes:
 * an opponent beats it by holding a higher card of the led suit, or by being
 * void in the led suit and holding a trump that beats it. Hypergeometric over
 * the unknown pool; seats treated as independent (a fair approximation).
 * Exactly 1 when nobody can beat it, so it generalizes `stands`.
 */
function standProbability(
  ctx: PlayContext,
  top: Card,
  later: readonly Seat[],
  led: Suit,
  trump: Suit | null,
): number {
  const pool = outstanding(ctx, () => true).length;
  let p = 1;
  for (const s of later) {
    if (!isOpponent(ctx, s)) continue;
    const known = [...ctx.know.held[s]];
    if (
      known.some(
        (c) =>
          beats(c, top, led, trump) && (suitOf(c) === led || !known.some((k) => suitOf(k) === led)),
      )
    ) {
      return 0;
    }
    const h = Math.max(0, (ctx.deal.handCounts[s] ?? 0) - known.length);
    const higher = outstanding(ctx, (c) => suitOf(c) === led && beats(c, top, led, trump)).filter(
      (c) => couldHold(ctx, s, c) && !known.includes(c),
    ).length;
    const ledLeft = outstanding(ctx, (c) => suitOf(c) === led).filter(
      (c) => couldHold(ctx, s, c) && !known.includes(c),
    ).length;
    let pRuff = 0;
    if (trump !== null && led !== trump && !known.some((c) => suitOf(c) === led)) {
      const ruffers = outstanding(
        ctx,
        (c) => suitOf(c) === trump && beats(c, top, led, trump),
      ).filter((c) => couldHold(ctx, s, c) && !known.includes(c)).length;
      pRuff = noneOf(pool, ledLeft, h) * (1 - noneOf(pool, ruffers, h));
    }
    const pHigh = 1 - noneOf(pool, higher, h);
    p *= (1 - pHigh) * (1 - pRuff);
  }
  return p;
}

/** Would `top` (now winning) stand against every later opponent? */
function stands(
  ctx: PlayContext,
  top: Card,
  later: readonly Seat[],
  led: Suit,
  trump: Suit | null,
): boolean {
  return later.every((s) => !isOpponent(ctx, s) || !canBeat(ctx, s, top, led, trump));
}

function isMaster(ctx: PlayContext, card: Card): boolean {
  const suit = suitOf(card);
  const idx = rankIndex(rankOf(card));
  return !outstanding(ctx, (c) => suitOf(c) === suit && rankIndex(rankOf(c)) < idx).length;
}

function weakest(cards: readonly Card[]): Card {
  return cards.reduce((a, b) => (rankIndex(rankOf(b)) > rankIndex(rankOf(a)) ? b : a));
}

function preferFree(ctx: PlayContext, cards: readonly Card[]): Card[] {
  const free = cards.filter((c) => !ctx.reserved.has(c));
  return free.length > 0 ? free : [...cards];
}

function suitLength(hand: readonly Card[], suit: Suit): number {
  return hand.filter((c) => suitOf(c) === suit).length;
}

export function smartLead(ctx: PlayContext, legal: readonly Card[]): Card {
  const { deal, config } = ctx;
  const trump = deal.trump;
  const pool = preferFree(ctx, legal);
  const opponents = [0, 1, 2, 3]
    .slice(0, config.players)
    .map((s) => s as Seat)
    .filter((s) => isOpponent(ctx, s));
  const others = [0, 1, 2, 3]
    .slice(0, config.players)
    .map((s) => s as Seat)
    .filter((s) => s !== ctx.me);

  // 1. Draw trumps with the master trump.
  if (trump !== null) {
    const ours = deal.declarations.some(
      (d) => d.suit === trump && sideOf(d.seat, config.players) === sideOf(ctx.me, config.players),
    );
    const oppTrumps = outstanding(ctx, (c) => suitOf(c) === trump).filter((c) =>
      opponents.some((o) => couldHold(ctx, o, c)),
    );
    if (ours && oppTrumps.length > 0) {
      const masters = pool.filter((c) => suitOf(c) === trump && isMaster(ctx, c));
      if (masters.length > 0) return weakest(masters);
    }
  }

  // 2. Safe masters, highest points first.
  const safe = pool.filter((c) => stands(ctx, c, others, suitOf(c), trump));
  if (safe.length > 0) {
    const nonTrump = safe.filter((c) => suitOf(c) !== trump);
    const set = nonTrump.length > 0 ? nonTrump : safe;
    return set.reduce((a, b) => {
      const d = cardPoints(b, config) - cardPoints(a, config);
      if (d !== 0) return d > 0 ? b : a;
      return rankIndex(rankOf(b)) > rankIndex(rankOf(a)) ? b : a;
    });
  }

  // 3. Partner ruff (4p).
  if (config.players === 4 && trump !== null) {
    const partner = partnerOf(ctx.me);
    const partnerTrumps = outstanding(ctx, (c) => suitOf(c) === trump).some((c) =>
      couldHold(ctx, partner, c),
    );
    if (partnerTrumps) {
      const voidSuits = (['H', 'D', 'C', 'S'] as const).filter(
        (s) =>
          s !== trump &&
          outstanding(ctx, (c) => suitOf(c) === s).every((c) => !couldHold(ctx, partner, c)) &&
          outstanding(ctx, (c) => suitOf(c) === s).length > 0,
      );
      const ruffLeads = pool.filter((c) =>
        voidSuits.includes(suitOf(c) as (typeof voidSuits)[number]),
      );
      if (ruffLeads.length > 0) return lowestLoss(ctx, ruffLeads);
    }
  }

  // 4. Cheapest low lead.
  return lowestLoss(ctx, pool);
}

/** The card whose loss costs least (points, masters, trumps, guards). */
function lowestLoss(ctx: PlayContext, cards: readonly Card[]): Card {
  const { deal, config } = ctx;
  const trump = deal.trump;
  const holdTrumps = trump !== null && suitLength(deal.hand, trump) > 0;
  const cost = (c: Card): number => {
    const suit = suitOf(c);
    let v = cardPoints(c, config) * 10;
    if (isMaster(ctx, c)) v += 60;
    if (suit === trump) v += 40;
    if (liveMarriageHalf(ctx, c)) v += 200;
    // Leading low under an unguarded ten exposes it.
    const ten = `${suit}10` as Card;
    if (c !== ten && deal.hand.includes(ten) && !isMaster(ctx, ten)) v += 25;
    const len = suitLength(deal.hand, suit);
    if (holdTrumps && suit !== trump) v -= Math.max(0, 3 - len) * 4;
    v += (8 - rankIndex(rankOf(c))) * 0.1;
    return v;
  };
  return cards.reduce((a, b) => (cost(b) < cost(a) ? b : a));
}

export function smartFollow(
  ctx: PlayContext,
  legal: readonly Card[],
  plays: readonly TrickPlay[],
): Card {
  const { deal, config } = ctx;
  const trump = deal.trump;
  const first = plays[0] as TrickPlay;
  const led = suitOf(first.card);
  const win = winningPlay(plays, trump);
  const winners = legal.filter((c) => beats(c, win.card, led, trump));
  const later = seatsAfterMe(ctx, plays);
  const partnerWinning = config.players === 4 && win.seat === partnerOf(ctx.me);

  if (winners.length === legal.length) {
    const pool = preferFree(ctx, winners);
    const safe = pool.filter((c) => stands(ctx, c, later, led, trump));
    if (safe.length > 0) return weakest(safe);
    return weakest(pool);
  }

  if (winners.length === 0) {
    const pool = preferFree(ctx, legal);
    // Give the partner points ("lahjoitus") whenever their card will probably
    // hold — not only when it is certain, which early in a deal (no voids
    // known yet) would almost never be the case.
    const partnerStands =
      partnerWinning &&
      standProbability(ctx, win.card, later, led, trump) >=
        (ctx.smearConfidence ?? SMEAR_CONFIDENCE);
    if (partnerStands) {
      // Smear: points onto the partner's trick, keeping masters for later
      // and never a K/Q whose marriage could still be made.
      const val = (c: Card): number =>
        cardPoints(c, config) -
        (isMaster(ctx, c) && suitOf(c) !== led ? 12 : 0) -
        (suitOf(c) === trump ? 8 : 0) -
        (liveMarriageHalf(ctx, c) ? 100 : 0);
      return pool.reduce((a, b) => (val(b) > val(a) ? b : a));
    }
    return lowestLoss(ctx, pool);
  }

  // Mixed set (not produced by the pakko rules, kept defensive).
  if (!partnerWinning) return weakest(winners);
  const losers = legal.filter((c) => !winners.includes(c));
  return lowestLoss(ctx, preferFree(ctx, losers.length > 0 ? losers : [...legal]));
}
