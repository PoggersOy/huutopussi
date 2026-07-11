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
/**
 * 4p: side 0 = seats 0+2, side 1 = seats 1+3 (partners sit opposite).
 * 2-3p: every active seat is its own side (side = seat).
 */
export type Side = 0 | 1 | 2;

export const SEATS: readonly Seat[] = [0, 1, 2, 3] as const;

/** Side of an ACTIVE seat (2-3p callers must not pass inactive seats). */
export function sideOf(seat: Seat, players: 2 | 3 | 4): Side {
  return (players === 4 ? seat % 2 : seat) as Side;
}
/** Meaningful only in 4p (2-3p seats have no partner). */
export function partnerOf(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}
export function nextSeat(seat: Seat, players: 2 | 3 | 4): Seat {
  return ((seat + 1) % players) as Seat;
}
/** The seats that play in this mode: 0..players-1 (higher seats stay empty). */
export function activeSeats(players: 2 | 3 | 4): Seat[] {
  return SEATS.slice(0, players);
}
export function sideCount(config: Pick<RuleConfig, 'players'>): number {
  return config.players === 4 ? 2 : config.players;
}
/** Tricks per deal = hand size: 4p 9; 2-3p 11 with a 3-card talon, 10 with 6. */
export function tricksPerDeal(config: Pick<RuleConfig, 'players' | 'talonSize'>): number {
  if (config.players === 4) return 9;
  return config.talonSize === 3 ? 11 : 10;
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
      /**
       * Seats locked out of this bidding round by the bid ban
       * (config.bidBanReopen): skipped in rotation; bidding reopens for them
       * (biddingReopened) if every eligible seat passes without a bid. Empty
       * when bidBanReopen is off, nobody is banned, or after the reopen.
       */
      excluded: Seat[];
    }
  /** 4p: declarer's partner must give `config.exchangeCount` cards to the declarer. */
  | { name: 'exchangeGive' }
  /** 2-3p: declarer holds hand+talon and must discard `config.talonSize` cards. */
  | { name: 'exchangeDiscard' }
  /**
   * Declarer must announce the contract. 4p order follows
   * config.contractTiming (give→contract→return | give→return→contract);
   * 2-3p is always take→discard→contract.
   */
  | { name: 'exchangeContract' }
  /** 4p: declarer must return `config.exchangeCount` cards to partner. */
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
  /** Mid-trick: 1..players-1 cards played; nextSeat(last player) acts. Trump is fixed. */
  | { name: 'follow'; leader: Seat; plays: TrickPlay[] }
  | { name: 'scored'; result: DealResult };

// ── Deal & match state (server-side truth; NEVER sent to clients) ────────────

export interface DealState {
  /** Full hands per seat — hidden information. Inactive seats stay empty. */
  hands: Record<Seat, Card[]>;
  /** Cards captured in won tricks, per seat (Porvoo needs per-seat granularity). */
  captured: Record<Seat, Card[]>;
  tricksWon: Record<Seat, number>;
  /** Completed tricks, 0..tricksPerDeal(config). */
  tricksPlayed: number;
  trump: Suit | null;
  declarations: Declaration[];
  /** Seats that have used askWhole (ask lockouts per config.askLockouts). */
  askedWhole: Record<Seat, boolean>;
  /** Seats that have used askHalf (illisoft ask lockouts). */
  askedHalf: Record<Seat, boolean>;
  /**
   * Half-asks a side made and had DENIED (the partner lacked the complement).
   * The answer cannot change within a deal, so such a (side, suit) is never
   * offered to that side again — the declaration hint drops it and re-asking
   * it is rejected (error.halfAlreadyDenied).
   */
  deniedHalves: Array<{ side: Side; suit: Suit }>;
  bidLog: BidLogEntry[];
  /** Winning bid, fixed when bidding ends. null also for contract-less deals. */
  bid: BidRecord | null;
  declarer: Seat | null;
  contract: number | null;
  /** 4p exchange card faces — hidden from the non-exchanging side. */
  exchange: { given: Card[] | null; returned: Card[] | null };
  /** 2-3p: the original koinipakka faces (immutable once dealt). null in 4p. */
  talon: Card[] | null;
  /** 2-3p: the declarer once the talon has been merged into their hand. */
  talonTakenBy: Seat | null;
  /** 2p: the dead third hand — never played, never scored. */
  dummyHand: Card[] | null;
  /** 2-3p: the declarer's face-down discards — hidden from everyone else. */
  discarded: Card[] | null;
  lastTrick: { plays: TrickPlay[]; winner: Seat } | null;
  phase: DealPhase;
}

