/**
 * 2p/3p talon-mode specification suite (docs/illisoft-saannot-spec.md §1, §4,
 * §8, §11; ILLISOFT_RULES with players 2|3).
 *
 * Covers: dealStarted deck layout for both talonSize 3 (11-card hands) and 6
 * (10-card hands) — active hands seat-by-seat, then the 2p dummy hand, then
 * the koinipakka; the automatic talon take merging the koinipakka into the
 * declarer's hand; the discard phase (exact count, error.cannotDiscardAceOrTen
 * — including tens that arrived from the talon —, hint legal list = hand minus
 * aces and tens); the 2-3p contract order take → discard → raise with
 * setContract amount = bid meaning "Ohi"; avoin vs salainen koini redaction
 * (talonSeen for every viewer ONLY during the whole first trick when openTalon,
 * never with a secret talon; the dummy hand and the discards are never visible
 * to anyone; no hidden card ever appears in any serialized view); trick sizes
 * 2 and 3 with inactive seats fully locked out; dealer rotation among the
 * active seats (with wrap-around); and the absence of partner asks in 2-3p
 * (error.noPartner) while own-hand declarations still work.
 */
import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../src/config.js';
import { ILLISOFT_RULES } from '../src/config.js';
import { makeDeck, sortHand } from '../src/deck.js';
import { applyEvent, initialMatchState, nextDealEvent } from '../src/reduce.js';
import type { Card, DealState, GameEvent, MatchState, PlayerAction, Seat } from '../src/types.js';
import { isRuleError, SEATS, tricksPerDeal } from '../src/types.js';
import { allowedActions, expectedActor, validateAction } from '../src/validate.js';
import { redactEventFor, redactViewFor } from '../src/view.js';

const RULES_3P: RuleConfig = { ...ILLISOFT_RULES, players: 3 };
const RULES_2P: RuleConfig = { ...ILLISOFT_RULES, players: 2 };
const RULES_3P_TALON6: RuleConfig = { ...RULES_3P, talonSize: 6 };
const RULES_2P_TALON6: RuleConfig = { ...RULES_2P, talonSize: 6 };
const RULES_2P_SECRET: RuleConfig = { ...RULES_2P, openTalon: false };

// ── Deck fixtures ────────────────────────────────────────────────────────────

/** 3p talonSize 3 (11-card hands): seat 0 all hearts + DA D10; seat 1 all
 *  clubs + DK DQ (declarer-to-be: CA forces the ace lead, DK+DQ a marriage);
 *  seat 2 all spades + DJ D9; talon D8 D7 D6 (every talon card discardable). */
const TA0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6', 'DA', 'D10'];
const TA1: Card[] = ['CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6', 'DK', 'DQ'];
const TA2: Card[] = ['SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7', 'S6', 'DJ', 'D9'];
const TA_TALON: Card[] = ['D8', 'D7', 'D6'];
const DECK_3P_TALON3: Card[] = [...TA0, ...TA1, ...TA2, ...TA_TALON];

/** 3p talonSize 6 (10-card hands): the talon carries a TEN (D10) that must
 *  not be discardable after the merge. */
const TB0: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6', 'DA'];
const TB1: Card[] = ['CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6', 'DK'];
const TB2: Card[] = ['SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7', 'S6', 'DQ'];
const TB_TALON: Card[] = ['D10', 'DJ', 'D9', 'D8', 'D7', 'D6'];
const DECK_3P_TALON6: Card[] = [...TB0, ...TB1, ...TB2, ...TB_TALON];

/** 2p talonSize 3 (11-card hands + 11-card dummy): seat 1 (declarer-to-be)
 *  holds three aces; the talon mixes a keeper (D6) with two discards. */
