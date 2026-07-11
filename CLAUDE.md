# Huutopussi Online

Online multiplayer Finnish card game (Huutopussi) for mobile browsers. TypeScript monorepo, pnpm workspaces.

## Canonical agent guide
The full, tool-neutral onboarding guide is **`AGENTS.md`** (imported below so it
loads automatically). It holds the golden rules, repo map, commands, and a doc
index. Read it, then open the one deep doc your task needs:

- `AGENTS.md` — start here (golden rules, repo map, commands, "where do I change X").
- `docs/ARCHITECTURE.md` — system map + the journey of one action + file-by-file responsibilities.
- `docs/TASK-RECIPES.md` — ordered checklists for common changes (rules, i18n, bots, screens…).
- `docs/GLOSSARY.md` — Finnish/domain terms → code symbols.
- `docs/TESTING.md` — test taxonomy, fuzz invariants, how to add/reproduce a test.
- `docs/README.md` — the full doc index.

@AGENTS.md

## Source-of-truth documents
- `docs/plan.md` — approved implementation plan (architecture, protocol, phases). Follow it.
- `docs/huutopussin-saannot.md` — complete game rules + variations. **Rules disputes are settled by this document**; the engine implements the "päämuoto" column of its section 10 by default via `RuleConfig`.
- `docs/PROGRESS.md` — build progress log. Update when completing a milestone.

## Commands
- `pnpm install` — install all workspace deps
- `pnpm -r typecheck` / `pnpm -r test` / `pnpm -r build` — run across packages
- `pnpm lint` — Biome check (root)
- `pnpm sim -- --games N --seed S` — engine fuzz harness (packages/bots)

## Architecture (read docs/plan.md for detail)
- `packages/engine` — PURE TypeScript, **zero runtime dependencies**. Deterministic event-sourced reducer. All randomness enters via event payloads (the `dealStarted` event carries the full deck permutation).
- `packages/protocol` — zod schemas for the WebSocket envelope. Depends on engine types only.
- `packages/bots` — Actor interface + bots + sim/fuzz CLI. Bots may only consume `PlayerView` + `ActionHint[]`, never `MatchState`.
- `packages/server` — Node `ws` server, rooms/sessions/timers, better-sqlite3. Server is authoritative; clients only ever see redacted `PlayerView`s.
- `packages/client` — React + Vite + zustand + i18next + vite-plugin-pwa. Mobile-first portrait. UI legality comes ONLY from server-sent `ActionHint`s, never recomputed locally.

## Frozen contracts
`packages/engine/src/types.ts`, `config.ts`, and `deck.ts` are the frozen public contract, written by the architect. Do not change exported types/signatures without an explicit instruction; build everything else to fit them. If you believe a contract is wrong or insufficient, report it in your final message instead of changing it unilaterally.

## Git workflow
- **Commit directly to `main`. Do NOT create branches or pull requests.** This overrides the default "branch first" behavior. Push straight to `main`; CI + Deploy run automatically from there.
- Only commit or push when the user asks.

## Conventions
- TypeScript strict; no `any` unless unavoidable at a validated boundary.
- Engine code throws never — it returns `RuleError` values from `validateAction`; `applyEvent` may `throw` only on impossible states (assertion of engine bugs).
- Error/event codes are i18n keys (e.g. `error.mustHeadTrick`); no user-facing English strings in engine/server.
- Tests: vitest. Engine tests live in `packages/engine/test/`. One suite file per concern.
- Formatting/linting: Biome (`biome.json` at root). Run `pnpm lint` before finishing.