export interface MatchState {
  config: RuleConfig;
  /** Cumulative match score per side (length sideCount(config)). May go negative. */
  scores: number[];
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
  /** Declarer's counted koini discards (2-3p, only when the side won ≥1 trick). */
  discardPoints: number;
  /** cardPoints + lastTrickBonus + marriagePoints + discardPoints. */
  rawTotal: number;
  /** rawTotal after config.opponentRounding (equals rawTotal when 'none'). */
  roundedTotal: number;
  tricks: number;
  porvoo: boolean;
  /** Signed amount actually added to the side's match score. */
  scoreDelta: number;
}

export interface DealResult {
  /** All three null for a contract-less (all-pass) deal; made is null too. */
  declarer: Seat | null;
  contract: number | null;
  bid: number | null;
  made: boolean | null;
  /** One breakdown per side (length sideCount(config)). */
  sides: SideBreakdown[];
}

// ── Events (the only way state changes; emitted by validateAction) ───────────

export type GameEvent =
  /**
   * `deck` is the full 36-card permutation. Layout: active hands seat-major
   * (tricksPerDeal(config) cards each), then the dummy hand (2p only), then
   * the talon (2-3p, config.talonSize cards). 4p: seat s gets deck[9s..9s+8].
   */
  | { type: 'dealStarted'; dealIndex: number; dealer: Seat; deck: Card[] }
  /** A qualifying seat demanded a redeal; a fresh dealStarted follows. */
  | { type: 'redealDemanded'; seat: Seat }
  | { type: 'bidPlaced'; seat: Seat; amount: number }
  | { type: 'passed'; seat: Seat }
  /**
   * Every eligible seat passed without a bid: bidding reopens for the listed
   * (previously excluded) seats, clockwise from left of dealer.
   */
  | { type: 'biddingReopened'; seats: Seat[] }
  /** Everyone passed (config.allPassOutcome 'contractlessDeal'): play starts leaderless. */
  | { type: 'allPassed' }
  | { type: 'biddingEnded'; declarer: Seat; amount: number }
  /** 2-3p: the talon merges into the declarer's hand (auto after biddingEnded). */
  | { type: 'talonTaken'; seat: Seat }
  /** 2-3p: declarer's face-down discards. Faces visible to `seat` only. */
  | { type: 'cardsDiscarded'; seat: Seat; cards: Card[] }
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
  /** Emitted after the config.players-th cardPlayed of a trick; carries the resolution. */
  | { type: 'trickWon'; seat: Seat; trickIndex: number; canDeclareNext: boolean }
  | { type: 'dealScored'; result: DealResult }
  | { type: 'matchEnded'; winnerSide: Side };

// ── Player actions ───────────────────────────────────────────────────────────

export type PlayerAction =
  | { type: 'bid'; amount: number }
  | { type: 'pass' }
  | { type: 'demandRedeal' }
  | { type: 'giveCards'; cards: Card[] }
  /** 2-3p: declarer discards exactly config.talonSize cards (no aces or tens). */
  | { type: 'discardCards'; cards: Card[] }
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
  /** 2-3p discard: `legal` = hand minus aces and tens. */
  | { type: 'discardCards'; count: number; legal: Card[] }
  | { type: 'setContract'; min: number; max: number; step: number }
  | { type: 'returnCards'; count: number }
  /** Redeal may be demanded now (exchange window; bidding uses the bid hint flag). */
  | { type: 'demandRedeal' }
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
  askedHalf: Record<Seat, boolean>;
  bidLog: BidLogEntry[];
  bid: BidRecord | null;
  declarer: Seat | null;
  contract: number | null;
  /**
   * 4p exchange card faces, present ONLY in the declarer's and partner's views
   * (null for opponents/spectators — they see just the phase).
   */
  exchangeSeen: { given: Card[] | null; returned: Card[] | null } | null;
  /** 2-3p: cards left in the talon pile (0 once taken). null in 4p. */
  talonCount: number | null;
  /**
   * 2-3p avoin koini: the talon faces, shown to ALL viewers during the whole
   * first trick (config.openTalon && tricksPlayed === 0 in lead/follow).
   */
  talonSeen: Card[] | null;
  /** 2p: size of the dead dummy hand. null otherwise. */
  dummyHandCount: number | null;
  /** 2-3p: number of cards the declarer has discarded. null before/in 4p. */
  discardedCount: number | null;
  /** Present when config.showLastTrick. */
  lastTrick: { plays: TrickPlay[]; winner: Seat } | null;
  /** DealPhase contains no hidden cards, so it is shared verbatim. */
  phase: DealPhase;
}

export interface PlayerView {
  viewer: Seat | 'spectator';
  config: RuleConfig;
  scores: number[];
  dealer: Seat;
  dealIndex: number;
  winnerSide: Side | null;
  deal: DealView | null;
}

/** Per-recipient event visibility used by view.ts/redactEvent. */
export type EventVisibility = { kind: 'public' } | { kind: 'seats'; seats: Seat[] };