const TC0: Card[] = ['H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6', 'DA', 'D10', 'DK'];
const TC1: Card[] = ['CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6', 'HA', 'SA'];
const TC_DUMMY: Card[] = ['DQ', 'DJ', 'D9', 'D8', 'D7', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8'];
const TC_TALON: Card[] = ['D6', 'S7', 'S6'];
const DECK_2P_TALON3: Card[] = [...TC0, ...TC1, ...TC_DUMMY, ...TC_TALON];

/** 2p talonSize 6 (10-card hands + 10-card dummy + 6-card talon). */
const TD0: Card[] = ['H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6', 'DA', 'D10'];
const TD1: Card[] = ['CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6', 'HA'];
const TD_DUMMY: Card[] = ['SA', 'S10', 'SK', 'SQ', 'SJ', 'S9', 'S8', 'S7', 'S6', 'DK'];
const TD_TALON: Card[] = ['DQ', 'DJ', 'D9', 'D8', 'D7', 'D6'];
const DECK_2P_TALON6: Card[] = [...TD0, ...TD1, ...TD_DUMMY, ...TD_TALON];

// ── Harness ──────────────────────────────────────────────────────────────────

interface Ctx {
  state: MatchState;
  log: GameEvent[];
}

/** Fresh match dealt straight into the bidding phase. */
function freshBidding(
  opts: { scores?: number[]; deck?: Card[]; config?: RuleConfig; dealer?: Seat } = {},
): Ctx {
  const config = opts.config ?? RULES_3P;
  const base = initialMatchState(config, opts.dealer ?? 0);
  const ctx: Ctx = { state: { ...base, scores: opts.scores ?? base.scores }, log: [] };
  const e = nextDealEvent(ctx.state, opts.deck ?? makeDeck());
  ctx.state = applyEvent(ctx.state, e);
  ctx.log.push(e);
  return ctx;
}

/** Applies a valid action, asserting purity, and returns the emitted events. */
function act(ctx: Ctx, seat: Seat, action: PlayerAction): GameEvent[] {
  const before = JSON.stringify(ctx.state);
  const res = validateAction(ctx.state, seat, action);
  if (isRuleError(res)) {
    throw new Error(`unexpected RuleError ${res.code} for seat ${seat} ${JSON.stringify(action)}`);
  }
  let next = ctx.state;
  for (const e of res) next = applyEvent(next, e);
  expect(JSON.stringify(ctx.state), 'validateAction/applyEvent must not mutate input').toBe(before);
  ctx.state = next;
  ctx.log.push(...res);
  return res;
}

/** Asserts a rejection with the exact code (and exact params when given). */
function expectError(
  ctx: Ctx,
  seat: Seat,
  action: PlayerAction,
  code: string,
  params?: Record<string, string | number>,
): void {
  const before = JSON.stringify(ctx.state);
  const res = validateAction(ctx.state, seat, action);
  expect(isRuleError(res), `expected ${code} for seat ${seat} ${JSON.stringify(action)}`).toBe(
    true,
  );
  if (isRuleError(res)) {
    expect(res.code).toBe(code);
    if (params !== undefined) expect(res.params).toEqual(params);
  }
  expect(JSON.stringify(ctx.state), 'a rejected action must not mutate state').toBe(before);
}

function dealOf(ctx: Ctx): DealState {
  const deal = ctx.state.deal;
  if (!deal) throw new Error('expected a deal in progress');
  return deal;
}

const VIEWERS: ReadonlyArray<Seat | 'spectator'> = [...SEATS, 'spectator'];

/**
 * Asserts that no viewer's serialized view contains a card the spec hides
 * from them: another seat's hand, the 2p dummy hand, the declarer's discards,
 * or an untaken talon. `publicCards` is the ONLY sanctioned exception (avoin
 * koini: the original talon faces during the whole first trick). Cards appear
 * in view JSON solely as quoted strings, so searching for the quoted token is
 * an exact match (no substring collisions).
 */
function assertNoHiddenCards(state: MatchState, publicCards: readonly Card[] = []): void {
  const deal = state.deal;
  expect(deal).not.toBeNull();
  if (!deal) return;
  for (const viewer of VIEWERS) {
    const json = JSON.stringify(redactViewFor(state, viewer));
    const hidden: Array<[string, readonly Card[]]> = [
      ['the dummy hand', deal.dummyHand ?? []],
      ['the discards', deal.discarded ?? []],
      ['the untaken talon', deal.talonTakenBy === null ? (deal.talon ?? []) : []],
    ];
    for (const seat of SEATS) {
      if (seat !== viewer) hidden.push([`seat ${seat}'s hand`, deal.hands[seat]]);
    }
    for (const [what, cards] of hidden) {
      for (const card of cards) {
        if (publicCards.includes(card)) continue;
        expect(
          json.includes(`"${card}"`),
          `view of ${String(viewer)} leaks ${card} from ${what}`,
        ).toBe(false);
      }
    }
  }
}

/** Asserts talonSeen for every viewer: the given faces, or null. */
function expectTalonSeen(ctx: Ctx, expected: readonly Card[] | null): void {
  for (const viewer of VIEWERS) {
    const dv = redactViewFor(ctx.state, viewer).deal;
    expect(dv, 'expected a deal view').not.toBeNull();
    if (expected === null) {
      expect(dv?.talonSeen, `talonSeen must be null for ${String(viewer)}`).toBeNull();
    } else {
      expect(dv?.talonSeen, `talonSeen must be public for ${String(viewer)}`).toEqual(expected);
    }
  }
}

/** 3p, dealer 0: auction ends with declarer seat 1 at 60 (talon auto-taken). */
function to3pDiscard(config: RuleConfig = RULES_3P, deck: Card[] = DECK_3P_TALON3): Ctx {
  const ctx = freshBidding({ config, deck });
  act(ctx, 1, { type: 'bid', amount: 60 });
  act(ctx, 2, { type: 'pass' });
  act(ctx, 0, { type: 'pass' });
  return ctx;
}

/** 3p flow through discard and an "Ohi" contract into the first lead. */
function to3pOhi(): Ctx {
  const ctx = to3pDiscard();
  act(ctx, 1, { type: 'discardCards', cards: ['D8', 'D7', 'D6'] });
  act(ctx, 1, { type: 'setContract', amount: 60 });
  return ctx;
}

/** 2p, dealer 1: seat 0 passes, seat 1 wins at 60 (talon auto-taken). */
function to2pDiscard(config: RuleConfig = RULES_2P, deck: Card[] = DECK_2P_TALON3): Ctx {
  const ctx = freshBidding({ config, deck, dealer: 1 });
  act(ctx, 0, { type: 'pass' });
  act(ctx, 1, { type: 'bid', amount: 60 });
  return ctx;
}

// ── Fixture sanity ───────────────────────────────────────────────────────────

describe('deck fixtures', () => {
  it('are valid 36-card permutations', () => {
    const full = makeDeck().sort();
    expect([...DECK_3P_TALON3].sort()).toEqual(full);
    expect([...DECK_3P_TALON6].sort()).toEqual(full);
    expect([...DECK_2P_TALON3].sort()).toEqual(full);
    expect([...DECK_2P_TALON6].sort()).toEqual(full);
  });
});

// ── Deal layout (spec §1, §11 dealStarted.deck) ──────────────────────────────

describe('deal layout', () => {
  it('3p talonSize 3: three 11-card hands seat-by-seat, then a 3-card talon', () => {
    const ctx = freshBidding({ deck: DECK_3P_TALON3 });
    expect(tricksPerDeal(RULES_3P)).toBe(11);
    expect(ctx.state.scores).toEqual([0, 0, 0]);
    const deal = dealOf(ctx);
    expect(deal.hands[0]).toEqual(TA0);
    expect(deal.hands[1]).toEqual(TA1);
    expect(deal.hands[2]).toEqual(TA2);
    expect(deal.hands[3]).toEqual([]);
    expect(deal.dummyHand).toBeNull();
    expect(deal.talon).toEqual(TA_TALON);
    expect(deal.talonTakenBy).toBeNull();
    expect(deal.discarded).toBeNull();
  });

  it('3p talonSize 6: three 10-card hands, then a 6-card talon', () => {
    const ctx = freshBidding({ config: RULES_3P_TALON6, deck: DECK_3P_TALON6 });
    expect(tricksPerDeal(RULES_3P_TALON6)).toBe(10);
    const deal = dealOf(ctx);
    expect(deal.hands[0]).toEqual(TB0);
    expect(deal.hands[1]).toEqual(TB1);
    expect(deal.hands[2]).toEqual(TB2);
    expect(deal.hands[3]).toEqual([]);
    expect(deal.dummyHand).toBeNull();
    expect(deal.talon).toEqual(TB_TALON);
  });

  it('2p talonSize 3: two 11-card hands, the dead dummy hand, then the talon', () => {
    const ctx = freshBidding({ config: RULES_2P, deck: DECK_2P_TALON3 });
    expect(tricksPerDeal(RULES_2P)).toBe(11);
    expect(ctx.state.scores).toEqual([0, 0]);
    const deal = dealOf(ctx);
    expect(deal.hands[0]).toEqual(TC0);
    expect(deal.hands[1]).toEqual(TC1);
    expect(deal.hands[2]).toEqual([]);
    expect(deal.hands[3]).toEqual([]);
    expect(deal.dummyHand).toEqual(TC_DUMMY);
    expect(deal.talon).toEqual(TC_TALON);
    expect(deal.talonTakenBy).toBeNull();
  });

  it('2p talonSize 6: two 10-card hands, a 10-card dummy, then a 6-card talon', () => {
    const ctx = freshBidding({ config: RULES_2P_TALON6, deck: DECK_2P_TALON6 });
    expect(tricksPerDeal(RULES_2P_TALON6)).toBe(10);
    const deal = dealOf(ctx);
    expect(deal.hands[0]).toEqual(TD0);
    expect(deal.hands[1]).toEqual(TD1);
    expect(deal.hands[2]).toEqual([]);
    expect(deal.hands[3]).toEqual([]);
    expect(deal.dummyHand).toEqual(TD_DUMMY);
    expect(deal.talon).toEqual(TD_TALON);
  });

  it('4p deals no talon and no dummy hand', () => {
    const ctx = freshBidding({ config: ILLISOFT_RULES });
    const deal = dealOf(ctx);
    expect(deal.talon).toBeNull();
    expect(deal.dummyHand).toBeNull();
    for (const seat of SEATS) expect(deal.hands[seat]).toHaveLength(9);
  });

  it('bidding opens left of dealer among the active seats (wrapping past them)', () => {
    const wrap3p = freshBidding({ deck: DECK_3P_TALON3, dealer: 2 });
    expect(expectedActor(wrap3p.state)).toBe(0); // nextSeat(2) wraps to 0 in 3p
    const wrap2p = freshBidding({ config: RULES_2P, deck: DECK_2P_TALON3, dealer: 1 });
    expect(expectedActor(wrap2p.state)).toBe(0);
  });

  it('inactive seats never act: no hints, error.notYourTurn on any attempt', () => {
    const p3 = freshBidding({ deck: DECK_3P_TALON3 });
    expect(allowedActions(p3.state, 3)).toEqual([]);
    expectError(p3, 3, { type: 'bid', amount: 60 }, 'error.notYourTurn');
    expectError(p3, 3, { type: 'pass' }, 'error.notYourTurn');

    const p2 = freshBidding({ config: RULES_2P, deck: DECK_2P_TALON3, dealer: 1 });
    for (const seat of [2, 3] as const) {
      expect(allowedActions(p2.state, seat)).toEqual([]);
      expectError(p2, seat, { type: 'bid', amount: 60 }, 'error.notYourTurn');
      expectError(p2, seat, { type: 'pass' }, 'error.notYourTurn');
    }
  });
});

// ── Talon take & discard (spec §4) ───────────────────────────────────────────

describe('talon take and discard', () => {
  it('the winning bid takes the talon into the declarer hand automatically', () => {
    const ctx = freshBidding({ deck: DECK_3P_TALON3 });
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'biddingEnded', declarer: 1, amount: 60 },
      { type: 'talonTaken', seat: 1 },
    ]);
    const deal = dealOf(ctx);
    expect(deal.phase).toEqual({ name: 'exchangeDiscard' });
    expect(deal.talonTakenBy).toBe(1);
    expect(deal.talon, 'original talon faces stay recorded').toEqual(TA_TALON);
    expect(deal.hands[1]).toHaveLength(14);
    expect([...deal.hands[1]].sort()).toEqual([...TA1, ...TA_TALON].sort());
    expect(deal.discarded).toBeNull();
    // only the declarer acts in the discard phase
    expect(expectedActor(ctx.state)).toBe(1);
    expect(allowedActions(ctx.state, 0)).toEqual([]);
    expect(allowedActions(ctx.state, 2)).toEqual([]);
  });

  it('advertises exactly the non-ace-non-ten cards as discardable', () => {
    const ctx = to3pDiscard();
    const hints = allowedActions(ctx.state, 1);
    expect(hints).toHaveLength(1);
    const hint = hints[0];
    if (hint?.type !== 'discardCards') throw new Error('expected a discardCards hint');
    expect(hint.count).toBe(3);
    expect([...hint.legal].sort()).toEqual(
      ['CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6', 'DK', 'DQ', 'D8', 'D7', 'D6'].sort(),
    );
  });

  it('enforces discarding exactly talonSize cards', () => {
    const ctx = to3pDiscard();
    expectError(ctx, 1, { type: 'discardCards', cards: [] }, 'error.wrongCardCount', {
      expected: 3,
    });
    expectError(ctx, 1, { type: 'discardCards', cards: ['D8', 'D7'] }, 'error.wrongCardCount', {
      expected: 3,
    });
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['D8', 'D7', 'D6', 'DK'] },
      'error.wrongCardCount',
      { expected: 3 },
    );
  });

  it('rejects aces and tens with error.cannotDiscardAceOrTen', () => {
    const ctx = to3pDiscard();
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['CA', 'CK', 'CQ'] },
      'error.cannotDiscardAceOrTen',
      { card: 'CA' },
    );
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['C10', 'CK', 'CQ'] },
      'error.cannotDiscardAceOrTen',
      { card: 'C10' },
    );
  });

  it('rejects cards not in hand, and duplicates of a single copy', () => {
    const ctx = to3pDiscard();
    // HA sits in seat 0's hand, not the declarer's
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['CK', 'CQ', 'HA'] },
      'error.cardNotInHand',
      {
        card: 'HA',
      },
    );
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['DK', 'DK', 'DQ'] },
      'error.cardNotInHand',
      {
        card: 'DK',
      },
    );
  });

  it('only the declarer may discard', () => {
    const ctx = to3pDiscard();
    expectError(ctx, 0, { type: 'discardCards', cards: ['HK', 'HQ', 'HJ'] }, 'error.notYourTurn');
    expectError(ctx, 2, { type: 'discardCards', cards: ['SK', 'SQ', 'SJ'] }, 'error.notYourTurn');
    expectError(ctx, 3, { type: 'discardCards', cards: ['D8', 'D7', 'D6'] }, 'error.notYourTurn');
  });

  it('a valid discard removes the cards, records them and opens the raise', () => {
    const ctx = to3pDiscard();
    expect(act(ctx, 1, { type: 'discardCards', cards: ['D8', 'D7', 'D6'] })).toEqual([
      { type: 'cardsDiscarded', seat: 1, cards: ['D8', 'D7', 'D6'] },
    ]);
    const deal = dealOf(ctx);
    expect(deal.phase).toEqual({ name: 'exchangeContract' });
    expect(deal.discarded).toEqual(['D8', 'D7', 'D6']);
    expect(deal.hands[1]).toHaveLength(11);
    expect([...deal.hands[1]].sort()).toEqual([...TA1].sort());
    expect(deal.talon, 'the talon record never mutates').toEqual(TA_TALON);
  });

  it('talonSize 6: 16-card merge, 6-card discard, talon tens stay locked', () => {
    const ctx = to3pDiscard(RULES_3P_TALON6, DECK_3P_TALON6);
    const deal = dealOf(ctx);
    expect(deal.hands[1]).toHaveLength(16);
    expect([...deal.hands[1]].sort()).toEqual([...TB1, ...TB_TALON].sort());
    const hints = allowedActions(ctx.state, 1);
    expect(hints).toHaveLength(1);
    const hint = hints[0];
    if (hint?.type !== 'discardCards') throw new Error('expected a discardCards hint');
    expect(hint.count).toBe(6);
    expect([...hint.legal].sort()).toEqual(
      ['CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'C6', 'DK', 'DJ', 'D9', 'D8', 'D7', 'D6'].sort(),
    );
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['DJ', 'D9', 'D8'] },
      'error.wrongCardCount',
      {
        expected: 6,
      },
    );
    // the D10 arrived from the talon — still not discardable
    expectError(
      ctx,
      1,
      { type: 'discardCards', cards: ['D10', 'DJ', 'D9', 'D8', 'D7', 'D6'] },
      'error.cannotDiscardAceOrTen',
      { card: 'D10' },
    );
    act(ctx, 1, { type: 'discardCards', cards: ['DK', 'DJ', 'D9', 'D8', 'D7', 'D6'] });
    expect(dealOf(ctx).hands[1]).toHaveLength(10);
    expect(dealOf(ctx).phase).toEqual({ name: 'exchangeContract' });
  });

  it('2p: merge and a mixed discard keeping a talon card in hand', () => {
    const ctx = to2pDiscard();
    const deal = dealOf(ctx);
    expect(deal.talonTakenBy).toBe(1);
    expect(deal.hands[1]).toHaveLength(14);
    expect([...deal.hands[1]].sort()).toEqual([...TC1, ...TC_TALON].sort());
    expect(deal.dummyHand, 'the dummy never mixes into the exchange').toEqual(TC_DUMMY);
    expectError(ctx, 0, { type: 'discardCards', cards: ['HK', 'HQ', 'HJ'] }, 'error.notYourTurn');
    // discard one original-hand card plus two talon cards, keeping talon D6
    act(ctx, 1, { type: 'discardCards', cards: ['C6', 'S7', 'S6'] });
    expect(dealOf(ctx).discarded).toEqual(['C6', 'S7', 'S6']);
    expect([...dealOf(ctx).hands[1]].sort()).toEqual(
      ['CA', 'C10', 'CK', 'CQ', 'CJ', 'C9', 'C8', 'C7', 'HA', 'SA', 'D6'].sort(),
    );
  });
});

