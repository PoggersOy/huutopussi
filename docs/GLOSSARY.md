# Glossary — domain terms → code

Huutopussi is a Finnish card game, so the domain vocabulary is Finnish and the
code uses English identifiers. This table maps the words you'll see in the rules
docs, comments, and i18n keys to what they mean and where they live in code. It
saves a web search and prevents mis-modelling.

Authoritative rules: [`huutopussin-saannot.md`](huutopussin-saannot.md).

## The game

| Term | Meaning | In code |
| --- | --- | --- |
| **Huutopussi** | "bidding bag" — the game itself: a point-trick game, a variant of *Marjapussi* with an added auction and marriage declarations | the whole project |
| **Marjapussi** | the parent trick game Huutopussi is built on | — (background) |
| **päämuoto** | "main form" — the default rules column (rules §10). The baseline the engine implements | `DEFAULT_RULES` (`config.ts`) |
| **illisoft** | the 2002 *Huutopussi.exe* (illisoft) ruleset; the **lobby default preset** here | `ILLISOFT_RULES` (`config.ts`); [`illisoft-saannot-spec.md`](illisoft-saannot-spec.md) |
| **variaatio** | rule variation | every field of `RuleConfig` |

## Roles & seating

| Term | Meaning | In code |
| --- | --- | --- |
| **huuto** | a bid ("shout"); the auction is a *huutokauppa* | `bid` / `bidPlaced` / `BidRecord` |
| **huutaja** | a bidder (anyone bidding) | acting seat during `bidding` |
| **pelinviejä** | the **declarer** — the last/winning bidder, who names the contract and plays it out | `declarer` (`MatchState.deal`) |
| **pari / parit** | partner / the two partnerships in 4p (partners sit opposite) | `partnerOf(seat)`, `Side`, `sideOf(...)` |
| **seat vs side** | *seat* = a physical chair `0..3`; *side* = a scoring unit. 4p: 2 sides (seats 0+2 vs 1+3). 2-3p: every seat is its own side | `Seat`, `Side`, `sideOf`, `sideCount` |

## Bidding & contract

| Term | Meaning | In code |
| --- | --- | --- |
| **sopimus** | the **contract** — the point target the declarer commits to (≥ their bid, multiple of the step) | `contract` / `setContract` / `contractSet` |
| **korotus** | "raise" — announcing/raising the contract after the exchange | `setContract`; `contractTiming` |
| **pakko(-avaus)** | forced opening — the first bidder must open at ≥ `minBid` | `forcedOpening`, `ActionHint.forced` |
| **uusjako** | **redeal** — a player with a qualifying hand may demand a fresh deal | `demandRedeal` / `redealDemanded`; `redealCondition`, `redealWindow` |

## Exchange

| Term | Meaning | In code |
| --- | --- | --- |
| **vaihto** | 4p **exchange**: partner gives N cards to the declarer, who returns N | `giveCards`/`returnCards`, `exchangeCount`, phases `exchangeGive`/`exchangeReturn` |
| **koini / koiniminen** | 2-3p exchange: the declarer takes the *koinipakka* (talon) into hand and discards down | phase `exchangeDiscard`, `discardCards`, `talonTaken` |
| **koinipakka / talon** | the extra face-down packet dealt in 2-3p | `talon`, `talonSize`, `talonCount` |
| **avoin / salainen koini** | *open* talon (everyone sees it during the first trick) vs *secret* (only the declarer) | `openTalon`, `talonSeen` |

## Trick play — the three *pakko* (compulsions)

| Term | Meaning | In code |
| --- | --- | --- |
| **tikki** | a **trick** | `TrickPlay`, `tricksWon`, `lastTrick` |
| **valtti** | **trump** — set by a marriage declaration; the highest trump wins the trick | `trump` / `trumpSet` |
| **maapakko** | must **follow the led suit** if you hold it | `legalPlays` (`legality.ts`) |
| **ylimenopakko** | must **beat** the current winner if you can (head the trick / overtrump) | `legalPlays` |
| **valttipakko** | if void in the led suit, you must **trump** (and overtrump if possible) | `legalPlays` |

