# GitHub Copilot instructions

This repo's canonical, tool-neutral guidance for AI coding agents lives in
[`AGENTS.md`](../AGENTS.md). **Read it first** — it is the single source of truth;
this file only points there so it isn't duplicated.

Non-negotiables to keep in mind while suggesting code (full detail in `AGENTS.md` §3):

- **Frozen contracts:** don't change exported types/schemas in
  `packages/engine/src/{types,config,deck}.ts` or `packages/protocol/src/index.ts`
  without explicit instruction.
- **Engine is pure & deterministic:** zero deps, no clock, no randomness, no I/O.
  It returns `RuleError` values (never throws for rule violations).
- **Legality is server-authoritative:** the client enables moves only from
  server-sent `ActionHint`s — never recompute legality locally.
- **Hidden info has one choke point** (`engine/src/view.ts`); hints go only to the
  acting seat.
- **No user-facing English in engine/server** — emit i18n keys; translations in
  `packages/client/src/i18n/{fi,en}.json`.
- **Commit to `main`, no branches/PRs;** only commit when asked.

Where to make a change and how to verify: [`docs/TASK-RECIPES.md`](../docs/TASK-RECIPES.md).
System map: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