// ── Contract timing: take → discard → raise (spec §4) ───────────────────────

describe('2-3p contract timing (take → discard → raise)', () => {
  it('rejects every phase action attempted out of order', () => {
    const ctx = freshBidding({ deck: DECK_3P_TALON3 });
    // bidding: the whole exchange is premature
    expectError(ctx, 1, { type: 'discardCards', cards: ['DK', 'DQ', 'C6'] }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'setContract', amount: 60 }, 'error.notInPhase');
    act(ctx, 1, { type: 'bid', amount: 60 });
    act(ctx, 2, { type: 'pass' });
    act(ctx, 0, { type: 'pass' });
    // exchangeDiscard: raise, play and the 4p exchange are all alien
    expect(dealOf(ctx).phase).toEqual({ name: 'exchangeDiscard' });
    expectError(ctx, 1, { type: 'setContract', amount: 60 }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'giveCards', cards: ['DK', 'DQ', 'C6'] }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'returnCards', cards: ['DK', 'DQ', 'C6'] }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'playCard', card: 'CA' }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'bid', amount: 100 }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'declareOwn', suit: 'D' }, 'error.notInPhase');
    act(ctx, 1, { type: 'discardCards', cards: ['D8', 'D7', 'D6'] });
    // exchangeContract: the discard is spent; only the raise decision remains
    expect(dealOf(ctx).phase).toEqual({ name: 'exchangeContract' });
    expectError(ctx, 1, { type: 'discardCards', cards: ['DK', 'DQ', 'C6'] }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'playCard', card: 'CA' }, 'error.notInPhase');
    expectError(ctx, 2, { type: 'setContract', amount: 60 }, 'error.notYourTurn');
    expect(allowedActions(ctx.state, 1)).toEqual([
      { type: 'setContract', min: 60, max: 420, step: 5 },
    ]);
    expectError(ctx, 1, { type: 'setContract', amount: 55 }, 'error.contractTooLow', { min: 60 });
    expectError(ctx, 1, { type: 'setContract', amount: 62 }, 'error.contractNotMultiple', {
      step: 5,
    });
    expectError(ctx, 1, { type: 'setContract', amount: 425 }, 'error.contractTooHigh', {
      max: 420,
    });
    // "Ohi": contract = bid means no raise; the declarer leads trick 1
    act(ctx, 1, { type: 'setContract', amount: 60 });
    expect(dealOf(ctx).contract).toBe(60);
    expect(dealOf(ctx).bid).toEqual({ seat: 1, amount: 60 });
    expect(dealOf(ctx).phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    expectError(ctx, 1, { type: 'discardCards', cards: ['DK', 'DQ', 'C6'] }, 'error.notInPhase');
    expectError(ctx, 1, { type: 'setContract', amount: 100 }, 'error.notInPhase');
  });

  it('the declarer may raise the contract after the discard; the bid stands', () => {
    const ctx = to3pDiscard();
    act(ctx, 1, { type: 'discardCards', cards: ['D8', 'D7', 'D6'] });
    act(ctx, 1, { type: 'setContract', amount: 100 });
    expect(dealOf(ctx).contract).toBe(100);
    expect(dealOf(ctx).bid).toEqual({ seat: 1, amount: 60 });
    expect(dealOf(ctx).phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
  });
});

