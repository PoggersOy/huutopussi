/**
 * Frozen engine contract — see CLAUDE.md.
 *
 * Every documented rules variation (docs/huutopussin-saannot.md §10) is a field
 * here. MVP defaults implement the "päämuoto" column. Ambiguities the rules doc
 * leaves open are pinned as follows (do not change silently):
 *
 *  - One declaration attempt (declareOwn | askWhole | askHalf) per lead
 *    opportunity; playing a card is the implicit skip.
 *  - Porvoo in the 4-player partnership game applies per SIDE: an opponent
 *    side with zero tricks scores −(final contract); a declarer side with zero
 *    tricks scores −2×contract (replacing the normal −contract).
 *  - If both sides reach winTarget in the same deal with EQUAL scores, another
 *    deal is played.
 *  - A whole-ask is answered from declarable marriages only (suits not yet
 *    declared this deal). 0 or 1 such marriages → truthful auto-answer;
 *    2+ → the partner chooses which suit to reveal.
 */

export interface RuleConfig {
  /** MVP supports 4 (partnership). 3-player pirunpakka is a later variant. */
  players: 4;
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
  /** null = unbounded (theoretical max applies). */
  maxBid: number | null;
  firstBidder: 'leftOfDealer' | 'dealer';
  /** First bidder must open at ≥ minBid (may not pass). */
  forcedOpening: boolean;
  exchangeCount: number;
  /**
   * 'ownLedWonTrick' (default): may declare only after winning a trick one led
   * oneself. 'anyWonTrick': after winning any trick.
   */
  declareRight: 'ownLedWonTrick' | 'anyWonTrick';
  /**
   * Side at or below this score may only make the forced opening bid.
   * null disables the ban.
   */
  bidBanThreshold: number | null;
  winTarget: number;
  /** Allow redeal demand on first bid turn with ≥3 sixes or nothing above J. */
  redealRule: boolean;
  /** Asker must hold the announced half (false = Erlangen bluff asks). */
  askHalfMustHoldCard: boolean;
  /** Clients may see the previous trick. */
  showLastTrick: boolean;
}

export const DEFAULT_RULES: RuleConfig = {
  players: 4,
  cardPoints: 'A',
  lastTrickBonus: 10,
  trumpValues: 'heartsHigh',
  minBid: 50,
  bidStep: 5,
  maxBid: 440,
  firstBidder: 'leftOfDealer',
  forcedOpening: true,
  exchangeCount: 3,
  declareRight: 'ownLedWonTrick',
  bidBanThreshold: -500,
  winTarget: 500,
  redealRule: true,
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
