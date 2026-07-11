# Architecture & codebase map

A navigational map of the whole system for anyone (human or AI) making changes.
For the *why* behind the design, see [`plan.md`](plan.md). For the golden rules,
see [`../AGENTS.md`](../AGENTS.md). This document answers **"where does X live"**
and **"what happens when a player acts."**

---

## 1. The shape of the system

```
                 ┌─────────────────────────────────────────────┐
   phone/browser │  client (React PWA)                         │
   ┌───────────┐ │  renders PlayerView, enables moves from     │
   │  Table UI │◄┼─ ActionHints, sends PlayerActions over WS    │
   └───────────┘ │                                             │
        ▲   │    └─────────────────────────────────────────────┘
        │   │ WebSocket (JSON, zod-validated inbound)
   update│   │action
        │   ▼
   ┌────────────────────────────────────────────────────────────┐
   │  server (Node ws)  — AUTHORITATIVE                          │
   │  rooms · sessions · timers · bot runner · SQLite            │
   │                                                            │
   │   validateAction ─► [GameEvent…] ─► applyEvent ─► MatchState│
   │        (engine)          │             (engine)             │
   │                          ▼                                  │
   │              persist events (one txn)                       │
   │                          │                                  │
   │        redactViewFor / redactEventFor  (engine)             │
   │        allowedActions → hints (acting seat only)            │
   └────────────────────────────────────────────────────────────┘
              engine = pure, deterministic, zero-dep
```

Everything authoritative happens on the server, computed by the **pure engine**.
Clients and bots are thin: they render a redacted view and submit actions.

---

## 2. The journey of one action (read this once)

This is the single most useful flow to understand. A player taps a card:

1. **Client** (`client/src/screens/Table.tsx` → `socket.ts`) sends
   `{ t: 'action', actionId, knownSeq, action: { type: 'playCard', card } }`.
   `actionId` is a uuid; the action was only *offered* because it was in the
   server's `ActionHint[]`.
2. **Server** (`server/src/server.ts`) `zod`-parses the message
   (`clientMsgSchema`), then:
   - **Idempotency:** if this `actionId` was already processed for the session,
     replay the original response verbatim (`sessions.ts` LRU) — safe resend
     after a dropped socket.
   - **`validateAction(state, seat, action)`** (`engine/src/validate.ts`) →
     either a `RuleError` (i18n code, sent back as `{ t: 'error', code }`) or an
     array of `GameEvent`s. The engine, not the server, knows the rules.
   - **`applyEvent(state, event)`** (`engine/src/reduce.ts`) folds each event
     into a new `MatchState` (immutably). Events are the *only* way state
     changes.
   - **Persist:** the events are appended to `deal_events` in the *same* SQLite
     transaction that accepts the action (`db.ts`) → crash recovery is free.
3. **Fan-out:** for every recipient (each seated player + spectators) the server
   sends exactly one `{ t: 'update', seq, view, event, turn }`:
   - `view` = `redactViewFor(state, seat)` — that seat's `PlayerView` (others'
     hands are counts).
   - `event` = `redactEventFor(event, seat)` — the triggering event with any
     hidden cards stripped (used for animations/toasts), or `null`.
   - `turn.hints` = `allowedActions(state, actingSeat)` — **only** in the message
     to the acting seat; everyone else gets `hints: null`.
4. **Client** (`socket.ts` → `store.ts`) replaces its snapshot **wholesale**
   (no optimistic mutation, no client-side replay). Components re-render from the
   new `view`; the acting seat's UI enables moves from the new `hints`.

If it's now a **bot's** turn, `botRunner.ts` computes the bot's action from the
same redacted view + hints and submits it through the **same** pipeline (step 2).

Timers (`timers.ts`): a present player who doesn't act within the room's turn
timeout (or a disconnected player after a short grace) is marked "away" and the
bot plays their seat until they reclaim it at a turn boundary.

---

## 3. Package-by-package file map

### `packages/engine` — pure rules engine (the heart)

Zero runtime deps. Deterministic. No I/O, no clock, no randomness (the shuffle
arrives as event data). Throws only on impossible states.

| File | Responsibility |
| --- | --- |
| `types.ts` | **FROZEN.** All state/event/action/view types. Card & seat helpers. The redacted `PlayerView` is a *structurally different type* from `MatchState`, so hidden cards can't leak by accident. Read this first — it is the contract. |
| `config.ts` | **FROZEN.** `RuleConfig` (every rules variation is a field), `DEFAULT_RULES` (päämuoto), `ILLISOFT_RULES` (2002 preset, the lobby default). Header comment pins the ambiguous rulings. |
| `deck.ts` | **FROZEN.** 36-card deck construction, ordering, point values, trick-winner resolution. Pure. |
| `validate.ts` | `validateAction(state, seat, action) → GameEvent[] \| RuleError`; `allowedActions(state, seat) → ActionHint[]` (the legality the whole UI runs on); `expectedActor(state)`. |
| `legality.ts` | `legalPlays(...)` — the subtle "pakko" trick-following rules (follow suit / must head the trick / must trump / overtrump). `declarableSuits(...)`. |
| `reduce.ts` | `applyEvent` (the event-sourced reducer), `initialMatchState`, `nextDealEvent` (builds the next `dealStarted` from a shuffled deck). |
| `scoring.ts` | `scoreDeal(deal, config) → DealResult`: card points, last-trick bonus, marriages, Porvoo penalties, contract clamp, rounding. |
| `view.ts` | **The single redaction choke point.** `redactViewFor`, `redactEventFor`. |
| `index.ts` | Public surface (re-exports the above). |

