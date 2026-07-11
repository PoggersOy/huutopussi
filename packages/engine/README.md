# @hp/engine

The **pure, deterministic, event-sourced rules engine** — the heart of the game.
Consumed by `protocol`, `bots`, `server`, and (types) `client`.

**The one binding rule:** this package has **zero runtime dependencies** and does
**no I/O, no clock, no randomness**. All randomness enters as data (the shuffle is
the `deck` payload of the `dealStarted` event). `validateAction` returns
`RuleError` values and never throws; `applyEvent` throws only on impossible states
(engine-bug assertions).

**Frozen contracts** (don't change exported types/signatures without instruction):
`src/types.ts`, `src/config.ts`, `src/deck.ts`. They are self-documenting — read
them as the spec.

Entry points (`src/index.ts`): `validateAction`, `applyEvent`, `allowedActions`,
`scoreDeal`, `redactViewFor`/`redactEventFor`, `legalPlays`, `initialMatchState`,
`nextDealEvent`.

- File-by-file map → [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §3
- How to change a rule → [`../../docs/TASK-RECIPES.md`](../../docs/TASK-RECIPES.md) A/B
- Tests & fuzz invariants → [`../../docs/TESTING.md`](../../docs/TESTING.md)
- Golden rules → [`../../AGENTS.md`](../../AGENTS.md)

```sh
pnpm --filter @hp/engine test
pnpm sim -- --games 500 --seed 42     # fuzz gate (run after any engine change)
```
