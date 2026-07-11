# @hp/bots

The `Actor` interface, the bots, and the **sim/fuzz CLI**.

**The one binding rule:** a bot may consume **only** the redacted `PlayerView` +
`ActionHint[]` — never `MatchState`. This guarantees fairness *and* is living
proof the redacted view is sufficient to play the game.

- `actor.ts` — `Actor.onTurn(view, hints) → PlayerAction`.
- `random.ts` — `RandomLegalBot`, the fuzzing workhorse.
- `heuristic.ts` — `HeuristicBot`, the shipped baseline opponent (deterministic
  given its injected PRNG).
- `prng.ts` — seeded `mulberry32`; all fuzz randomness flows through it, so games
  reproduce from `(seed, gameIndex)`.
- `sim.ts` — the fuzz harness: plays full bot games through the engine's public
  API and checks 9 invariants after every event.

```sh
pnpm sim -- --games 500 --seed 42
pnpm sim -- --games 5000 --seed 31337 --bots mixed   # reports heuristic vs random
pnpm --filter @hp/bots test
```

- Tune a bot → [`../../docs/TASK-RECIPES.md`](../../docs/TASK-RECIPES.md) Recipe E
- Invariants & reproducing failures → [`../../docs/TESTING.md`](../../docs/TESTING.md)