**State machine** (`DealPhase` in `types.ts`): `bidding → exchange* → lead ⇄
follow (× tricks) → scored`. Declarations happen only in the `lead` phase
(between tricks) → **trump never changes mid-trick** (an asserted invariant).

### `packages/protocol` — the wire contract

| File | Responsibility |
| --- | --- |
| `index.ts` | **FROZEN.** `PROTOCOL_VERSION`, `clientMsgSchema` (untrusted inbound → zod-parsed), server→client `ServerMsg` types (trusted, types only), `configPatchSchema` (host-editable rules), `TableSettings`. Contains **compile-time drift guards** asserting the schemas stay in sync with the engine's `PlayerAction`/`RuleConfig` — if you change the engine contract and forget the protocol, typecheck fails here. |

### `packages/bots` — actors + fuzz harness

| File | Responsibility |
| --- | --- |
| `actor.ts` | The `Actor` interface: `onTurn(view, hints) → PlayerAction`. Bots see exactly what a human client sees — never `MatchState`. |
| `random.ts` | `RandomLegalBot` — the fuzzing workhorse (uniform over hint options). |
| `heuristic.ts` | `HeuristicBot` — the sensible baseline opponent shipped in the MVP. Deterministic given its injected PRNG. |
| `prng.ts` | Seeded `mulberry32` + sampling helpers. All fuzz randomness flows through here → games reproduce from `(seed, gameIndex)`. |
| `sim.ts` | The **fuzz/sim CLI** (`pnpm sim`). Plays full bot matches through the engine's public entry points and checks 9 invariants after **every** event. See [`TESTING.md`](TESTING.md). |

### `packages/server` — authoritative game server

| File | Responsibility |
| --- | --- |
| `server.ts` | `createServer(opts)`: HTTP static host (SPA fallback for `/r/*`) + `/healthz` + `GET /api/rooms` (live-room status probe for the History screen) + WS `/ws`. Implements the protocol: parse → idempotency → `validateAction` → `applyEvent` (persisted) → one redacted `update` per recipient. Hints only to the acting seat. |
| `rooms.ts` | Room registry: 5-char crypto codes, seat bookkeeping, `RoomStatePublic` projection, per-room monotonic `seq`, the live `MatchState`, timer handles. |
| `sessions.ts` | Sessions keyed by uuid token, bound to `(room, seat, nickname)`. Last-connect-wins rebinding. Per-session actionId LRU for idempotent replay. |
| `timers.ts` | Turn deadlines, disconnect grace, autoplay policy, idle-room reaper. Host-editable turn timeout (separate from `RuleConfig`). |
| `botRunner.ts` | Bot actor selection + turn computation; submits through the same action pipeline as WS messages. |
| `db.ts` | `better-sqlite3` (WAL) persistence: `rooms`, `sessions`, `matches`, `deals`, `deal_events`. Events appended in the action transaction → boot-time crash recovery replays unfinished matches. |
| `index.ts` | Entry script (env: `PORT`, `DB_PATH`, `CLIENT_DIST`) + module exports for tests. |

### `packages/client` — React PWA

Zustand store, two slices: `server` (authoritative mirror, written **only** by
the socket layer — snapshot replace, no optimism) and `ui` (ephemeral). Legality
comes **only** from `ActionHint`s.

| Area | Files |
| --- | --- |
| Entry / routing | `App.tsx`, `main.tsx`, `screens/Room.tsx` (routes `/`, `/r/:code`; Lobby vs Table by room status) |
| Network / state | `socket.ts` (typed WS client: backoff reconnect, per-room session tokens, uuid actionIds, wake-resync, ping), `api.ts` (stateless HTTP probes outside the WS protocol — e.g. `GET /api/rooms` for the History screen's open-games list), `store.ts` (two slices) |
| Screens | `screens/{Home,Lobby,Table,History}.tsx` |
| Table internals | `screens/table/{TableSheets,TableOverlays,tableUtils,talonMemory}.ts(x)` — hint-driven bottom sheets, score/end overlays, 2-3p talon-reveal memory |
| Components | `components/{CardFace,ConnectionPill,ConnectionBanner,MatchList,Toasts}.tsx` |
| i18n | `i18n/{index.ts,fi.json,en.json}` — **all** server codes are keys; fi is fallback |
| PWA / install | `pwa.ts`, `install.ts` (registerType `prompt` — never silent mid-game reload) |
| Local memory | `history.ts` (recent rooms + match summaries in localStorage) |
| Styles | `styles/{tokens,base,table}.css` |

---

## 4. Cross-cutting design invariants (don't break these)

- **Determinism / event sourcing.** Every state change is a `GameEvent`;
  `applyEvent` is a pure fold. Replaying the event log reproduces byte-identical
  state (a fuzz invariant, and the basis of crash recovery).
- **Single redaction choke point.** `view.ts` only. A fuzz invariant regexes
  every serialized view/event for foreign cards.
- **Server-authoritative legality.** UI legality = server `ActionHint`s, always.
- **Trump is constant within a trick.** Declarations happen only between tricks.
- **Contract drift is a compile error.** The `protocol` package's type guards
  fail typecheck if its schemas diverge from the engine contract.
- **i18n keys, not English,** in engine/server outputs.

---

## 5. Deploy / runtime topology

One Docker image (multi-stage `Dockerfile`): the Node server serves the built
client and speaks WebSocket on the **same origin** (no CORS). SQLite lives on a
Fly volume → keep **exactly one machine** (`fly.toml`: `min_machines_running=1`,
`auto_stop_machines=false`). In-flight matches survive deploys/crashes (events
persisted per action, replayed on boot; clients resync on reconnect). Health:
`GET /healthz`. Full runbook (domain, certs, secrets) is in [`../README.md`](../README.md).