// ── Open vs secret talon redaction (spec §1, §11 DealView) ───────────────────

describe('talon redaction (avoin vs salainen koini)', () => {
  it('avoin koini: every viewer sees the talon during the whole first trick only', () => {
    const ctx = freshBidding({ config: RULES_2P, deck: DECK_2P_TALON3, dealer: 1 });
    // bidding: the untaken talon shows as a count only, dummy as a count
    expectTalonSeen(ctx, null);
    for (const viewer of VIEWERS) {
      const dv = redactViewFor(ctx.state, viewer).deal;
      expect(dv?.talonCount).toBe(3);
      expect(dv?.dummyHandCount).toBe(11);
      expect(dv?.discardedCount).toBeNull();
    }
    assertNoHiddenCards(ctx.state);
    act(ctx, 0, { type: 'pass' });
    act(ctx, 1, { type: 'bid', amount: 60 }); // + biddingEnded + talonTaken
    // exchangeDiscard: merged into the declarer's hand, faces still private
    expectTalonSeen(ctx, null);
    expect(redactViewFor(ctx.state, 1).deal?.hand).toEqual(sortHand([...TC1, ...TC_TALON]));
    expect(redactViewFor(ctx.state, 0).deal?.handCounts).toEqual({ 0: 11, 1: 14, 2: 0, 3: 0 });
    for (const viewer of VIEWERS) {
      expect(redactViewFor(ctx.state, viewer).deal?.talonCount).toBe(0);
    }
    assertNoHiddenCards(ctx.state);
    act(ctx, 1, { type: 'discardCards', cards: ['C6', 'S7', 'S6'] });
    // exchangeContract: discards show as a count only, for everyone
    expectTalonSeen(ctx, null);
    for (const viewer of VIEWERS) {
      expect(redactViewFor(ctx.state, viewer).deal?.discardedCount).toBe(3);
    }
    assertNoHiddenCards(ctx.state);
    act(ctx, 1, { type: 'setContract', amount: 60 });
    // trick 1 lead: the ORIGINAL talon faces are public to all viewers
    expectTalonSeen(ctx, TC_TALON);
    assertNoHiddenCards(ctx.state, TC_TALON);
    act(ctx, 1, { type: 'playCard', card: 'HA' });
    // mid-trick (follow): still public
    expectTalonSeen(ctx, TC_TALON);
    assertNoHiddenCards(ctx.state, TC_TALON);
    act(ctx, 0, { type: 'playCard', card: 'H6' });
    // trick 1 complete: hidden again — the kept D6 sits in the declarer's hand
    expect(dealOf(ctx).tricksPlayed).toBe(1);
    expectTalonSeen(ctx, null);
    assertNoHiddenCards(ctx.state);
  });

  it('salainen koini: talonSeen stays null for every viewer at every stage', () => {
    const ctx = freshBidding({ config: RULES_2P_SECRET, deck: DECK_2P_TALON3, dealer: 1 });
    const steps: Array<[Seat, PlayerAction]> = [
      [0, { type: 'pass' }],
      [1, { type: 'bid', amount: 60 }],
      [1, { type: 'discardCards', cards: ['C6', 'S7', 'S6'] }],
      [1, { type: 'setContract', amount: 60 }],
      [1, { type: 'playCard', card: 'HA' }],
      [0, { type: 'playCard', card: 'H6' }],
      [1, { type: 'playCard', card: 'CA' }], // trick 2 lead: still secret
    ];
    expectTalonSeen(ctx, null);
    assertNoHiddenCards(ctx.state);
    for (const [seat, action] of steps) {
      act(ctx, seat, action);
      expectTalonSeen(ctx, null);
      assertNoHiddenCards(ctx.state); // no public-talon exception, ever
    }
  });

  it('contract-less deal: the untaken open talon is shown during trick 1 only', () => {
    const ctx = freshBidding({ deck: DECK_3P_TALON3 });
    act(ctx, 1, { type: 'pass' });
    act(ctx, 2, { type: 'pass' });
    expect(act(ctx, 0, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 0 },
      { type: 'allPassed' },
    ]);
    expect(dealOf(ctx).phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    expect(dealOf(ctx).talonTakenBy).toBeNull();
    expectTalonSeen(ctx, TA_TALON);
    for (const viewer of VIEWERS) {
      expect(redactViewFor(ctx.state, viewer).deal?.talonCount).toBe(3);
    }
    assertNoHiddenCards(ctx.state, TA_TALON);
    act(ctx, 1, { type: 'playCard', card: 'CA' });
    act(ctx, 2, { type: 'playCard', card: 'S6' });
    act(ctx, 0, { type: 'playCard', card: 'H6' });
    // trick 1 done: the talon goes dark for the rest of the deal
    expectTalonSeen(ctx, null);
    for (const viewer of VIEWERS) {
      expect(redactViewFor(ctx.state, viewer).deal?.talonCount).toBe(3);
    }
    assertNoHiddenCards(ctx.state);
  });

  it('4p views keep every talon/dummy/discard field null', () => {
    const ctx = freshBidding({ config: ILLISOFT_RULES });
    for (const viewer of VIEWERS) {
      const dv = redactViewFor(ctx.state, viewer).deal;
      expect(dv?.talonCount).toBeNull();
      expect(dv?.talonSeen).toBeNull();
      expect(dv?.dummyHandCount).toBeNull();
      expect(dv?.discardedCount).toBeNull();
    }
  });

  it('cardsDiscarded faces reach only the discarding declarer', () => {
    const event: GameEvent = { type: 'cardsDiscarded', seat: 1, cards: ['C6', 'S7', 'S6'] };
    expect(redactEventFor(event, 1)).toEqual(event);
    for (const viewer of [0, 2, 3, 'spectator'] as const) {
      expect(redactEventFor(event, viewer)).toEqual({ ...event, cards: [] });
    }
    // talonTaken carries no faces and stays public
    const taken: GameEvent = { type: 'talonTaken', seat: 1 };
    for (const viewer of VIEWERS) expect(redactEventFor(taken, viewer)).toEqual(taken);
  });
});

