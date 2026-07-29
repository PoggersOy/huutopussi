/**
 * Engine contract — see CLAUDE.md. Extended 2026-07-10 (user-authorized
 * contract change) with the illisoft 2002 ruleset (docs/illisoft-saannot-spec.md).
 *
 * Every documented rules variation (docs/huutopussin-saannot.md §10 plus the
 * illisoft spec §11) is a field here. DEFAULT_RULES implements the "päämuoto"
 * column unchanged; ILLISOFT_RULES the 2002 illisoft game. Ambiguities the
 * rules docs leave open are pinned as follows (do not change silently):
 *
 *  - One declaration attempt (declareOwn | askWhole | askHalf) per lead
 *    opportunity; playing a card is the implicit skip.
 *  - Porvoo (architect ruling 2026-07-10 for päämuoto; illisoft spec §8):
 *    an opponent SIDE with zero tricks always scores −bid (never the raised
 *    contract) in both rulesets. The DECLARER's Porvoo is config-gated:
 *    judged at declarerPorvooScope, penalized −2 × declarerPorvooBasis
 *    (päämuoto: 'seat' & 'bid'; illisoft: 'side' & 'contract').
 *  - Match-end ties follow winTiebreak; an exact tie among crossers with no
 *    applicable declarer tiebreak means another deal is played.
 *  - The overtake obligation includes overtrumping: when void in the led suit
 *    after a trump has been played, a higher trump must be played if held.
 *  - A whole-ask is answered from declarable marriages only (suits not yet
 *    declared this deal). 0 or 1 such marriages → truthful auto-answer;
 *    2+ → the partner chooses which suit to reveal.
 *  - Illisoft pins (spec §10): contract-less deals score rounded raw totals
 *    with no penalties; reopened bidding starts clockwise from left of the
 *    dealer; a redeal keeps the same dealer and may still be demanded at the
 *    exchangeContract raise decision; a 2p läpäri (slam) counts the full
 *    deck's card points regardless of what the dummy/talon held; the match
 *    ends when a side reaches 500 (not only after exceeding it).
 */

export interface RuleConfig {
  /**
   * 2/3: every seat is its own side; a koinipakka (talon) is dealt and 2p
   * additionally deals a dead dummy hand. 4: partnership, seats 0+2 vs 1+3.
   */
  players: 2 | 3 | 4;
  /** 2-3p koinipakka size: 3 → 11-card hands, 6 → 10-card hands. Unused in 4p. */
  talonSize: 3 | 6;
  /**
   * 2-3p: avoin koini — every player sees the talon faces during the whole
   * first trick. false = salainen koini (only the declarer ever sees them).
   * Unused in 4p.
   */
  openTalon: boolean;
  /**
   * 'A' (default): A=11, 10=10, K=4, Q=3, J=2 → 120 card points/deal.
   * 'B': A=10, 10=10, K/Q/J=5 → 140 card points/deal.
   */
  cardPoints: 'A' | 'B';
  /** Awarded to the winners of the last trick. Päämuoto: 10 with 'A' (130 total). */
  lastTrickBonus: number;
  /**
   * 'heartsHigh' (default): ♥100 ♦80 ♣60 ♠40.
   * 'bridge': ♠100 ♥80 ♦60 ♣40.
   */
  trumpValues: 'heartsHigh' | 'bridge';
  minBid: number;
  bidStep: number;
  /** null = unbounded (theoretical max applies). Reaching it ends the auction. */
  maxBid: number | null;
  firstBidder: 'leftOfDealer' | 'dealer';
  /** First bidder must open at ≥ minBid (may not pass). */
  forcedOpening: boolean;
  /**
   * Outcome when every seat passes without a bid (only reachable when
   * forcedOpening is false). 'forceLastSeat': the last unpassed seat must
   * open. 'contractlessDeal': the deal is played without declarer/contract;
   * every side scores its (rounded) raw points and no penalties apply.
   */
  allPassOutcome: 'forceLastSeat' | 'contractlessDeal';
  /** 4p: cards given by the partner and returned by the declarer. */
  exchangeCount: number;
  /**
   * 4p phase order. 'beforeReturn' (päämuoto): give → contract → return.
   * 'afterExchange' (illisoft korotus): give → return → contract.
   * 2-3p is always take → discard → contract.
   */
  contractTiming: 'beforeReturn' | 'afterExchange';
  /**
   * 'ownLedWonTrick' (default): may declare only after winning a trick one led
   * oneself. 'anyWonTrick': after winning any trick.
   */
  declareRight: 'ownLedWonTrick' | 'anyWonTrick';
  /**
   * 4p ask lockouts. 'basic': a seat that asked a whole may no longer
   * declareOwn and its partner may no longer askWhole. 'illisoft': a seat
   * that asked anything (whole or half) may no longer declareOwn; after
   * either partner asks a half, both are barred from declareOwn AND askWhole;
   * half-asks and whole-asks are otherwise repeatable.
   */
  askLockouts: 'illisoft' | 'basic';
  /**
   * Side at or below this score may not bid. Without bidBanReopen the banned
   * seat may still make the forced opening bid; with bidBanReopen banned
   * seats are skipped entirely (see bidBanReopen). null disables the ban.
   */
  bidBanThreshold: number | null;
  /**
   * illisoft bid ban: banned seats are skipped in the opening round; if all
   * eligible seats pass without a bid, bidding reopens for the banned seats
   * clockwise from left of dealer. When every seat is banned, everyone bids
   * normally from the start. false = päämuoto forced-opening-only ban.
   */
  bidBanReopen: boolean;
  winTarget: number;
  /** 'reach': score ≥ winTarget wins. 'exceed': score > winTarget. */
  winCondition: 'exceed' | 'reach';
  /**
   * Several sides crossing winTarget in the same deal: 'declarer' — the
   * declarer's side wins if it is among them (falls back to 'higher' when
   * there is no declarer); 'higher' — the highest total wins. An exact tie
   * at the top with no applicable declarer means another deal is played.
   */
  winTiebreak: 'declarer' | 'higher';
  /**
   * 'aceShow' (illisoft): the first trick's leader must lead an ace if
   * holding any, else a spade if holding any; a follower holding the led
   * suit's ace must play it unless the led card is an ace. 'free' = no
   * first-trick constraints.
   */
  firstTrickRules: 'aceShow' | 'free';
  /** Non-declarer sides' raw totals are rounded to the nearest 5 ('nearest5'). */
  opponentRounding: 'nearest5' | 'none';
  /** Declarer trickless penalty is −2× this amount (päämuoto 'bid'; illisoft 'contract'). */
  declarerPorvooBasis: 'bid' | 'contract';
  /** Declarer Porvoo judged on the declarer seat alone or the whole side. */
  declarerPorvooScope: 'seat' | 'side';
  /**
   * Redeal demand condition. 'fourSixes' (illisoft): all four sixes in hand
   * (4p: in the pair's combined hands). 'threeSixesOrNoneAboveJack'
   * (päämuoto): ≥3 sixes or nothing above jack. null disables redeals.
   */
  redealCondition: 'fourSixes' | 'threeSixesOrNoneAboveJack' | null;
  /**
   * 'firstBidTurn': redeal may only be demanded on a seat's first bidding
   * turn. 'bidAndExchange' (illisoft): additionally during the exchange
   * phases by the acting seat, through the exchangeContract raise decision.
   */
  redealWindow: 'firstBidTurn' | 'bidAndExchange';
  /** Asker must hold the announced half (false = Erlangen bluff asks). */
  askHalfMustHoldCard: boolean;
  /** Clients may see the previous trick. */
  showLastTrick: boolean;
}