## Declarations (marriages)

| Term | Meaning | In code |
| --- | --- | --- |
| **avioliitto / pari** | a **marriage** — King + Queen of one suit; declaring it sets that suit as trump and scores its value | `Declaration`, `declaredOwn`, `trumpSet`; `declarableSuits` |
| **kokonainen** | a **whole** marriage — you hold both K and Q yourself | `declareOwn` (`how: 'own'`) |
| **puolikas** | a **half** marriage — you hold one of K/Q and get the other from your partner | asks below |
| **kokonaisen kysyminen** | **ask-whole** — ask your partner for a whole marriage | `askWhole` / `answerWhole` (`how: 'wholeAsk'`) |
| **puolikkaan kysyminen** | **ask-half** — ask your partner for the missing K or Q of a suit | `askHalf` / `answeredHalf` (`how: 'halfAsk'`); `askHalfMustHoldCard` |
| ask lockouts | who may still declare/ask after an ask (differs by ruleset) | `askLockouts`, `askedWhole`/`askedHalf` |

*Rule pinned in code:* exactly **one declaration attempt per lead opportunity**;
playing a card is the implicit skip (`config.ts` header comment).

## Scoring

| Term | Meaning | In code |
| --- | --- | --- |
| **Porvoo / mennä Porvooseen** | a side taking **zero tricks** is penalized — it loses its (last) bid's worth; the declarer's failure is worse | `SideBreakdown.porvoo`, `declarerPorvooBasis`, `declarerPorvooScope` |
| **läpäri** | slang for the same zero-trick fate (also a 2p slam counting the full deck) | same as Porvoo; 2p slam noted in `config.ts` header |
| **viimeinen tikki** | the **last-trick bonus** | `lastTrickBonus`, `SideBreakdown.lastTrickBonus` |
| **kortipisteet** | card points (A=11, 10=10, K=4, Q=3, J=2 in system A) | `cardPoints`, `SideBreakdown.cardPoints` |
| **sotilas** | the **Jack** (J) — lowest-value face card (0 pts in some systems) | rank `'J'` |
| pyöristys | opponent rounding to nearest 5 (illisoft) | `opponentRounding` |

## Card names & rank order

Rank strings, **high → low**: `A 10 K Q J 9 8 7 6` — note the **10 outranks the
King**. Cards are `${Suit}${Rank}`, suits `H D C S` (♥♦♣♠). Trump suit values
(`heartsHigh`): ♥100 ♦80 ♣60 ♠40.

| Fi | En | Symbol |
| --- | --- | --- |
| ässä | ace | `A` |
| kymppi | ten | `10` |
| kuningas | king | `K` |
| rouva | queen | `Q` |
| sotilas / jätkä | jack | `J` |
| hertta / ruutu / risti / pata | hearts / diamonds / clubs / spades | `H` / `D` / `C` / `S` |

## Engineering jargon (this repo)

| Term | Meaning |
| --- | --- |
| **frozen contract** | the architect-owned public types/schemas (`engine/src/{types,config,deck}.ts`, `protocol/src/index.ts`) — don't change exports unasked |
| **PlayerView** | the redacted per-seat state clients & bots see (others' hands are counts). Structurally distinct from `MatchState` so hidden cards can't leak |
| **ActionHint** | server-computed legal moves for the acting seat; the **only** source of UI legality |
| **event-sourced** | state changes only via `GameEvent`s folded by `applyEvent`; replay reproduces state (crash recovery, deterministic fuzzing) |
| **snapshot-per-change** | the sync model: server sends a full redacted `PlayerView` on every change; client replaces wholesale (no client replay) |
| **redaction choke point** | `view.ts` — the single place hidden info is stripped |
| **fuzz / sim** | `pnpm sim` — plays bot matches through the engine and checks invariants after every event (see [`TESTING.md`](TESTING.md)) |
