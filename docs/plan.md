# Huutopussi Online — Implementation Plan

## Context

Build an online multiplayer version of the Finnish card game Huutopussi, playable with friends on mobile phones **in the browser** (no native app). Greenfield repo at `/Users/samuliv/Projects/Poggers/huutopussi`; the compiled rules (all sources + variations) live in `docs/huutopussin-saannot.md` and are the rules source of truth.

**Decisions made with the user:**
- MVP: **4-player partnership form** (2v2, bidding from 50, 3-card partner exchange, contract play). Engine built variant-ready so 3-player pirunpakka comes later.
- **Full TypeScript monorepo**: Node.js WebSocket server + React (Vite) mobile-first client + shared pure-TS engine package.
- Hosting: single Docker image on **Fly.io** (Stockholm region) with a volume for SQLite. Containerized, so trivially movable to a VPS later.
- In scope: **AI bots, fi+en i18n, installable PWA, persistent score history**, and robust **reconnection** (critical on mobile).
- Rooms via shareable link/code (`/r/CODE`), no accounts — nickname + session token in localStorage.

## Rules pinned by config

Engine takes a single `RuleConfig`; MVP defaults from the rules doc's "päämuoto" column (section 10): card points system A (A=11, 10=10, K=4, Q=3, J=2, last trick +10 → 130/deal), trump values ♥100/♦80/♣60/♠40, min bid 50 (forced opening, left of dealer), step 5, max 440, 3-card exchange, declare-trump right = won a trick you led yourself, bid ban at −500, Porvoo = −bid (declarer personally trickless = −2×bid), win at 500, redeal demand (≥3 sixes or nothing above J). Every section-10 variation is a config field so variants are additive later.

Two ambiguities decided explicitly (documented in engine): one declaration attempt (declare/ask-whole/ask-half) per lead opportunity; tie at ≥500 with equal score → play another deal.

## Monorepo layout

pnpm workspaces (no Turborepo — overkill for 5 packages). TS strict + project references, Biome (lint+format), vitest everywhere, zod only at the WS boundary.

```
packages/
├── engine/     # PURE TS, zero deps: types, deck, reduce.ts (applyEvent),
│               # validate.ts, legality.ts, declarations.ts, scoring.ts, view.ts
├── protocol/   # zod schemas for WS envelope + lobby messages
├── bots/       # Actor interface, RandomLegalBot, HeuristicBot, sim/fuzz CLI
├── server/     # ws + better-sqlite3: index, room, sessions, timers, db, botRunner
└── client/     # React + Vite + vite-plugin-pwa + zustand + i18next
Dockerfile (multi-stage: build client → server serves static + WS), fly.toml
```

## Engine design (the heart)

**Event-sourced pure reducer.** Shuffle randomness is materialized into the `DealStarted` event (full permutation), so replay is deterministic → crash recovery, reproducible fuzzing, audit trail. Entry points:

```ts
validateAction(state, seat, action): Event[] | RuleError
applyEvent(state, event): MatchState
redactViewFor(state, viewer): PlayerView
allowedActions(state, seat): ActionHint[]   // legal cards / bid range / declarable suits
```

