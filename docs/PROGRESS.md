# Build progress

Plan: `docs/plan.md`. Rules: `docs/huutopussin-saannot.md`.

| Phase | Status | Verified by |
|---|---|---|
| P0 Scaffolding | done | pnpm workspaces build; `pnpm typecheck`/`pnpm lint` green across 5 packages |
| P1 Engine: deal/bid/exchange/scoring | done | engine vitest suite (part of 319 engine tests); 5000-game sim clean |
| P2 Engine: tricks/declarations/fuzz | done | 319 engine tests + 50k-game fuzz gate (earlier) + 5000-game sim (seed 31337, mixed) — 36,306 deals, zero invariant violations |
| P3 Server | done | 19 server tests (integration/chaos/hidden-info/persistence/reconnect/modes) green |
| P4 Client MVP | done | 49 client vitest tests; `pnpm --filter @hp/client build` (Vite+PWA) green |
| P5 Reconnect + PWA + i18n | done | client reconnect/PWA covered by e2e reconnect+pwa specs; i18n fi+en suite green |
| P6 Persistence + deploy | done | persistence+recovery server tests; `docker build` → 267 MB image serving healthz/SPA/WS |
| E2E (Playwright, chromium/iPhone-14) | done | 5 specs green (full-game, two-humans, reconnect, pwa×2) — 3.9 min/run |
| P7 Polish | pending | — |

## Log

- 2026-07-10: Repo initialized. Frozen engine contracts written by architect:
  `packages/engine/src/{types,config,deck}.ts`. Workflow WF-1 (scaffold + engine
  + tests + fuzz + adversarial review) launched.
