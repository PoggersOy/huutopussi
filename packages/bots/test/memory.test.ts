/**
 * DealMemory / knowledgeOf: what a seat provably knows, inferred only from
 * the PlayerView snapshots it receives.
 */
import {
  type Card,
  DEFAULT_RULES,
  type DealPhase,
  type DealView,
  ILLISOFT_RULES,
  type PlayerView,
  type RuleConfig,
} from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { DealMemory, knowledgeOf } from '../src/memory.js';

function view(
  hand: Card[],
  phase: DealPhase,
  over: Partial<DealView> = {},
  config: RuleConfig = DEFAULT_RULES,
  dealIndex = 0,
): PlayerView {
  return {
    viewer: 0,
    config,
    scores: [0, 0],
    dealer: 3,
    dealIndex,
    winnerSide: null,
    deal: {
      hand,
      handCounts: { 0: hand.length, 1: 8, 2: 8, 3: 8 },
      capturedCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
      tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0 },
      tricksPlayed: 0,
      trump: null,
      declarations: [],
      askedWhole: { 0: false, 1: false, 2: false, 3: false },
      askedHalf: { 0: false, 1: false, 2: false, 3: false },
      bidLog: [],
      bid: null,
      declarer: null,
      contract: null,
      exchangeSeen: null,
      talonCount: null,
      talonSeen: null,
      dummyHandCount: null,
      discardedCount: null,
      lastTrick: null,
      phase,
      ...over,
    },
  };
}

const HEARTS: Card[] = ['HA', 'H10', 'HK', 'HQ', 'HJ', 'H9', 'H8', 'H7', 'H6'];

describe('DealMemory', () => {
  it('records a void when a seat fails to follow the led suit', () => {
    const m = new DealMemory();
    m.observe(
      view(['C7'], {
        name: 'follow',
        leader: 2,
        plays: [
          { seat: 2, card: 'H9' },
          { seat: 3, card: 'D7' },
        ],
      }),
    );
    for (const c of HEARTS.filter((c) => c !== 'H9')) expect(m.excluded[3].has(c)).toBe(true);
    // Leading says nothing about the leader's other cards.
    expect(m.excluded[2].size).toBe(0);
    expect(m.playedBy.get('D7')).toBe(3);
  });

  it('records that a follower could not head the trick', () => {
    const m = new DealMemory();
    m.observe(
      view(['C7'], {
        name: 'follow',
        leader: 2,
        plays: [
          { seat: 2, card: 'HK' },
          { seat: 3, card: 'H6' },
        ],
      }),
    );
    // Seat 3 followed low, so it holds neither the ace nor the ten.
    expect(m.excluded[3].has('HA')).toBe(true);
    expect(m.excluded[3].has('H10')).toBe(true);
    expect(m.excluded[3].has('HQ')).toBe(false);
  });

  it('infers the first-trick ace show (illisoft)', () => {
    const m = new DealMemory();
    m.observe(
      view(
        ['C7'],
        { name: 'follow', leader: 1, plays: [{ seat: 1, card: 'S7' }] },
        {},
        ILLISOFT_RULES,
      ),
    );
    // Leading a non-ace in trick 1 proves the leader holds no ace at all.
    for (const c of ['HA', 'DA', 'CA', 'SA'] as Card[]) expect(m.excluded[1].has(c)).toBe(true);
  });

  it('completes tricks from lastTrick and resets on a new deal', () => {
    const m = new DealMemory();
    m.observe(
      view(
        ['C7'],
        { name: 'lead', leader: 1, canDeclare: false },
        {
          tricksPlayed: 1,
          lastTrick: {
            plays: [
              { seat: 0, card: 'SA' },
              { seat: 1, card: 'S9' },
              { seat: 2, card: 'S8' },
              { seat: 3, card: 'S7' },
            ],
            winner: 0,
          },
        },
      ),
    );
    expect(m.played.size).toBe(4);
    expect(m.tricks.get(0)?.winner).toBe(0);
    m.observe(view(['C7'], { name: 'lead', leader: 1, canDeclare: false }, {}, DEFAULT_RULES, 1));
    expect(m.played.size).toBe(0);
  });
});

describe('knowledgeOf', () => {
  it('places own-declared marriages and exchange faces', () => {
    const m = new DealMemory();
    const v = view(
      ['HA', 'H10'],
      { name: 'lead', leader: 1, canDeclare: false },
      {
        declarer: 0,
        declarations: [
          { suit: 'S', seat: 1, side: 1, how: 'own', trickIndex: 1, points: 40 },
          { suit: 'D', seat: 1, side: 1, how: 'halfAsk', trickIndex: 2, points: 80 },
        ],
        exchangeSeen: { given: ['HA', 'H10', 'C7', 'C8'], returned: ['C7', 'C8', 'D6', 'D7'] },
      },
    );
    m.observe(v);
    const k = knowledgeOf(v, m);
    expect(k.held[1].has('SK') && k.held[1].has('SQ')).toBe(true);
    // A half-ask by side 1 means our side holds neither diamond half.
    expect(k.excluded[2].has('DK') && k.excluded[2].has('DQ')).toBe(true);
    // Given cards sit with the declarer (me); returned ones with partner 2.
    expect(k.held[2].has('D6') && k.held[2].has('C7')).toBe(true);
    expect(k.excluded[1].has('D6')).toBe(true);
    expect(k.held[0].has('HA')).toBe(true);
  });
});