export const DEFAULT_RULES: RuleConfig = {
  players: 4,
  talonSize: 3,
  openTalon: true,
  cardPoints: 'A',
  lastTrickBonus: 10,
  trumpValues: 'heartsHigh',
  minBid: 50,
  bidStep: 5,
  maxBid: 440,
  firstBidder: 'leftOfDealer',
  forcedOpening: true,
  allPassOutcome: 'forceLastSeat',
  exchangeCount: 3,
  contractTiming: 'beforeReturn',
  declareRight: 'ownLedWonTrick',
  askLockouts: 'basic',
  bidBanThreshold: -500,
  bidBanReopen: false,
  winTarget: 500,
  winCondition: 'reach',
  winTiebreak: 'higher',
  firstTrickRules: 'free',
  opponentRounding: 'none',
  declarerPorvooBasis: 'bid',
  declarerPorvooScope: 'seat',
  redealCondition: 'threeSixesOrNoneAboveJack',
  redealWindow: 'firstBidTurn',
  askHalfMustHoldCard: true,
  showLastTrick: true,
};

/**
 * The 2002 illisoft Huutopussi ruleset (docs/illisoft-saannot-spec.md §11).
 * players is the lobby default mode; 2-3p rooms flip players/talonSize/openTalon.
 */
export const ILLISOFT_RULES: RuleConfig = {
  players: 4,
  talonSize: 3,
  openTalon: true,
  cardPoints: 'A',
  lastTrickBonus: 20,
  trumpValues: 'heartsHigh',
  minBid: 60,
  bidStep: 5,
  maxBid: 420,
  firstBidder: 'leftOfDealer',
  forcedOpening: false,
  allPassOutcome: 'contractlessDeal',
  exchangeCount: 4,
  contractTiming: 'afterExchange',
  declareRight: 'anyWonTrick',
  askLockouts: 'illisoft',
  bidBanThreshold: -1,
  bidBanReopen: true,
  winTarget: 500,
  winCondition: 'reach',
  winTiebreak: 'declarer',
  firstTrickRules: 'aceShow',
  opponentRounding: 'nearest5',
  declarerPorvooBasis: 'contract',
  declarerPorvooScope: 'side',
  redealCondition: 'fourSixes',
  redealWindow: 'bidAndExchange',
  askHalfMustHoldCard: true,
  showLastTrick: true,
};

/** Total card points available in a deal excluding marriages (incl. last trick). */
export function totalDealPoints(config: RuleConfig): number {
  return (config.cardPoints === 'A' ? 120 : 140) + config.lastTrickBonus;
}

/**
 * Highest achievable deal total: all card points + last trick + all four
 * marriage values (each suit declarable once). Used to cap bids/contracts.
 */
export function theoreticalMaxPoints(config: RuleConfig): number {
  return totalDealPoints(config) + 100 + 80 + 60 + 40;
}
