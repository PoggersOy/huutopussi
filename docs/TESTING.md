# Testing guide

How verification is organized, what the fuzz harness guarantees, and how to add
a test or reproduce a failure. The short rule: **every behavior change ships with
a test, and every engine change must pass the sim.** See also the "Definition of
done" in [`../AGENTS.md`](../AGENTS.md) §7.

## The commands

```sh
pnpm typecheck                        # tsc across all packages (also catches contract drift)
pnpm lint                             # Biome
pnpm test                             # vitest across all packages
pnpm --filter @hp/engine test         # one package
pnpm sim -- --games 500 --seed 42     # engine fuzz harness (the P2 gate)
pnpm test:e2e                         # Playwright (iPhone-14 viewport)
```

## The test pyramid

| Layer | Where | What it covers |
| --- | --- | --- |
| **Engine unit** | `packages/engine/test/` (11 suites) | rules, scoring, legality, declarations, redaction, per-mode/talon behavior, bidding, regressions |
| **Engine property/fuzz** | `packages/bots/src/sim.ts` (`pnpm sim`) | invariants over whole random games; a legality oracle cross-check |
| **Bots** | `packages/bots/test/` | heuristic strategy |
| **Server** | `packages/server/test/` | integration (scripted full deal over WS), chaos (drops/dup actions), hidden-info scan, reconnect, persistence/recovery, autoplay, modes |
| **Client** | `packages/client/test/` | store, socket, screens, i18n key parity, CardFace |
| **E2E** | `e2e/*.spec.ts` (Playwright) | full game vs bots, two humans, reconnect/seat-reclaim, PWA |

Framework is **vitest** everywhere (Playwright for e2e). One suite file per
concern. Tests exercise the **public API** (`validateAction`, `applyEvent`,
`scoreDeal`, `redactViewFor`, …), not internals.

## The fuzz harness (`pnpm sim`) — what it proves

`sim.ts` plays complete bot-vs-bot matches **only through the engine's public
entry points** and asserts these invariants after **every** event application.
This is the engine's primary correctness gate.

| | Invariant |
| --- | --- |
| (a) | 36 unique cards conserved across hands + captured + trick-in-progress |
| (b) | per-seat hand sizes consistent with the phase and mode (2/3/4 players) |
| (c) | trump never changes while a trick is in progress |
| (d) | each suit is declared at most once per deal |
| (e) | at `dealScored`, every `SideBreakdown` re-derived independently matches |
| (f) | **no redacted view or event contains a card hidden from its viewer** (regex over serialized JSON — the hidden-info guarantee) |
| (g) | replaying the collected event log from the initial state reproduces byte-identical state (determinism / crash-recovery basis) |
| (h) | hint/validate equivalence: every action the hints offer validates, and every action they omit is rejected — probed exhaustively at each turn |
| (i) | games terminate (a max-deals cap is fatal if hit) |

All randomness flows through a seeded `mulberry32` PRNG (`bots/src/prng.ts`), so
every game is reproducible from `(seed, gameIndex)`.

### Running it

```sh
pnpm sim -- --games 500  --seed 42                 # CI gate (fast)
pnpm sim -- --games 5000 --seed 31337 --bots mixed # heavier; reports win rates
```

CI runs the 500-game gate on every push/PR. Historically the engine has been run
through a 50k-game gate with zero violations before networking was allowed.

## Reproducing & pinning a fuzz failure

1. The sim prints the failing **seed and game index** and the violated invariant.
2. Re-run that exact seed to confirm; step through the reported game.
3. Add a deterministic regression test to
   `packages/engine/test/regressions.test.ts` that reconstructs the offending
   position and asserts the fix. A failing seed becoming a permanent test is the
   intended workflow.

## Adding a test — quick pointers

- **Engine:** new file in `packages/engine/test/` (or extend the matching
  suite). Build a `MatchState` via `initialMatchState` + a sequence of
  `applyEvent`, or feed synthetic `DealState`s to `scoreDeal`. The highest-value
  suites to emulate: `legality-matrix.test.ts` (the case matrix) and
  `legality-oracle.test.ts` (brute-force cross-check).
- **Illisoft-specific** scoring/bidding: `illisoft-scoring.test.ts`,
  `illisoft-bidding.test.ts`.
- **Server:** the matching `packages/server/test/*.test.ts`; use the WS test
  helpers in `server/test/helpers.ts`.
- **Client:** matching `packages/client/test/*.test.tsx` (jsdom).
- **E2E:** `e2e/*.spec.ts`. The driver in `e2e/helpers.ts` is **hint-driven** —
  it only ever taps enabled elements, mirroring the server-authoritative-legality
  rule. Reuse it rather than hard-coding taps.

## i18n parity

`packages/client/test/i18n.test.ts` asserts the `fi.json` and `en.json` key sets
match. A new server/engine code without both translations fails `pnpm test` — so
adding the key is part of the change, not a follow-up (see
[`TASK-RECIPES.md`](TASK-RECIPES.md) Recipe D).
