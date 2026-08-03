# Task recipes — how to make common changes

A cookbook of the changes most likely to be requested, each as an ordered
checklist of **which files to touch, in what order, and how to verify.** The
goal is to let an agent land a correct change without re-deriving the
architecture. Background: [`ARCHITECTURE.md`](ARCHITECTURE.md). Rules you must
not break: [`../AGENTS.md`](../AGENTS.md) §3.

Every recipe ends the same way — the **verify loop**:

```sh
pnpm typecheck && pnpm lint && pnpm test
# + if the engine changed:
pnpm sim -- --games 500 --seed 42     # must be ZERO invariant violations
```

---

## Recipe A — Add a new rule *variation* (a `RuleConfig` field)

Use this when a rule should be **configurable** (a new preset toggle), not a
blanket change. Example: "add an option for a 15-point last-trick bonus."

1. **`packages/engine/src/config.ts`** — add the field to `RuleConfig` with a
   doc comment describing each value. Set its value in `DEFAULT_RULES` and
   `ILLISOFT_RULES` so both presets stay valid. (This file is frozen — a new
   *additive* field is the sanctioned way to extend it; confirm with the user if
   unsure.)
2. **The engine module that reads it** — wire the field into the logic:
   - bidding/auction → `validate.ts`
   - trick following → `legality.ts`
   - scoring/penalties/rounding → `scoring.ts`
   - phase transitions → `reduce.ts`
   Keep the default behavior identical when the field is at its default value.
3. **`packages/protocol/src/index.ts`** — if the host should set it from the
   lobby, add it to `configPatchSchema` with a zod bound. The compile-time drift
   guard forces the type to match `RuleConfig` (typecheck fails otherwise).
4. **`packages/client/src/screens/Lobby.tsx`** — add a control for it in the
   host rules panel, plus i18n keys (Recipe D).
5. **Tests** — add cases in `packages/engine/test/` proving both values; if it
   affects illisoft, extend `illisoft-*.test.ts`.
6. Verify loop (engine changed → run the sim).

> The whole rules system is *config-first by design*: every documented variation
> in `huutopussin-saannot.md` §10 and `illisoft-saannot-spec.md` §11 is already a
> field. Match that pattern.

---

## Recipe B — Change rule *logic* (bidding / legality / scoring / declarations)

Use this when fixing or changing how a rule *works* (not adding a toggle).

1. Find the owning module (see the table in [`ARCHITECTURE.md`](ARCHITECTURE.md)
   §3): `validate.ts`, `legality.ts`, `scoring.ts`, `reduce.ts`.
2. If the change is a genuine behavior change (not a bugfix), consider whether it
   should be a `RuleConfig` field instead (Recipe A) so the other preset is
   unaffected.
3. Make the change **pure** — no deps, no clock, no randomness (AGENTS.md §3.2).
4. Add/adjust a test in `packages/engine/test/`. The legality matrix
   (`legality-matrix.test.ts`) and the brute-force oracle
   (`legality-oracle.test.ts`) are the highest-value suites for trick rules.
5. Verify loop **including the sim** — legality/scoring bugs surface as invariant
   violations. A failing seed → add it to `regressions.test.ts`.

---

## Recipe C — Add or change a wire message / action

The protocol is **frozen** — do this only on explicit instruction. Order matters
because of the compile-time guards.

1. **`packages/engine/src/types.ts`** — if it's a new `PlayerAction`/`GameEvent`,
   add the variant here first.
2. **`packages/protocol/src/index.ts`** — mirror it in `playerActionSchema` /
   the `ServerMsg` union. The drift guards (`_PlayerActionSchemaMatchesEngine`,
   etc.) will fail typecheck until both sides agree.
3. **`packages/engine/src/validate.ts` + `reduce.ts`** — validate → emit events →
   reduce.
4. **`packages/server/src/server.ts`** — handle/route it.
5. **`packages/client/src/{socket.ts, store.ts, screens/**}`** — send/consume it.
6. Bump `PROTOCOL_VERSION` if the change is not backward-compatible.
7. Tests: server integration (`server/test/integration.test.ts`) + client
   (`client/test/socket.test.ts`). Verify loop.

---

## Recipe D — Add or change a UI string (i18n)

**Never hardcode English in engine/server** (they emit i18n *keys*). Client
strings are keys too.

1. Add the key to **both** `packages/client/src/i18n/fi.json` and `en.json`
   (Finnish is the fallback — fill it in for real, not a placeholder). Keep
   flavor words (*Porvoo, läpäri*) intact.
2. For a new engine/server code, the key already arrives as `error.*` /
   `event.*` — just add its translation. (The i18n test asserts fi/en key
   parity, so a missing key fails `pnpm test`.)
