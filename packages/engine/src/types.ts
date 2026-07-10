/**
 * Frozen engine contract — see CLAUDE.md. All other engine modules, the server,
 * bots and client build against these types. Every card that is hidden from a
 * player is structurally absent from `PlayerView`; redaction lives in view.ts.
 */
import type { RuleConfig } from './config.js';

// ── Cards ────────────────────────────────────────────────────────────────────

export const SUITS = ['H', 'D', 'C', 'S'] as const;
export type Suit = (typeof SUITS)[number];

/** High → low. Note the Huutopussi order: the 10 outranks the king. */
export const RANKS = ['A', '10', 'K', 'Q', 'J', '9', '8', '7', '6'] as const;
export type Rank = (typeof RANKS)[number];

/** e.g. 'HA' = ace of hearts, 'S10' = ten of spades. */
export type Card = `${Suit}${Rank}`;

// ── Seats & sides ────────────────────────────────────────────────────────────

export type Seat = 0 | 1 | 2 | 3;
/** Side 0 = seats 0+2, side 1 = seats 1+3. Partners sit opposite. */
export type Side = 0 | 1;

export const SEATS: readonly Seat[] = [0, 1, 2, 3] as const;

export function sideOf(seat: Seat): Side {
  return (seat % 2) as Side;
}
export function partnerOf(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}
export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

// ── Declarations (marriages / trump) ─────────────────────────────────────────

export type DeclarationHow = 'own' | 'wholeAsk' | 'halfAsk';

export interface Declaration {
  suit: Suit;
  /** Seat whose lead opportunity produced the declaration (the asker for asks). */
  seat: Seat;
  side: Side;
  how: DeclarationHow;
  /** 0-based index of the trick about to be led when the declaration happened. */
  trickIndex: number;
  /** Marriage points awarded to `side` (from RuleConfig.trumpValues). */
  points: number;
}

// ── Bidding ──────────────────────────────────────────────────────────────────

export interface BidRecord {
  seat: Seat;
  amount: number;
}

export type BidLogEntry =
  | { seat: Seat; kind: 'bid'; amount: number }
  | { seat: Seat; kind: 'pass' }
  | { seat: Seat; kind: 'redeal' };

// ── Tricks ───────────────────────────────────────────────────────────────────

export interface TrickPlay {
  seat: Seat;
  card: Card;
}

// ── Deal phase state machine ─────────────────────────────────────────────────

export type DealPhase =
  | {
      name: 'bidding';
      turn: Seat;
      highBid: BidRecord | null;
      passed: Seat[];
      /** Seats that have completed their first bidding turn (redeal window closed). */
      firstTurnTaken: Seat[];
    }
  /** Declarer's partner must give `config.exchangeCount` cards to the declarer. */
  | { name: 'exchangeGive' }
  /** Declarer (now holding 9+exchangeCount cards) must announce the contract. */
  | { name: 'exchangeContract' }
  /** Declarer must return `config.exchangeCount` cards to partner. */
  | { name: 'exchangeReturn' }
  /**
   * `leader` is about to lead a trick. If `canDeclare`, they may first make
   * exactly one declaration attempt (declareOwn | askWhole | askHalf); playing
   * a card is the implicit skip. After any attempt resolves, canDeclare=false.
   */
  | { name: 'lead'; leader: Seat; canDeclare: boolean }
  /**
   * `leader` asked their partner for a whole marriage and the partner holds
   * 2+ declarable marriages: partnerOf(leader) must choose which suit to reveal.
   * (0 or 1 declarable marriages are auto-answered truthfully by the engine.)
   */
  | { name: 'awaitWholeAnswer'; leader: Seat }
  /** Mid-trick: 1–3 cards played; nextSeat(last player) acts. Trump is fixed. */
  | { name: 'follow'; leader: Seat; plays: TrickPlay[] }
  | { name: 'scored'; result: DealResult };

// ── Deal & match state (server-side truth; NEVER sent to clients) ────────────

export interface DealState {
  /** Full hands per seat — hidden information. */
  hands: Record<Seat, Card[]>;
  /** Cards captured in won tricks, per seat (Porvoo needs per-seat granularity). */
  captured: Record<Seat, Card[]>;
  tricksWon: Record<Seat, number>;
  /** Completed tricks, 0–9. */
  tricksPlayed: number;
  trump: Suit | null;
  declarations: Declaration[];
  /** Seats that have used askWhole: they may no longer declareOwn, and their
   *  partner may no longer askWhole (rules doc §5.4). */
  askedWhole: Record<Seat, boolean>;
  bidLog: BidLogEntry[];
  /** Winning bid, fixed when bidding ends. */
  bid: BidRecord | null;
  declarer: Seat | null;
  contract: number | null;
  /** Exchange card faces — hidden from the non-exchanging side. */
  exchange: { given: Card[] | null; returned: Card[] | null };
  lastTrick: { plays: TrickPlay[]; winner: Seat } | null;
  phase: DealPhase;
}