**Phases:** `lobby → dealing → bidding → exchange.partnerGives → exchange.declarerContract → exchange.declarerReturns → trick.awaitingDeclaration|awaitingCard (×9) → dealScored → next deal | matchEnded`. Declarations happen only between tricks → **trump never changes mid-trick** (asserted invariant). Per-deal flags: `declaredSuits` (suit once per deal), per-seat `hasAskedWhole` (locks own-hand declares + partner's whole-asks per rules 5.4).

**`legalPlays` (trick legality — subtlest function, algorithm fixed before coding):**
1. Empty trick → whole hand.
2. Hold led suit → must follow; within led suit must beat current winner if possible ("beat" incl. the trick-already-trumped case where no led-suit card can beat → any led-suit card). **May NOT trump while holding led suit.**
3. Void in led suit + trump exists → must trump; must overtrump if possible, else forced under-trump.
4. Otherwise → any card.
Winner: highest trump played, else highest card of led suit.

**Hidden info:** `PlayerView` is a structurally different type (other hands are `{count}` — redaction can't be forgotten). Ask outcomes are public knowledge by design (as at a real table). Events carry per-recipient visibility; global seq identical for all.

## WebSocket protocol

Single WS endpoint, JSON + zod, `protocolVersion` handshake. Client→server: `hello{roomCode?, sessionToken?, nickname?}`, `action{actionId, knownSeq, action}`, `lobby{cmd}`, `resync`, `ping`. Server→client: `welcome{sessionToken, snapshot, seq}`, `event{seq, event, turn?{seat, deadlineMs, hints}}`, `snapshot`, `error{code}` (i18n key).

- **Server-computed hints gate the UI** — client never re-derives legality (kills legality-drift bugs).
- **Sync:** per-room monotonic seq; on gap → `resync` → full snapshot (view is ~2–4 KB; always-snapshot beats client-side replay). Event replay exists only server-side.
- **Idempotency:** per-action uuid, LRU of processed ids per session (safe resend after socket death).
- **Marriage asks as messages:** `askWhole` → truthful auto-answer if partner has 0 or 1 marriages; real choice-turn if 2+. `askHalf{rank,suit}` verified against asker's hand, truthful auto yes/no. Rendered as speech bubbles.
- **Mobile wake handling:** server ws-ping 15 s; client resyncs unconditionally on `visibilitychange→visible` / `pageshow` (iOS kills sockets silently).

## Reconnection (chosen approach: grace → autoplay → instant reclaim)

Session token bound to (room, seat, nickname); reconnect rebinds socket, last-connect-wins. Disconnected seat: play continues if it's not their turn; on their turn a ≥30 s grace runs, then the **bot plays for the seat** until the human reconnects (reclaim at next turn boundary). Room with zero humans for 15 min → closed, match persisted as abandoned. Never stalls, never abandons the game, punishes nobody.

## Bots

`Actor.onTurn(view: PlayerView, hints): PlayerAction` — bots see exactly what a human client sees (fairness + proves the view is sufficient). `RandomLegalBot` = fuzzing workhorse. `HeuristicBot` ships in MVP (bid from marriages/aces/tens, pass marriage-halves+aces in exchange, declare best suit early, win cheaply/duck/dump junk). Bot runner submits through the same action pipeline as WS messages, with 500–1500 ms humanizing delay.

**Fuzz harness** (`pnpm sim --games N --seed S`): invariants after every event — 36 cards conserved; accepted actions == hints; trump constant within trick; suits declared once; deal points sum exactly 130; no foreign cards in any serialized view (regex over JSON); replay reproduces byte-identical state; termination. Failing seed → regression test.

## Client

Zustand, two slices: `server` (seq + view + turn, written only by socket layer) and `ui` (ephemeral). No optimistic game mutations — pending spinner until confirming event. Portrait layout (~390×844): top bar (scores, contract, trump), opponents/partner with speech bubbles + connection/bot badges, center trick, bottom 9-card fan (min 44 px targets, **two-step play**: tap to raise, tap again to play; illegal cards greyed via hints). Bottom sheets for bidding / exchange / declaration / contract. i18next fi+en, all server codes are i18n keys (keep "Porvoo", "läpäri" flavor). PWA via vite-plugin-pwa, `registerType: 'prompt'` (no silent mid-game reload), SVG card sprite. Routes: `/`, `/r/:code`. Server serves the client — one origin, no CORS.

## Persistence (SQLite, better-sqlite3, WAL, Fly volume)

Tables: `rooms`, `sessions`, `matches` (final_scores, winner), `deals` (per-deal summary: contract/declarer/points/marriages/porvoo), `deal_events` (event log). Events appended in the action transaction → **crash recovery is free**: on boot replay unfinished matches, mark seats disconnected, reconnection flow handles the rest (`fly deploy` doesn't kill games). Prune old event logs at 30 days, keep summaries.

## Build phases (each independently verifiable, ≈20 units total)

- **P0 [1] Scaffolding**: workspace, packages, CI (typecheck+lint+test). ✓ `pnpm -r test` green.
- **P1 [3] Engine — deal/bid/exchange/scoring** with unit tests (scoring fed synthetic piles). ✓ tests.
- **P2 [4] Engine — trick play + declarations + fuzz**: `legalPlays` case-matrix suite + fast-check oracle, redacted views, RandomLegalBot, sim harness. **Gate: 50k fuzzed games clean before any networking.** ✓ `pnpm sim`.
- **P3 [3] Server**: WS protocol, rooms/sessions, bot runner, timers, resync, idempotency. ✓ integration tests; CLI client beats 3 bots over WS.
- **P4 [4] Client MVP**: home/lobby/table, all sheets, English-only, ugly-but-correct. ✓ human beats 3 bots on a real phone against a laptop server.
- **P5 [2] Reconnect hardening + PWA + i18n**: wake-resync, grace/autoplay/reclaim, install prompt, fi+en. ✓ Playwright reload test; lock a real phone 2 min mid-trick and resume.
- **P6 [2] Persistence + deploy**: SQLite, crash recovery, history UI, Docker, Fly.io. ✓ `kill -9` mid-game → restart → all 4 clients resume; deployed URL playable.
- **P7 [1+] Polish**: heuristic bot tuning, animations, variant-config lobby UI, rematch, playtest with humans.

## Verification strategy

1. Engine unit tests: the legality case matrix (single most valuable test file), bidding edges (forced open, bid ban, all-pass, max), declaration flags, scoring (contract clamp, Porvoo per-seat, 2× declarer Porvoo, both-cross-500).
2. fast-check property tests: legality vs independent brute-force oracle on 100k random positions; CI 500 seeded fuzz games/push, nightly 50k.
3. Server integration: scripted full deal with 4 fake WS clients + chaos test (random drops/reconnects/duplicate actionIds).
4. Playwright (iPhone viewport): room+3 bots full flow; two-context consistency; reload-mid-trick seat reclaim.
5. Manual acceptance per phase as listed above.

## Top risks & mitigations

1. **Trick legality** → algorithm fixed in plan, case-matrix tests + independent oracle, server hints gate UI.
2. **Mid-hand trump changes / ask protocol** → declarations as dedicated between-trick phase, explicit flags, fuzz invariants.
3. **Mobile reconnection** → always-full-snapshot resync, wake-event resync, idempotent actions, grace→autoplay→reclaim, chaos test.
4. **Hidden-info leaks** → single redaction choke point, structurally-safe view type, foreign-card regex fuzz check, bots as living proof the view suffices.
5. **Rules ambiguity between sources** → every variation a documented `RuleConfig` field with a default; ambiguities decided explicitly, not incidentally.