// ── Declarations in 2-3p: own hand only (spec §7) ────────────────────────────

describe('2-3p declarations', () => {
  it('3p: asks are error.noPartner; an own-hand marriage still declares', () => {
    const ctx = to3pOhi();
    // trick 1: the declarer's forced ace lead, then two free dumps
    expect(allowedActions(ctx.state, 1)).toEqual([{ type: 'playCard', legal: ['CA'] }]);
    act(ctx, 1, { type: 'playCard', card: 'CA' });
    act(ctx, 2, { type: 'playCard', card: 'S6' });
    expect(act(ctx, 0, { type: 'playCard', card: 'H6' })).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'H6' },
      { type: 'trickWon', seat: 1, trickIndex: 0, canDeclareNext: true },
    ]);
    // the winner may declare before leading — but 2-3p seats have no partner
    expectError(ctx, 1, { type: 'askWhole' }, 'error.noPartner');
    expectError(ctx, 1, { type: 'askHalf', suit: 'D', rankHeld: 'K' }, 'error.noPartner');
    expectError(ctx, 1, { type: 'answerWhole', suit: 'D' }, 'error.notInPhase');
    // the hint offers own marriages only (DK+DQ, CK+CQ): no asks of any kind
    expect(allowedActions(ctx.state, 1)[0]).toEqual({
      type: 'declaration',
      ownSuits: ['D', 'C'],
      canAskWhole: false,
      halfAsks: [],
    });
    expect(act(ctx, 1, { type: 'declareOwn', suit: 'D' })).toEqual([
      { type: 'declaredOwn', seat: 1, suit: 'D' },
      { type: 'trumpSet', suit: 'D', seat: 1, side: 1, how: 'own', points: 80 },
    ]);
    expect(dealOf(ctx).trump).toBe('D');
    expect(dealOf(ctx).declarations).toEqual([
      { suit: 'D', seat: 1, side: 1, how: 'own', trickIndex: 1, points: 80 },
    ]);
    // diamonds now trump: void followers must trump and overtrump, 3 to a trick
    act(ctx, 1, { type: 'playCard', card: 'C10' });
    expect(allowedActions(ctx.state, 2)).toEqual([{ type: 'playCard', legal: ['DJ', 'D9'] }]);
    act(ctx, 2, { type: 'playCard', card: 'D9' });
    expect(allowedActions(ctx.state, 0)).toEqual([{ type: 'playCard', legal: ['DA', 'D10'] }]);
    expect(act(ctx, 0, { type: 'playCard', card: 'D10' })).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'D10' },
      { type: 'trickWon', seat: 0, trickIndex: 1, canDeclareNext: true },
    ]);
  });
});