3. Use it via `t('the.key')` in the component.
4. Verify loop (`client/test/i18n.test.ts` guards parity).

---

## Recipe E — Tune or extend the bot

1. **`packages/bots/src/heuristic.ts`** — the strategy lives here. **Hard
   constraint:** a bot may consume only `PlayerView` + `ActionHint[]` — never
   `MatchState`. This is what proves the redacted view is sufficient.
2. Keep it deterministic given the injected PRNG (`prng.ts`) — only draw from the
   stream to break exact ties.
3. Add/adjust `packages/bots/test/heuristic.test.ts`.
4. Verify with a bigger sim to check win-rate/behavior:
   `pnpm sim -- --games 5000 --seed 31337 --bots mixed`
   (the log reports heuristic vs random average scores).

---

## Recipe F — Change a client screen / add a bottom sheet

1. Screens: `packages/client/src/screens/{Home,Lobby,Table,History}.tsx`. Table
   sub-parts: `screens/table/{TableSheets,TableOverlays,tableUtils}.tsx`.
2. **Legality/affordances come only from `ActionHint`s** (AGENTS.md §3.4). Render
   the sheet/controls from the current `DealPhase` + hints; never compute what's
   legal locally.
3. No optimistic game mutations — show a pending state until the confirming
   `update` arrives (the store replaces snapshots wholesale).
4. Keep it mobile-first portrait (~390×844), ≥44px touch targets. Strings via
   i18n (Recipe D).
5. Tests: the relevant `client/test/*.test.tsx`. Verify loop; consider an e2e
   spec if it's a core flow.
6. Anything that **animates** → read [`MOTION.md`](MOTION.md) first and reuse its
   tokens (`--dur-*`, `--ease-*`, `--stagger`). Two hard rules: animate only
   `transform`/`opacity`/`filter` (never `background`/`box-shadow` on a loop), and
   give every addition a `prefers-reduced-motion` branch that keeps the
   information and drops the travel.

---

## Recipe G — Change server behavior (rooms / timers / persistence / reconnect)

1. Owning file (ARCHITECTURE.md §3): `rooms.ts`, `sessions.ts`, `timers.ts`,
   `db.ts`, `botRunner.ts`, `server.ts`.
2. Keep the **authority + redaction** guarantees: hints only to the acting seat;
   only redacted `PlayerView`s leave the server; events persist in the action
   transaction.
3. Turn pacing is a **table setting**, not a `RuleConfig` field — it lives in
   `TableSettings` (protocol) and `timers.ts`, kept out of the deterministic
   engine.
4. Tests: the matching `server/test/*.test.ts` (integration, chaos, reconnect,
   persistence, autoplay). Verify loop.

---

## Recipe H — Add a test

- **Engine:** new file in `packages/engine/test/` (one suite per concern).
  Feed synthetic states/events through the public API (`validateAction`,
  `applyEvent`, `scoreDeal`, `redactViewFor`). See [`TESTING.md`](TESTING.md).
- **Reproduce a fuzz failure:** the sim prints the failing `(seed, gameIndex)`;
  reconstruct that game and pin it in `regressions.test.ts`.
- **Server/client:** matching `*/test/` dir, vitest. **E2E:** `e2e/*.spec.ts`
  (Playwright, iPhone-14; hint-driven driver in `e2e/helpers.ts`).

---

## Recipe I — Support a new game mode (e.g. finish 3-player)

The engine is already mode-aware (`players: 2 | 3 | 4`, per-mode phases, talon,
dummy hand). Most of the machinery exists.

1. **`config.ts`** — a preset/patch for the mode (talon size, open talon…).
2. **`validate.ts` / `reduce.ts` / `scoring.ts`** — fill any mode-specific
   branches; the `DealPhase` union already has 2-3p phases (`exchangeDiscard`).
3. **`protocol` `configPatchSchema`** — expose `players`/`talonSize`/`openTalon`.
4. **Client** — `Lobby.tsx` mode selector; `Table.tsx`/overlays already handle
   "each seat is its own side" for 2-3p.
5. Tests: `engine/test/talon-modes.test.ts`, `server/test/modes.test.ts`, and a
   sim run across the mode. Verify loop.

See the "Backlog" in [`PROGRESS.md`](PROGRESS.md) for the intended scope.

---

## When you're unsure

- **Rules dispute?** → [`huutopussin-saannot.md`](huutopussin-saannot.md) is
  authoritative; the illisoft preset follows [`illisoft-saannot-spec.md`](illisoft-saannot-spec.md).
- **What does this Finnish word mean?** → [`GLOSSARY.md`](GLOSSARY.md).
- **Is this contract really frozen?** → yes (AGENTS.md §3.1). Report the concern
  in your final message rather than changing an exported type/schema unasked.
