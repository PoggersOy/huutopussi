# AGENTS.md — the guide for AI coding agents

This is the **canonical, tool-neutral onboarding file** for any AI coding agent
working in this repo (Claude Code, Cursor, GitHub Copilot, Codex, Zed, Aider,
Windsurf, Jules, …). Read it first. It is deliberately short and navigational:
its job is to point you at the right file and the right rule, not to re-explain
code that already documents itself.

> Claude Code also auto-loads `CLAUDE.md`, which imports this file. Other tools
> read `AGENTS.md` directly (or a thin pointer that redirects here). Keep the
> two in sync: **put durable, tool-neutral guidance here.**

---

## 1. What this project is

**Huutopussi Online** — an online multiplayer version of the Finnish trick-taking
card game *Huutopussi*, playable with friends on mobile phones in the browser
(no native app, just a room link). TypeScript monorepo, pnpm workspaces:

- a **pure, deterministic, event-sourced game engine** (zero runtime deps),
- an **authoritative WebSocket server** (Node `ws` + SQLite),
- a **mobile-first React PWA client**,
- **AI bots** that play through the exact same interface a human sees,
- a shared **achievements/title catalogue** evaluated from authoritative results,
- optional Google sign-in, Elo ratings, and ranked/unranked matchmaking,
- fi/en i18n, reconnection handling, persistent score history.

Live at **huutopussi.online** (Fly.io). See [`README.md`](README.md) for the
user- and ops-facing story; this file is for people (and agents) *changing the
code*.

---

## 2. Read-this-first index (so you don't read everything)

Open **one** of these based on your task, not all of them:

| If you need to… | Read |
| --- | --- |
| Understand the whole system + how one action flows through it | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Make a specific kind of change (add a rule, an i18n string, a bot behavior…) | [`docs/TASK-RECIPES.md`](docs/TASK-RECIPES.md) |
| Decode a Finnish/domain term (*Porvoo, koini, läpäri, marriage, päämuoto*…) | [`docs/GLOSSARY.md`](docs/GLOSSARY.md) |
| Add or run tests, reproduce a fuzz failure, understand the invariants | [`docs/TESTING.md`](docs/TESTING.md) |
| Settle a rules dispute | [`docs/huutopussin-saannot.md`](docs/huutopussin-saannot.md) (authoritative) |
| Understand the illisoft 2002 ruleset preset | [`docs/illisoft-saannot-spec.md`](docs/illisoft-saannot-spec.md) |
| Know the original architecture/plan & decisions | [`docs/plan.md`](docs/plan.md) |
| See build history / current status | [`docs/PROGRESS.md`](docs/PROGRESS.md) |
| Get a map of every doc | [`docs/README.md`](docs/README.md) |

The engine's public API is **self-documenting**: read the doc-commented
[`packages/engine/src/types.ts`](packages/engine/src/types.ts) and
[`config.ts`](packages/engine/src/config.ts) directly — they are the contract.

---

## 3. Golden rules (violating these is the expensive mistake)

1. **Frozen contracts.** `packages/engine/src/{types,config,deck}.ts` and
   `packages/protocol/src/index.ts` are the public wire/type contracts, written
   by the architect. **Do not change exported types/signatures without an
   explicit instruction.** Build everything else to fit them. If a contract
   looks wrong, say so in your final message — don't change it unilaterally.
   (Cross-package drift is caught at compile time by guards in `protocol`.)

2. **The engine is pure and deterministic.** `packages/engine` has **zero
   runtime dependencies** and no I/O, no clock, no randomness. All randomness
   enters as data: the shuffle is the `deck` payload of the `dealStarted` event.
   Never add a dependency, `Date.now()`, `Math.random()`, or `console` to the
   engine.

3. **The engine throws never (for rule violations).** `validateAction` returns
   a `RuleError` value (never throws). `applyEvent` may `throw` **only** on
   impossible states — that throw asserts an engine bug, not bad user input.

4. **Legality is server-authoritative; the client never recomputes it.** The UI
   enables/greys moves **only** from server-sent `ActionHint[]`. Never re-derive
   legal moves in the client — that reintroduces the drift bugs the whole design
   exists to prevent.

5. **Hidden information has exactly one choke point.** Clients and bots only ever
   see a redacted `PlayerView` (other hands are counts, not cards). Redaction
   lives in `packages/engine/src/view.ts` (`redactViewFor` / `redactEventFor`).
   `TurnInfo.hints` go **only** to the acting seat. A fuzz invariant scans every
   serialized view/event for foreign cards — don't route raw `MatchState` or
   another seat's cards to a client.

6. **No user-facing English in engine/server.** All error/event codes are i18n
   keys (e.g. `error.mustHeadTrick`). Translations live in
   `packages/client/src/i18n/{fi,en}.json`. Finnish is the fallback language.

7. **Commit directly to `main`. No branches, no PRs.** This overrides any
   default "branch first" behavior. CI + Deploy run automatically from `main`.
   **Only commit/push when the user asks.**

8. **TypeScript strict, Biome-formatted.** No `any` except at a validated
   boundary. Run `pnpm lint` (and `pnpm typecheck`) before finishing.

---

## 4. Repository map

Dependency direction is strict and one-way (`→` means "depends on"):