// ── Full deals: trick sizes, dealer rotation, side scoring (spec §1, §8) ─────

describe('full deals and dealer rotation', () => {
  it('2p: tricks of two, made Ohi contract, dealer wraps 1 → 0', () => {
    const ctx = to2pDiscard(); // dealer 1, declarer 1 at 60
    act(ctx, 1, { type: 'discardCards', cards: ['C6', 'S7', 'S6'] });
    act(ctx, 1, { type: 'setContract', amount: 60 }); // Ohi
    expect(dealOf(ctx).phase).toEqual({ name: 'lead', leader: 1, canDeclare: false });
    // first lead is ace-constrained (the declarer holds three aces)
    const leadHint = allowedActions(ctx.state, 1)[0];
    if (leadHint?.type !== 'playCard') throw new Error('expected a playCard hint');
    expect([...leadHint.legal].sort()).toEqual(['CA', 'HA', 'SA'].sort());
    // trick size 2: the follower's card completes the trick
    act(ctx, 1, { type: 'playCard', card: 'HA' });
    expect(expectedActor(ctx.state)).toBe(0);
    expectError(ctx, 1, { type: 'playCard', card: 'CA' }, 'error.notYourTurn');
    expectError(ctx, 2, { type: 'playCard', card: 'CA' }, 'error.notYourTurn');
    expect(act(ctx, 0, { type: 'playCard', card: 'H6' })).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'H6' },
      { type: 'trickWon', seat: 1, trickIndex: 0, canDeclareNext: true },
    ]);
    // no partner to ask in 2p either; own marriages remain declarable
    expectError(ctx, 1, { type: 'askWhole' }, 'error.noPartner');
    expectError(ctx, 1, { type: 'askHalf', suit: 'C', rankHeld: 'K' }, 'error.noPartner');
    const hints = allowedActions(ctx.state, 1);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toEqual({
      type: 'declaration',
      ownSuits: ['C'],
      canAskWhole: false,
      halfAsks: [],
    });
    // tricks 2-10: club run + SA, seat 0 dumps hearts then diamonds
    const rest: Array<[Card, Card]> = [
      ['CA', 'H7'],
      ['C10', 'H8'],
      ['CK', 'H9'],
      ['CQ', 'HJ'],
      ['CJ', 'HQ'],
      ['C9', 'HK'],
      ['C8', 'H10'],
      ['C7', 'DK'],
      ['SA', 'D10'],
    ];
    rest.forEach(([lead, dump], i) => {
      act(ctx, 1, { type: 'playCard', card: lead });
      expect(act(ctx, 0, { type: 'playCard', card: dump })).toEqual([
        { type: 'cardPlayed', seat: 0, card: dump },
        { type: 'trickWon', seat: 1, trickIndex: i + 1, canDeclareNext: true },
      ]);
    });
    // trick 11: the kept talon D6 loses to the forced DA — no läpäri
    act(ctx, 1, { type: 'playCard', card: 'D6' });
    expect(allowedActions(ctx.state, 0)).toEqual([{ type: 'playCard', legal: ['DA'] }]);
    const expectedResult = {
      declarer: 1,
      contract: 60,
      bid: 60,
      made: true,
      sides: [
        {
          cardPoints: 11,
          lastTrickBonus: 20,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 31,
          roundedTotal: 30,
          tricks: 1,
          porvoo: false,
          scoreDelta: 30,
        },
        {
          cardPoints: 85,
          lastTrickBonus: 0,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 85,
          roundedTotal: 85,
          tricks: 10,
          porvoo: false,
          scoreDelta: 60,
        },
      ],
    };
    expect(act(ctx, 0, { type: 'playCard', card: 'DA' })).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'DA' },
      { type: 'trickWon', seat: 0, trickIndex: 10, canDeclareNext: false },
      { type: 'dealScored', result: expectedResult },
    ]);
    expect(ctx.state.scores).toEqual([30, 60]);
    expect(ctx.state.winnerSide).toBeNull();
    // dealer rotation wraps among the two active seats: 1 → 0
    const next = nextDealEvent(ctx.state, DECK_2P_TALON3);
    expect(next).toEqual({
      type: 'dealStarted',
      dealIndex: 1,
      dealer: 0,
      deck: DECK_2P_TALON3,
    });
    ctx.state = applyEvent(ctx.state, next);
    ctx.log.push(next);
    expect(expectedActor(ctx.state)).toBe(1); // left of the new dealer 0
    // replay determinism: the event log reproduces the final state
    let replayed = initialMatchState(RULES_2P, 1);
    for (const e of ctx.log) replayed = applyEvent(replayed, e);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(ctx.state));
  });

  it('3p: tricks of three, failed raise costs the contract, dealer wraps 2 → 0', () => {
    const ctx = freshBidding({ deck: DECK_3P_TALON3, dealer: 2 });
    expect(expectedActor(ctx.state)).toBe(0);
    act(ctx, 0, { type: 'pass' });
    act(ctx, 1, { type: 'bid', amount: 60 });
    expect(act(ctx, 2, { type: 'pass' })).toEqual([
      { type: 'passed', seat: 2 },
      { type: 'biddingEnded', declarer: 1, amount: 60 },
      { type: 'talonTaken', seat: 1 },
    ]);
    act(ctx, 1, { type: 'discardCards', cards: ['D8', 'D7', 'D6'] });
    act(ctx, 1, { type: 'setContract', amount: 100 }); // raise after the exchange
    // trick 1, size 3: the trick resolves only after the third card
    act(ctx, 1, { type: 'playCard', card: 'CA' });
    expect(dealOf(ctx).phase).toEqual({
      name: 'follow',
      leader: 1,
      plays: [{ seat: 1, card: 'CA' }],
    });
    expect(expectedActor(ctx.state)).toBe(2);
    expectError(ctx, 0, { type: 'playCard', card: 'H6' }, 'error.notYourTurn');
    expectError(ctx, 3, { type: 'playCard', card: 'H6' }, 'error.notYourTurn');
    act(ctx, 2, { type: 'playCard', card: 'S6' });
    expect(dealOf(ctx).phase.name).toBe('follow'); // 2 of 3 cards: still open
    expect(expectedActor(ctx.state)).toBe(0);
    expect(act(ctx, 0, { type: 'playCard', card: 'H6' })).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'H6' },
      { type: 'trickWon', seat: 1, trickIndex: 0, canDeclareNext: true },
    ]);
    expect(dealOf(ctx).tricksPlayed).toBe(1);
    // tricks 2-9: the club run — seats 2 and 0 are void and dump freely
    const dumps: Array<[Card, Card, Card]> = [
      ['C10', 'S7', 'H7'],
      ['CK', 'S8', 'H8'],
      ['CQ', 'S9', 'H9'],
      ['CJ', 'SJ', 'HJ'],
      ['C9', 'SQ', 'HQ'],
      ['C8', 'SK', 'HK'],
      ['C7', 'S10', 'H10'],
      ['C6', 'SA', 'HA'],
    ];
    dumps.forEach(([lead, dump2, dump0], i) => {
      act(ctx, 1, { type: 'playCard', card: lead });
      act(ctx, 2, { type: 'playCard', card: dump2 });
      expect(act(ctx, 0, { type: 'playCard', card: dump0 })).toEqual([
        { type: 'cardPlayed', seat: 0, card: dump0 },
        { type: 'trickWon', seat: 1, trickIndex: i + 1, canDeclareNext: true },
      ]);
    });
    expect(dealOf(ctx).tricksWon).toEqual({ 0: 0, 1: 9, 2: 0, 3: 0 });
    // trick 10: the D10 heads the DK lead (tens outrank kings)
    act(ctx, 1, { type: 'playCard', card: 'DK' });
    act(ctx, 2, { type: 'playCard', card: 'D9' }); // cannot head: any diamond
    expect(act(ctx, 0, { type: 'playCard', card: 'D10' })).toEqual([
      { type: 'cardPlayed', seat: 0, card: 'D10' },
      { type: 'trickWon', seat: 0, trickIndex: 9, canDeclareNext: true },
    ]);
    expect(allowedActions(ctx.state, 0)).toEqual([{ type: 'playCard', legal: ['DA'] }]);
    // trick 11: DA sweeps the forced last diamonds
    act(ctx, 0, { type: 'playCard', card: 'DA' });
    act(ctx, 1, { type: 'playCard', card: 'DQ' });
    const expectedResult = {
      declarer: 1,
      contract: 100,
      bid: 60,
      made: false,
      sides: [
        {
          cardPoints: 30,
          lastTrickBonus: 20,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 50,
          roundedTotal: 50,
          tricks: 2,
          porvoo: false,
          scoreDelta: 50,
        },
        {
          cardPoints: 90,
          lastTrickBonus: 0,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 90,
          roundedTotal: 90,
          tricks: 9,
          porvoo: false,
          // 90 < 100: the RAISED contract is lost, not the 60 bid
          scoreDelta: -100,
        },
        {
          cardPoints: 0,
          lastTrickBonus: 0,
          marriagePoints: 0,
          discardPoints: 0,
          rawTotal: 0,
          roundedTotal: 0,
          tricks: 0,
          porvoo: true,
          // trickless opponent loses the BID, unaffected by the raise
          scoreDelta: -60,
        },
      ],
    };
    expect(act(ctx, 2, { type: 'playCard', card: 'DJ' })).toEqual([
      { type: 'cardPlayed', seat: 2, card: 'DJ' },
      { type: 'trickWon', seat: 0, trickIndex: 10, canDeclareNext: false },
      { type: 'dealScored', result: expectedResult },
    ]);
    expect(dealOf(ctx).phase).toEqual({ name: 'scored', result: expectedResult });
    expect(ctx.state.scores).toEqual([50, -100, -60]);
    expect(ctx.state.winnerSide).toBeNull();
    // dealer rotation wraps among the three active seats: 2 → 0
    const next = nextDealEvent(ctx.state, DECK_3P_TALON3);
    expect(next).toEqual({
      type: 'dealStarted',
      dealIndex: 1,
      dealer: 0,
      deck: DECK_3P_TALON3,
    });
    ctx.state = applyEvent(ctx.state, next);
    ctx.log.push(next);
    // seats 1 and 2 went negative: the illisoft bid ban skips them, seat 0 opens
    expect(expectedActor(ctx.state)).toBe(0);
    // replay determinism: the event log reproduces the final state
    let replayed = initialMatchState(RULES_3P, 2);
    for (const e of ctx.log) replayed = applyEvent(replayed, e);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(ctx.state));
  });
});
