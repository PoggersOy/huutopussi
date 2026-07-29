# Illisoft-säännöt — specification & contract extension

> Source of truth for the illisoft ruleset: `docs/lahteet/illisoft-huutopussi-ohje.txt`
> (decoded from the 2002 `Huutopussi.hlp` by illisoft). Where that text is silent,
> the **Pinned decisions** section below fills the gap explicitly. Quotes in Finnish
> are verbatim from the ohje. This document extends — does not replace —
> `docs/huutopussin-saannot.md`; the engine expresses BOTH rulesets via `RuleConfig`.

## 1. Game modes

| Mode | Hands dealt | Hand size | Koinipakka (talon) | Sides |
|---|---|---|---|---|
| 2 players | 3 (one **dummy**, never played) | 11 / 10 | 3 / 6 cards | 2 (each player own side) |
| 3 players | 3 | 11 / 10 | 3 / 6 cards | 3 (own side each) |
| 4 players (pairs 0+2 vs 1+3) | 4 | 9 | none — 4-card partner exchange | 2 |

- Talon size is a lobby option (`talonSize: 3 | 6`) for 2–3p only. 11-card hands with
  a 3-card talon; 10-card hands with a 6-card talon. Tricks per deal = hand size.
- Exchange visibility is a lobby option for 2–3p: **avoin koini** (`openTalon: true`,
  all players see the talon cards during the whole first trick) or **salainen koini**
  (only the declarer ever sees them).