- 2026-07-10 (eve): WF-1 delivered P0–P2 code: scaffold, full engine, 225 tests
  green, fuzz harness (2k games verified). Protocol package authored by architect
  (snapshot-per-change sync model — supersedes plan's event+gap scheme).
  GitHub repo created: BigTimeSam/huutopussi (private); CI/CD + Fly.io deploy and
  huutopussi.com domain are the new deployment targets.
- 2026-07-10 20:05: **50k fuzz gate PASSED** — 50,000 games (seed 1000), 558,320
  deals, 23.9M actions, 30.9M events, zero invariant violations, 50.6 games/s.
  P2 gate formally satisfied. Full-stack workflow WF-2 running (server, client,
  bots, infra, engine review lenses in parallel).
- 2026-07-10: Client foundation (P4 scaffold + P5 tech) delivered in
  `packages/client`: Vite+React app (routes `/`, `/r/:code`), typed WS client
  (backoff reconnect, per-room session tokens, uuid actionIds, wake-resync,
  20 s ping), zustand server/ui slices (snapshot-replace, no optimism),
  i18next fi+en (all engine `error.*` codes seeded), PWA (prompt updates,
  generated card-motif icons), felt design tokens, CardFace/CardBack SVG
  components, crude hint-driven placeholder screens, vitest+jsdom suite
  (15 tests). Typecheck/lint/test/build all green.
- 2026-07-10: **P3 server + P6 persistence delivered** in `packages/server`:
  `createServer(opts)` factory (HTTP static host w/ SPA fallback for `/r/*`,
  `/healthz`, ws endpoint `/ws`), full protocol handling (zod-parsed, per-seat
  `redactViewFor`/`redactEventFor`, hints strictly to the acting seat),
  rooms/sessions (crypto 5-char codes, uuid tokens, last-connect-wins),
  64-deep per-session actionId LRU with verbatim replay, turn timers
  (45 s / 10 s awaitWholeAnswer, 30 s disconnect grace, botControlled autoplay,
  reclaim at turn boundary, 15 min idle → abandoned), bot runner (HeuristicBot
  runtime-detected, RandomLegalBot fallback, 500–1500 ms, same action
  pipeline), better-sqlite3 WAL persistence (rooms/sessions/matches/deals/
  deal_events; events appended in the action transaction; boot-time crash
  recovery by replaying deal_events; 30-day event pruning). 9 server tests:
  scripted 4-client full deal, chaos (disconnect/dup-actionId/resync-vs-server
  -truth), hidden-info regex scan, kill-and-recover mid-deal. Typecheck/lint/
  tests green.
- 2026-07-10: **Home + Lobby + History screens delivered** (placeholders
  replaced) in `packages/client`: Home (persisted nickname, create/join,
  localStorage recent-rooms list, deferred `beforeinstallprompt` install
  button, history link), Lobby (4 seat cards rotated around a mini felt table
  with avatar initials/host/bot/disconnect badges, take-seat/stand-up,
  host add/remove bot, share block with room link + clipboard copy + native
  share, host-editable rules panel bound to `configPatchSchema` — cardPoints,
  trumpValues, minBid, winTarget, declareRight, showLastTrick — read-only for
  guests, 4-seat-gated Start), History screen (`/history`, per-room
  `history` messages persisted to localStorage, aggregated newest-first),
  shared ConnectionPill, `ui.history` store slice + socket `history` wiring,
  ~45 new fi/en i18n keys incl. all server lobby `error.*` codes. 31 client
  tests green; typecheck/lint/build green. NOTE: protocol has no "kick human"
  lobby command, so host kick is bots-only (`removeBot`).

- **P4 — Table screen (core game UI)**: replaced the placeholder Table with the
  plan §6 layout — top bar (side scores, contract/bid + declarer, suit-colored
  trump, deal number), three opponent panels (partner top, left/right relative
  to viewer seat; CardBack count-fans, connection/bot/away badges, dealer +
  declarer chips), center trick positioned per relative seat with entry
  animation, trick-winner flash + brief completed-trick linger, last-trick
  peek. Own hand fan with two-step play (raise → confirm; illegal cards greyed
  + disabled from hints; spinner on the raised card until the confirming
  update). Hint-driven bottom sheets rendered in-flow above the hand: bidding
  (high bid, +5/+10/+25 stepper, forced-bid notice, redeal demand), exchange
  give/return (tap-select N in the fan, exact-count confirm), contract
  stepper, declaration (own suits w/ marriage values, whole-ask, half-ask
  sub-picker, "just lead" dismiss + reopen chip), answer-whole suit choice.
  Deal-scored overlay (per-side breakdown incl. Porvoo + running totals) and
  match-ended overlay (winners, host rematch / waiting note). Speech bubbles
  for bids/declarations/asks derived in the store from update.event + snapshot
  diffs (the server only sends the first event of each chain), auto-dismissed
  ~4 s. New `ui` store fields: `selectedCards`, `bubbles`, `completedTrick`.
  10 new Table tests (41 client tests green). Adapted to the widened engine
  contract (sideOf/nextSeat players arg, scores: number[], nullable
  DealResult). NOTE: client typecheck currently fails ONLY in socket.ts —
  engine PlayerAction gained 'discardCards' which @hp/protocol's
  playerActionSchema does not carry yet (in-flight 2-3p migration, not a
  Table issue).

- **P5 — Playwright E2E suite (chromium, iPhone 14 viewport)**: root
  `@playwright/test` devDep + `playwright.config.ts` (single serial worker;
  `webServer` = `e2e/run-server.mjs`, which builds the client + esbuild server
  bundle — skipped in CI via `E2E_SKIP_BUILD=1` — and starts the REAL
  production server entry on :8197 with a temp SQLite db). `e2e/helpers.ts` is
  a hint-driven UI driver that only ever taps enabled elements (bid-min-once →
  pass, exchange tap-select+confirm, min contract, "Just lead", two-step
  raised-card play). Four specs: `full-game` (Anna + 3 bots through a whole
  deal; deal-scored overlay numbers sum per the point system — 130 card+last
  points, 9 tricks, totals add up), `two-humans` (two contexts + 2 bots; bid
  speech bubbles on both screens; the first three tricks byte-identical via
  the last-trick peek + equal scores), `reconnect` (mid-deal reload reclaims
  the seat via the localStorage token with identical hand/scores; faked
  visibilitychange wake resyncs without tripping the 3 s zombie watchdog;
  seat stays playable), `pwa` (manifest + SW activation + offline shell via
  the precache, skipping gracefully on SW caveats). New CI job `e2e` (needs:
  ci, chromium only, uploads the report on failure); root script `test:e2e`.
  Full suite green twice in a row (~4.5 min/run — real bot delays).

- 2026-07-10 (evening): **Full-stack build verified end-to-end — final gate
  green.** The complete stack (engine + protocol + bots + server + client +
  E2E + Docker) now passes a single gate run:
  - `pnpm typecheck` — 5 packages clean.
  - `pnpm lint` (Biome) — 106 files, no findings.
  - `pnpm test` — **402 unit tests** green (engine 319, client 49, server 19,
    bots 15; protocol type-only, no runtime tests).
  - `pnpm sim -- --games 5000 --seed 31337 --bots mixed` — 5,000 games, 36,306
    deals, 1.38M actions, 1.88M events, **zero invariant violations**,
    **71.0 games/s** (heuristic avg 551.8 vs random 140.9).
  - `pnpm --filter @hp/client build` — Vite prod build + PWA precache (13
    entries, 469 KiB) green.
  - `docker build -t hp-final .` — multi-stage image, **267 MB**, runtime serves
    static SPA + `/ws` + `/healthz`.
  - `npx playwright test` (chromium, iPhone-14 viewport) — **5 E2E specs green**
    (full-game, two-humans, reconnect, pwa manifest + offline), ~3.9 min/run.

  One gate blocker found and fixed during this run: the server now defaults new
  rooms to **illisoft** rules (`defaultConfig()` → `ILLISOFT_RULES`, last-trick
  bonus 20, contract-less deals), but `e2e/full-game.spec.ts` still asserted the
  päämuoto point system (130-point deals, always a declarer). Fixed by pinning
  päämuoto in that spec via a new `setPreset()` helper (selects the lobby
  preset dropdown and waits for the server echo) — the illisoft default path
  stays covered by the two-humans/reconnect specs, which run under it. No engine
  or product code changed; the engine was already proven consistent for the
  illisoft config by the sim's 4p `cardPoints+lastTrickBonus == totalDealPoints`
  invariant (line 451) over all 36,306 deals.

- 2026-07-11 (early): **Final review panel (5 lenses) + gate green on Opus.**
  After the Fable 5 quota was exhausted mid-panel, the workflow was resumed under
  Opus 4.8 (workflow agents inherit the session model; completed agents replayed
  from cache). Adversarial panel across security, mobile-UX, resilience,
  code-quality, plan-compliance: 9 confirmed high/medium findings fixed, low ones
  triaged below. Architect re-verified everything independently: `pnpm typecheck`
  + `pnpm lint` (106 files) clean, **406 unit tests** green (engine 320, client 52,
  server 19, bots 15), `pnpm sim --games 5000 --seed 31337 --bots mixed` clean
  (73 games/s, 1.88M events, 0 violations), `docker build` → image serves
  SPA+WS+`/healthz`, Playwright 5/5. **GitHub Actions CI green** (typecheck/lint/
  test/sim + Playwright e2e jobs). Domain corrected to **huutopussi.com** across
  README/PROGRESS (an infra agent had guessed `.online`); deploy runbook in README.

  Open low-severity polish (non-blocking, deferred to P7):
  1. `error.declarationUsed` is a misleading code when a declaration is attempted
     at the first lead (no declaration window ever existed) — cosmetic i18n key.
  2. Overlapping hand fan gives interior cards a <44px hit area at 320px width
     (edges fine); consider spreading the fan or a tap-to-front affordance.
  3. `--text-dim` over the brightest point of the felt gradient is ~4:1 (below
     WCAG AA 4.5 for small text); darken the dim token or the gradient center.
  4. `rooms`/`sessions` SQLite rows are never pruned (only `deal_events` age out)
     — slow disk growth over months; add a closed-room reaper.
  5. Mid-turn-disconnect grace extension isn't broadcast, so other clients' turn
     countdown drifts until the next update (cosmetic timer skew).
  6. Erlangen bluff half-ask (`askHalfMustHoldCard=false`, not in any default
     preset) can award marriage points for a marriage the side doesn't hold —
     revisit if/when an Erlangen preset ships.
  7. No E2E asserts the illisoft **default's** scoring specifics (last-trick 20,
     nearest-5 rounding, contract-less all-pass); add an illisoft-scoped spec.
  8. Minor dead code (`Db.setRoomHost` unused; client `actorOf` re-derives the
     server-sent acting seat as a fallback).

## Backlog (post-MVP)

- **illisoft ruleset preset**: the user's old Huutopussi.exe (2002) help file
  documents ~10 rule deltas (last trick 20, minBid 60, maxBid 420 instant win,
  no forced opening → contract-less deals, 4-card exchange, anyWonTrick,
  first-trick ace/spade + ace-must-show, negative-score bid ban with reopen,
  opponent rounding to 5, trickless-opponents lose un-raised bid, >500 win with
  declarer tiebreak, four-6s redeal, pair-wide half-ask lockout). Several need
  new RuleConfig fields. Source: memory `illisoft-hlp-ruleset`.
- 3-player pirunpakka form; 2-player variants (rules doc §6–8).
- Erlangen variant preset (rules doc §9).