```
client ─┬─→ protocol ─→ engine        bots ─→ engine
        └─→ achievements ─→ engine
server ──→ bots, protocol, achievements, engine
```

| Package | `@hp/…` | What it is | Deps |
| --- | --- | --- | --- |
| [`packages/engine`](packages/engine) | `engine` | Pure event-sourced rules engine. The heart. | **none** |
| [`packages/achievements`](packages/achievements) | `achievements` | Pure achievement predicates, progress, and title catalogue. | engine |
| [`packages/protocol`](packages/protocol) | `protocol` | zod schemas for the WS wire contract | engine, zod |
| [`packages/bots`](packages/bots) | `bots` | Actor interface, bots, sim/fuzz CLI | engine |
| [`packages/server`](packages/server) | `server` | `ws` server: rooms, sessions, timers, SQLite | bots, protocol, achievements, engine |
| [`packages/client`](packages/client) | `client` | React + Vite + PWA mobile client | protocol, achievements, engine, react… |

Top level: `Dockerfile` (multi-stage: build client → server serves static + WS),
`fly.toml` (Fly.io), `e2e/` (Playwright, iPhone-14 viewport), `docs/`,
`.github/workflows/` (CI + Deploy). Full file-by-file responsibilities are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 5. Commands

Prereqs: **Node 24, pnpm 10** (`corepack enable` picks the pinned version).

```sh
pnpm install                          # install all workspace deps

# Run everything (do this before finishing any change):
pnpm typecheck                        # tsc across all packages
pnpm lint                             # Biome check   (pnpm lint:fix to autofix)
pnpm test                             # vitest across all packages

# Targeted:
pnpm --filter @hp/engine test         # one package's tests
pnpm sim -- --games 500 --seed 42     # seeded engine fuzz harness (the P2 gate)
pnpm test:e2e                         # Playwright (builds client+server first)
pnpm build:server                     # esbuild server bundle
pnpm --filter @hp/client build        # Vite prod build + PWA

# Dev servers (two terminals):
pnpm --filter @hp/server dev
pnpm --filter @hp/client dev
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test + a 500-game seeded
sim on every push/PR, then Playwright e2e. Deploy is automatic on green `main`.

---

## 6. Where do I make a change? (quick index)

Full step-by-step recipes with the files and checks for each are in
[`docs/TASK-RECIPES.md`](docs/TASK-RECIPES.md). The one-line version:

| Change | Primary files |
| --- | --- |
| A game-rule **variation** | `engine/src/config.ts` (add a `RuleConfig` field) → the engine module that reads it → `protocol` `configPatchSchema` → client lobby → tests |
| Rule **logic** (bidding/legality/scoring/declarations) | `engine/src/{validate,legality,scoring,reduce}.ts` + a test in `engine/test/` |
| A **UI-facing string** | `client/src/i18n/{fi,en}.json` (never hardcode English) |
| **Bot** strategy | `bots/src/heuristic.ts` (must consume only `PlayerView` + hints) |
| A **client screen / sheet** | `client/src/screens/**` (legality from hints only) |
| A **wire message** | `protocol/src/index.ts` (frozen — needs explicit instruction) then server + client |
| A **server** behavior (rooms/timers/persistence) | `server/src/{server,rooms,sessions,timers,db,botRunner}.ts` |
| An **achievement/title** | `achievements/src/{catalogue,predicates,titles}.ts` → server evaluation → client i18n/profile |

---

## 7. Definition of done

Before you consider a change complete:

1. `pnpm typecheck` — clean (this also catches contract drift across packages).
2. `pnpm lint` — clean.
3. `pnpm test` — green; **add/adjust a test** for the behavior you changed.
4. If you touched the **engine**, run `pnpm sim -- --games 500 --seed 42` — it
   must report **zero invariant violations**. A failing seed becomes a
   regression test (see [`docs/TESTING.md`](docs/TESTING.md)).
5. Update docs when you change behavior they describe (esp. `config.ts` comments,
   `docs/TASK-RECIPES.md`, and `docs/PROGRESS.md` for milestones).

Only commit/push when asked (§3.7).

---

## 8. Gotchas that cost agents time

- **Rank order:** the **10 outranks the King** (`A 10 K Q J 9 8 7 6`). Card
  strings are `${Suit}${Rank}`, e.g. `H10`, `SA`, `C6`.
- **Seats vs sides:** seats are `0..3`; in 4p, sides are pairs (0+2 vs 1+3); in
  2-3p every seat is its own side. Use the helpers in `types.ts`
  (`sideOf`, `partnerOf`, `nextSeat`, `activeSeats`) — don't hand-roll `% 2`.
- **The default room ruleset is `ILLISOFT_RULES`, not `DEFAULT_RULES`.** Some
  tests pin `paamuoto` explicitly. Don't assume 130-point / always-a-declarer
  deals.
- **Sync model = snapshot-per-change** (this supersedes the "event+gap resync"
  section of `docs/plan.md`). The server sends a full redacted `PlayerView` on
  every change; the client replaces state wholesale. No client-side replay.
- **Two ambiguous rules are pinned** in `config.ts`'s header comment (one
  declaration attempt per lead; ≥500 exact ties play another deal). Don't
  re-litigate them silently.
- Domain words are Finnish — [`docs/GLOSSARY.md`](docs/GLOSSARY.md) saves you a
  web search.