export interface MatchState {
  config: RuleConfig;
  /** Cumulative match score per side. May go negative. */
  scores: [number, number];
  /** Dealer of the current deal (rotates clockwise per deal). */
  dealer: Seat;
  /** 0-based count of deals started (redeals do not increment it). */
  dealIndex: number;
  deal: DealState | null;
  winnerSide: Side | null;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface SideBreakdown {
  cardPoints: number;
  lastTrickBonus: number;
  marriagePoints: number;
  /** cardPoints + lastTrickBonus + marriagePoints. */
  rawTotal: number;
  tricks: number;
  porvoo: boolean;
  /** Signed amount actually added to the side's match score. */
  scoreDelta: number;
}

export interface DealResult {
  declarer: Seat;
  contract: number;
  made: boolean;
  sides: [SideBreakdown, SideBreakdown];
}

// ── Events (the only way state changes; emitted by validateAction) ───────────

export type GameEvent =
  /** `deck` is the full 36-card permutation: seat s gets deck[9s..9s+8]. */
  | { type: 'dealStarted'; dealIndex: number; dealer: Seat; deck: Card[] }
  /** A qualifying seat demanded a redeal; a fresh dealStarted follows. */
  | { type: 'redealDemanded'; seat: Seat }
  | { type: 'bidPlaced'; seat: Seat; amount: number }
  | { type: 'passed'; seat: Seat }
  | { type: 'biddingEnded'; declarer: Seat; amount: number }
  | { type: 'cardsGiven'; from: Seat; to: Seat; cards: Card[] }
  | { type: 'contractSet'; seat: Seat; amount: number }
  | { type: 'cardsReturned'; from: Seat; to: Seat; cards: Card[] }
  | { type: 'declaredOwn'; seat: Seat; suit: Suit }
  | { type: 'askedWhole'; seat: Seat }
  /** suit=null means "no declarable marriage". Emitted by engine (auto) or via answerWhole. */
  | { type: 'answeredWhole'; seat: Seat; suit: Suit | null }
  | { type: 'askedHalf'; seat: Seat; suit: Suit; rankHeld: 'K' | 'Q' }
  | { type: 'answeredHalf'; seat: Seat; yes: boolean }
  /** Follows any successful declaration; trump switches to `suit` immediately. */
  | { type: 'trumpSet'; suit: Suit; seat: Seat; side: Side; how: DeclarationHow; points: number }
  | { type: 'cardPlayed'; seat: Seat; card: Card }
  /** Emitted after the 4th cardPlayed of a trick; carries the resolution. */
  | { type: 'trickWon'; seat: Seat; trickIndex: number; canDeclareNext: boolean }
  | { type: 'dealScored'; result: DealResult }
  | { type: 'matchEnded'; winnerSide: Side };

// ── Player actions ───────────────────────────────────────────────────────────

export type PlayerAction =
  | { type: 'bid'; amount: number }
  | { type: 'pass' }
  | { type: 'demandRedeal' }
  | { type: 'giveCards'; cards: Card[] }
  | { type: 'setContract'; amount: number }
  | { type: 'returnCards'; cards: Card[] }
  | { type: 'declareOwn'; suit: Suit }
  | { type: 'askWhole' }
  /** Only valid in awaitWholeAnswer; suit must be one of the answerer's declarable marriages. */
  | { type: 'answerWhole'; suit: Suit }
  /** rankHeld is the half the asker holds (must actually hold it when config.askHalfMustHoldCard). */
  | { type: 'askHalf'; suit: Suit; rankHeld: 'K' | 'Q' }
  | { type: 'playCard'; card: Card };

// ── Errors ───────────────────────────────────────────────────────────────────

/** `code` is an i18n key, e.g. 'error.notYourTurn', 'error.mustHeadTrick'. */
export interface RuleError {
  error: true;
  code: string;
  /** Optional interpolation params for the i18n layer. */
  params?: Record<string, string | number>;
}

export function isRuleError(x: unknown): x is RuleError {
  return typeof x === 'object' && x !== null && (x as RuleError).error === true;
}

// ── Action hints (server-computed legality, consumed by clients & bots) ──────

export type ActionHint =
  | {
      type: 'bid';
      /** Lowest legal bid amount. */
      min: number;
      /** Highest legal bid amount (config.maxBid or theoretical max). */
      max: number;
      step: number;
      canPass: boolean;
      canDemandRedeal: boolean;
      /** True when this seat must open with at least config.minBid. */
      forced: boolean;
    }
  | { type: 'giveCards'; count: number }
  | { type: 'setContract'; min: number; max: number; step: number }
  | { type: 'returnCards'; count: number }
  | {
      type: 'declaration';
      /** Suits declarable from own hand right now. */
      ownSuits: Suit[];
      canAskWhole: boolean;
      /** Half-asks available: for each, the asker holds `rankHeld` of `suit`. */
      halfAsks: Array<{ suit: Suit; rankHeld: 'K' | 'Q' }>;
    }
  | { type: 'answerWhole'; suits: Suit[] }
  | { type: 'playCard'; legal: Card[] };

// ── Redacted per-player views (the ONLY game state clients ever see) ─────────

export interface DealView {
  /** Viewer's own hand, sorted for display. Empty for spectators. */
  hand: Card[];
  handCounts: Record<Seat, number>;
  capturedCounts: Record<Seat, number>;
  tricksWon: Record<Seat, number>;
  tricksPlayed: number;
  trump: Suit | null;
  declarations: Declaration[];
  askedWhole: Record<Seat, boolean>;
  bidLog: BidLogEntry[];
  bid: BidRecord | null;
  declarer: Seat | null;
  contract: number | null;
  /**
   * Exchange card faces, present ONLY in the declarer's and partner's views
   * (null for opponents/spectators — they see just the phase).
   */
  exchangeSeen: { given: Card[] | null; returned: Card[] | null } | null;
  /** Present when config.showLastTrick. */
  lastTrick: { plays: TrickPlay[]; winner: Seat } | null;
  /** DealPhase contains no hidden cards, so it is shared verbatim. */
  phase: DealPhase;
}

export interface PlayerView {
  viewer: Seat | 'spectator';
  config: RuleConfig;
  scores: [number, number];
  dealer: Seat;
  dealIndex: number;
  winnerSide: Side | null;
  deal: DealView | null;
}

/** Per-recipient event visibility used by view.ts/redactEvent. */
export type EventVisibility = { kind: 'public' } | { kind: 'seats'; seats: Seat[] };