- 2p deals exactly like 3p ("jaetaan täsmälleen samalla tavalla kuin jos pelaajia
  olisi 3"); the third hand is dead. Deck layout in `dealStarted.deck`, in order:
  active hands seat-by-seat, then dummy hand (2p only), then talon.

## 2. Bidding (huutaminen)

- First bidder: left of dealer; clockwise; bids divisible by 5; each bid ≥ previous + 5.
- **Minimum bid 60. No forced opening — anyone may pass at any turn.** Pass = out for
  the deal.
- **Maximum bid 420** ("maksimihuudon 420 pistettä") — a 420 bid **ends the auction
  immediately**.
- **Bid ban**: a player (4p: side) with **negative score may not bid** ("Vain ne
  pelaajat, joiden pistemäärä on positiivinen tai nolla, saavat huutaa").
  - If **all eligible seats pass without any bid**, bidding **reopens for the banned
    seats** (order: clockwise from left of dealer), normal rules.
  - If **every** seat is banned, everyone bids normally from the start.
  - Once a seat has passed it stays out, including across the reopen.
- **All pass ⇒ contract-less deal** (see §8). No declarer, no exchange, no raise.

## 3. Redeal (uusi jako)

- Condition: a player holds **all four sixes** — in 4p, the **pair's combined hands**
  count ("nelinpelissä jommankumman parin pelaajilla yhdessä").
- Window: on the holder's **bidding turn** AND **during the exchange phases** after
  cards moved ("joko tässä vaiheessa tai koinimisen jälkeen"). Same dealer redeals;
  `dealIndex` does not increment.

## 4. Exchange (koiniminen) and raise (korotus)

**2–3p:** declarer takes the talon into hand, then discards exactly `talonSize` cards
face down. **Aces and tens may never be discarded** ("Kymppejä ja ässiä huutaja ei
saa laittaa pois"). Discards are scored to the declarer at deal end **only if the
declarer won ≥ 1 trick** ("Koinikortit lasketaan huutajan pisteiksi ainoastaan
silloin, jos hän on saanut vähintään yhden käännön").

**4p:** declarer's partner first gives **4 cards** face down; the declarer looks,
then returns **4 cards** (returned cards may include just-received ones). Aces/tens
ARE allowed in the 4p exchange. Exchange cards are never shown to opponents.

**Korotus:** after the exchange completes, the declarer may **raise** the contract
(divisible by 5, up to 420) or keep it ("Ohi" — contract stays at the winning bid).
The contract may never go below the bid. Phase order: give→return→raise (4p);
take→discard→raise (2–3p).

## 5. First trick (ensimmäinen pelikierros)

- Leader: the **declarer**; in a contract-less deal, left of dealer.
- **Lead constraint**: leader must lead an **ace** if holding any; otherwise a
  **spade**; otherwise anything.
- **"Ässän pitää näkyä"**: if the led card is not an ace, the holder of the **led
  suit's ace must play it**. (2p: the ace may be in the dummy or talon — then nobody
  is forced.)
- No trump can exist during the first trick (declarations require a won trick),
  so these rules never interact with trumping.

## 6. Trick play (the three obligations)

Unchanged from the current engine (`docs/plan.md` legalPlays algorithm):
follow suit; within led suit head the trick if possible (obligation lapses when the
trick already contains a trump on a non-trump lead); void ⇒ must trump and overtrump
if possible; otherwise any held trump must be played. In particular, a player who
is void in the led suit after somebody has trumped must play a higher trump when
holding one (user ruling 2026-07-29). Highest trump wins, else highest led-suit
card. Trick size = number of active players (2/3/4). Winner leads next.

## 7. Trump declarations (valtin tekeminen)

- Right: after winning **any** trick (`declareRight: 'anyWonTrick'`), before leading
  the next. **One declaration attempt per won trick** ("Yhden pelikierroksen jälkeen
  saa tehdä aina vain yhden valtin"; "voi esittää vain yhden kysymyksen").
- Own-hand declaration requires holding K+Q of the suit **at that moment**; each suit
  declarable **once per deal** globally; a new trump replaces the old; every declared
  marriage keeps its points (♥100 ♦80 ♣60 ♠40).
- **2–3p: no asks** — own-hand declarations only.
- **4p asks:**
  - **Kysy kokonaista** (ask whole): if the partner holds ≥1 undeclared marriage they
    **must** reveal one (choice if several); the suit becomes trump, credited to the
    holder's seat. If none, play just continues (opportunity consumed).
  - **Kysy puolikasta** (ask half): asker must hold the named suit's K or Q
    (`askHalfMustHoldCard: true`); if partner holds the other half, the suit becomes
    trump credited to the asker.
  - **Lockouts (illisoft mode):**
    1. A seat that has asked **anything** (whole or half) may no longer declare from
       its own hand this deal ("hänen kädessään olevaa valttia ei sillä
       jakokierroksella saa tehdä").
    2. After **either** partner asks a **half**, **both** partners are barred from
       own-hand declarations **and** whole-asks for the rest of the deal ("kumpikaan
       parin jäsenistä ei enää … tehdä valtteja suoraan omasta kädestään, eikä kysyä
       kokonaista"). Further half-asks remain allowed.

## 8. Scoring a deal (pisteiden laskeminen)

Card points: A=11, 10=10, K=4, Q=3, J=2; **last trick +20** ⇒ 140 card points/deal.

- **Declarer side** (raw = captured card points + last-trick bonus + own marriage
  points + koini-discard points if the side won ≥1 trick):
  - raw ≥ contract (**unrounded** comparison, "ilman pyöristyksiä") ⇒ **exactly
    +contract**.
  - raw < contract ⇒ **−contract** (the raised contract: "tai korotuksen verran,
    jos hän korotti huutoaan"); if the **side** won **zero tricks** (discards don't
    count as tricks) ⇒ **−2×contract** (illisoft judges the declarer's Porvoo at
    SIDE scope with CONTRACT basis — note this differs from the päämuoto architect
    ruling of 2026-07-10, which uses seat scope and bid basis; both are expressible,
    see §11 `declarerPorvooScope`/`declarerPorvooBasis`).
- **Every other side**: raw **rounded to the nearest 5** ⇒ that many points.
  If the side won zero tricks ⇒ **−bid** (the winning bid, NOT the raised contract:
  "tässä mahdollisella korotuksella ei ole vaikutusta"). This matches the revised
  päämuoto ruling — opponent trickless penalty is always bid-based, no field needed.
- **Contract-less deal** (everyone passed): every side scores its rounded raw points;
  **no trickless penalties** (pinned — there is no huuto to deduct). With open talon
  the talon is shown during trick 1 but its cards score to nobody.
- **2p slam (läpäri)**: a player winning **every trick** scores raw =
  **totalDealPoints (140) + own marriage points** regardless of what the dummy/talon
  held ("läpäristä saa aina 140 pistettä"); discard points are NOT added on top
  (they are inside the notional 140). 3p has no such top-up.
- `SideBreakdown` gains `discardPoints` (declarer's counted koini discards) and
  `roundedTotal` (rawTotal after `opponentRounding`; equals rawTotal when 'none')
  so the sim's scoring identities stay checkable.

## 9. Match end (pelin voittaminen)

- After a deal, a side wins by **reaching 500** (score ≥500). This 2026-07-29
  product ruling supersedes the source text's stricter ≥505 interpretation;
  `winCondition: 'exceed'` remains available as a configurable variation.
- If several sides cross in the same deal: the **declarer's side wins if it is among
  them** ("yksi heistä on jakokierroksen huutaja, hän voittaa pelin"); otherwise the
  **highest total** wins; exact tie among crossers with no declarer ⇒ play another
  deal (pinned).

## 10. Pinned decisions (do not change silently)

1. All-pass deals: no penalties, everyone scores rounded raw; dealer rotates normally;
   the deal counts toward the match.
2. Reopened bidding starts clockwise from left of dealer among banned seats.
3. Redeal keeps the same dealer.
4. "Nearest 5" rounding: integer totals are never equidistant (no .5 case exists);
   standard nearest-multiple-of-5.
5. Ask-lockout #1 is implemented as: after a seat's first ask of any kind, that seat's
   `declareOwn` is disabled for the deal (equivalent to freezing held wholes — hands
   only shrink, marriages cannot form later).
6. A whole-ask may be repeated on later tricks (only per-trick one-attempt and the
   lockouts above limit it).
7. 2p slam check: "every trick" means all tricks of the deal won by that player.
8. Contract raise via `setContract`: amount = bid means "Ohi" (no raise).
9. The overtake obligation always requires an overtrump when the player is void
   in the led suit and holds a trump higher than the current highest trump.
10. `redealWindow: 'bidAndExchange'` remains open through the final
    `exchangeContract` raise decision; this is the last possible redeal moment.
11. The default Illisoft game ends at score ≥500, not only after passing 500.

## 11. RuleConfig extension (contract change — authorized by user 2026-07-10)

New/changed fields (`packages/engine/src/config.ts`):

```ts
players: 2 | 3 | 4;                       // was: literal 4
talonSize: 3 | 6;                          // NEW, 2-3p only (koinipakka)
openTalon: boolean;                        // NEW, 2-3p only (avoin/salainen koini)
contractTiming: 'beforeReturn' | 'afterExchange'; // NEW — päämuoto sets the
    // contract between give and return (rules doc §5.3); illisoft raises AFTER the
    // full exchange ("korotus koinimisen jälkeen"). 2-3p is always take→discard→raise.
allPassOutcome: 'forceLastSeat' | 'contractlessDeal'; // NEW — only reachable when
    // forcedOpening=false. 'forceLastSeat' preserves the current engine behavior
    // (last unpassed seat must open); 'contractlessDeal' is illisoft's all-pass deal.
firstTrickRules: 'aceShow' | 'free';       // NEW  (illisoft: 'aceShow')
opponentRounding: 'nearest5' | 'none';     // NEW  (illisoft: 'nearest5')
declarerPorvooBasis: 'bid' | 'contract';   // NEW  (päämuoto 'bid' per architect
                                           //  ruling 2026-07-10; illisoft 'contract')
declarerPorvooScope: 'seat' | 'side';      // NEW  (päämuoto 'seat'; illisoft 'side')
bidBanReopen: boolean;                     // NEW  (illisoft: true)
redealCondition: 'fourSixes' | 'threeSixesOrNoneAboveJack' | null; // replaces
                                           // redealRule: boolean (4p fourSixes:
                                           // pair's combined hands)
redealWindow: 'firstBidTurn' | 'bidAndExchange';                   // NEW
winCondition: 'exceed' | 'reach';          // NEW  (illisoft product preset: 'reach')
winTiebreak: 'declarer' | 'higher';        // NEW  (illisoft: 'declarer'; falls back
                                           //  to 'higher' when no declarer exists)
askLockouts: 'illisoft' | 'basic';         // NEW  (basic = current askedWhole
                                           //  semantics; illisoft adds §7 lockouts)
```

Opponent trickless penalty is **always −bid** (both rulesets agree after the
2026-07-10 architect ruling) — no field.

Presets:
- **`DEFAULT_RULES` stays päämuoto** (existing literals + new fields at:
  players 4, talonSize 3, openTalon true, contractTiming 'beforeReturn',
  allPassOutcome 'forceLastSeat', firstTrickRules 'free', opponentRounding 'none',
  declarerPorvooBasis 'bid', declarerPorvooScope 'seat', bidBanReopen false,
  redealCondition 'threeSixesOrNoneAboveJack', redealWindow 'firstBidTurn',
  winCondition 'reach', winTiebreak 'higher', askLockouts 'basic') — this keeps the
  existing 225-test suite meaningful and CLAUDE.md's engine statement true.
- **`ILLISOFT_RULES`** (new export): players 4 (lobby default mode), talonSize 3,
  openTalon true, cardPoints 'A', lastTrickBonus 20, trumpValues 'heartsHigh',
  minBid 60, bidStep 5, maxBid 420, firstBidder 'leftOfDealer', forcedOpening false,
  allPassOutcome 'contractlessDeal', contractTiming 'afterExchange', exchangeCount 4,
  declareRight 'anyWonTrick', bidBanThreshold −1, bidBanReopen true, winTarget 500,
  winCondition 'reach', winTiebreak 'declarer', firstTrickRules 'aceShow',
  opponentRounding 'nearest5', declarerPorvooBasis 'contract', declarerPorvooScope
  'side', redealCondition 'fourSixes', redealWindow 'bidAndExchange', askLockouts
  'illisoft', askHalfMustHoldCard true, showLastTrick true.
- **The server creates rooms with `ILLISOFT_RULES` by default** — the product plays
  illisoft rules; päämuoto remains selectable via lobby config.

Type changes (`types.ts`):
- `Side = 0 | 1 | 2`; `sideCount(config) = players === 4 ? 2 : players`;
  `sideOf(seat, players)` (4p: seat%2; 2-3p: seat itself); `partnerOf` meaningful
  only in 4p; `nextSeat(seat, players) = (seat+1) % players`;
  `activeSeats(players)`; `tricksPerDeal(config)` (4p: 9; 2-3p: talonSize 3 → 11,
  talonSize 6 → 10). Seat literal type stays 0|1|2|3.
- `MatchState.scores: number[]` (length = sideCount).
- `DealResult { declarer: Seat|null; contract: number|null; bid: number|null;
  made: boolean|null; sides: SideBreakdown[] }` (nulls = contract-less deal).
- `SideBreakdown` gains `discardPoints: number` and `roundedTotal: number`.
- `DealState` gains `talon: Card[] | null` (original talon, immutable after deal),
  `talonTakenBy: Seat | null`, `dummyHand: Card[] | null` (2p),
  `discarded: Card[] | null`, `askedHalf: Record<Seat, boolean>`.
- `dealStarted.deck` layout (documented on the event): active hands seat-major
  (handSize each), then dummy hand (2p only), then talon (2-3p). 4p: 9×4 as today.
- New phases: `exchangeDiscard` (2-3p: declarer holds hand+talon, discards
  talonSize). 4p phase order becomes config-driven via `contractTiming`.
- New events: `talonTaken { seat }`, `cardsDiscarded { seat; cards }` (seat-only
  visibility), `allPassed {}`, `biddingReopened { seats: Seat[] }`.
- New action: `discardCards { cards }`; new hint `{ type: 'discardCards';
  count: number; legal: Card[] }` (legal = hand minus aces and tens).
- `DealView` gains `talonCount: number | null`, `talonSeen: Card[] | null`
  (populated for ALL viewers when openTalon && tricksPlayed === 0 && phase is
  lead/follow; declarer additionally sees talon cards in hand normally),
  `dummyHandCount: number | null`, `discardedCount: number | null`.
- New error codes (i18n keys): `error.mustLeadAce`, `error.mustLeadSpade`,
  `error.aceMustShow`, `error.cannotDiscardAceOrTen`, `error.noPartner`,
  `error.declarationLocked`.

## 12. Terminology (i18n — Finnish terms must match the illisoft ohje)

| Term (fi) | Meaning | Used for |
|---|---|---|
| jakokierros | deal/hand | deal counter, results |
| pelikierros | trick | trick counter |
| kääntö / kääntöpakka | won trick / trick pile | captured piles |
| huuto / huutaminen / Huuda | bid / bidding / "Bid" button | auction UI |
| huutaja | declarer | everywhere (NOT "pelinviejä") |
| Ohi | pass | pass button (bidding AND raise) |
| korotus / korottaminen | raise after exchange | contract UI |
| koinipakka | talon | 2-3p talon |
| koiniminen / Koini | the exchange / confirm button | exchange UI |
| avoin/salainen koini | open/secret talon | lobby option |
| valtti / Tee valtti | trump / "Make trump" | declaration menu |
| kokonainen / Kysy kokonaista | whole marriage / ask whole | 4p ask |
| puolikas / Kysy puolikasta | half / ask half | 4p ask |
| läpäri | slam (all tricks) | results flavor |
| Vaadi uusi jako / uusi jako | demand redeal / redeal | redeal button |
| miinuspisteet | minus points | results |
| maat: hertta, ruutu, risti, pata | suits | everywhere |
| kortit: ässä, kymppi, kuningas, rouva, jätkä | ranks | everywhere |
