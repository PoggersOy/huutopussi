# Build progress

Plan: `docs/plan.md`. Rules: `docs/huutopussin-saannot.md`.

| Phase | Status | Verified by |
|---|---|---|
| P0 Scaffolding | done | pnpm workspaces build; `pnpm typecheck`/`pnpm lint` green across 6 packages |
| P1 Engine: deal/bid/exchange/scoring | done | engine vitest suite (321 engine tests); 5000-game sim clean |
| P2 Engine: tricks/declarations/fuzz | done | 321 engine tests + 50k-game fuzz gate (earlier) + 5000-game sim (seed 31337, mixed) — 36,306 deals, zero invariant violations |
| P3 Server | done | 19 server test files / 111 tests (integration/chaos/privacy/persistence/reconnect/modes) green |
| P4 Client MVP | done | 120 client tests; `pnpm --filter @hp/client build` (Vite+PWA) green |
| P5 Reconnect + PWA + i18n | done | client reconnect/PWA covered by e2e reconnect+pwa specs; i18n fi+en suite green |
| P6 Persistence + deploy | done | persistence+recovery server tests; `docker build` → 266 MiB image serving healthz/SPA/WS |
| E2E (Playwright, chromium/iPhone-14) | done | 5 specs green (full-game, two-humans, reconnect, pwa×2) — latest local run 1.5 min |
| P7 Polish | done | production-readiness audit; 588 tests + full unit/sim/build/Docker/E2E gate |

## Log

- 2026-07-29: **Illisoft rule rulings pinned and every engine variation exposed.**
  The existing mandatory overtrump behavior was confirmed and documented: when
  void in the led suit after a trump, a higher trump is compulsory if held. The
  existing `bidAndExchange` redeal window remains open through the final contract
  raise. The default Illisoft match now ends at score **≥500** (`winCondition:
  'reach'`), and the help copy says “reaches” rather than “passes” the target.
  The saved-rules editor and wire schema now include the three formerly omitted
  `RuleConfig` fields: `bidStep`, `firstBidder`, and `askHalfMustHoldCard`;
  a protocol regression test asserts that the schema contains every engine
  config key. Verification: typecheck + lint clean, **600 tests** green,
  500-game seed-42 sim clean (5,645 deals / 222,808 actions / 296,124 events),
  client+server production builds green, Playwright 5/5.

- 2026-07-16: **Production-readiness audit completed.** Fixed GDPR erasure for
  casual/bot match rosters and detached erased users from live sessions; pruned
  expired auth tokens, closed-room sessions and inactive rooms; made a connected
  guest temporary host when the recorded host is offline; synchronized the
  disconnect grace deadline; rejected stale client WebSocket frames; added
  WebSocket hello timeouts and fixed-window flood protection; and added baseline
  HTTP security headers. Production sourcemaps are disabled, CI/deploy actions
  are commit-SHA pinned, and Docker now uses the repository-pinned pnpm version
  in every build stage. Added regression coverage for every changed behavior.
  Final gate: typecheck + lint clean, **588 tests** green, 500-game seed-42 sim
  clean (5,665 deals / 223,448 actions / 297,047 events), client+server builds
  green, OSV production-dependency scan clean (77 packages / 0 findings), Docker
  image starts and serves `/healthz`/SPA with no sourcemaps, Playwright 5/5.

- 2026-07-10: Repo initialized. Frozen engine contracts written by architect:
  `packages/engine/src/{types,config,deck}.ts`. Workflow WF-1 (scaffold + engine
  + tests + fuzz + adversarial review) launched.
- 2026-07-10 (eve): WF-1 delivered P0–P2 code: scaffold, full engine, 225 tests
  green, fuzz harness (2k games verified). Protocol package authored by architect
  (snapshot-per-change sync model — supersedes plan's event+gap scheme).
  GitHub repo created: BigTimeSam/huutopussi (private); CI/CD + Fly.io deploy and
  huutopussi.online domain are the new deployment targets.
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
  test/sim + Playwright e2e jobs). Domain corrected to **huutopussi.online** across
  README/PROGRESS (an infra agent had guessed `.online`); deploy runbook in README.

  Open low-severity polish (non-blocking, deferred to P7):
  1. `error.declarationUsed` is a misleading code when a declaration is attempted
     at the first lead (no declaration window ever existed) — cosmetic i18n key.
  2. Overlapping hand fan gives interior cards a <44px hit area at 320px width
     (edges fine); consider spreading the fan or a tap-to-front affordance.
  3. `--text-dim` over the brightest point of the felt gradient is ~4:1 (below
     WCAG AA 4.5 for small text); darken the dim token or the gradient center.
  4. ~~`rooms`/`sessions` SQLite rows are never pruned.~~ Fixed 2026-07-16:
     closed-session PII is removed immediately and old inactive rooms are pruned.
  5. ~~Mid-turn-disconnect grace extension isn't broadcast.~~ Fixed 2026-07-16:
     disconnects now send one full update carrying the authoritative deadline.
  6. Erlangen bluff half-ask (`askHalfMustHoldCard=false`, not in any default
     preset) can award marriage points for a marriage the side doesn't hold —
     revisit if/when an Erlangen preset ships.
  7. No E2E asserts the illisoft **default's** scoring specifics (last-trick 20,
     nearest-5 rounding, contract-less all-pass); add an illisoft-scoped spec.
  8. Minor dead code (`Db.setRoomHost` unused; client `actorOf` re-derives the
     server-sent acting seat as a fallback).

- 2026-07-11: **Recent-rooms list consolidated into the History screen.** The
  Home screen's "Recent rooms" panel (best-effort localStorage codes, no liveness)
  was removed; the History ("Pelihistoria") screen now leads with an **Open games**
  section — the device's remembered room codes filtered to the ones the server
  confirms are still live, each with status (lobby/in-progress), seat count, and a
  one-tap rejoin — above the existing finished-match list. Liveness is a real
  server answer via a new stateless `GET /api/rooms?codes=…` endpoint (outside the
  frozen WS protocol; the room-bound WS singleton can't do a multi-room query),
  which returns `{code,status,seatsFilled,seatsTotal}` for known-and-open codes
  only (unknown/invalid codes omitted, ≤20 per probe). Also fixed: the server now
  bundles a room's finished-match `history` into **every** welcome (was pushed only
  on match-finish mid-connection), so the History list is complete per room on a
  fresh device/reconnect. New client `api.ts`; `history.ts` recent-rooms helpers
  unchanged (now consumed by History, not Home). Tests: server integration
  `/api/rooms` case + client History open-games cases; `pnpm typecheck`/`lint`/
  `test` (431 unit) green.

- 2026-07-11: **Google Sign-In (optional) + chess.com-style Elo.** Players can
  now sign in with Google (the only login method) to earn a persistent rating;
  the guest "room link + nickname" flow is untouched, and login self-disables when
  no `GOOGLE_CLIENT_ID` is configured (guest-only — the local/e2e default). Auth
  uses the Google Identity Services **ID-token** flow (no callback route, cookies,
  CSRF, or client secret): the client gets a Google ID token, POSTs it to
  `/auth/google`, the server verifies it with `google-auth-library` (server-only
  dep; engine stays zero-dep), upserts a `users` row keyed on the Google `sub`,
  and issues its own **opaque app token** (only its sha256 hash stored, ~90-day
  expiry, revocable) which the client keeps in localStorage and sends on the WS
  `hello`. **Elo** is one unified pure module (`packages/server/src/elo.ts`)
  covering 2p (1v1), 4p (2v2 pairs, both members get the full side delta) and 3p
  (free-for-all ranked by score) via pairwise Elo with K scaled by `1/(n−1)`; the
  official winner is **anchored** so a declarer-tiebreak win never costs rating.
  chess.com-like K schedule (40 provisional / 20 / 10), a capped gains-only
  win-streak bonus (≤ +10), rating floor 100, start 1000. A match is **rated only
  when every active seat is a distinct signed-in human** (no bots, no guests, no
  account twice) — AFK autoplay does NOT unrate (no loss-dodging). Ratings surface
  on a `/profile` screen, as a post-match Elo delta in the match-ended overlay, and
  next to names in the lobby (no leaderboard). Contract: additive optional fields
  only (`hello.auth`, `SeatInfo.rating`/`provisional`, `update.ratings`);
  `PROTOCOL_VERSION` intentionally NOT bumped so open PWA clients degrade to guest
  rather than being force-closed. New tables `users`/`auth_tokens`/`rating_events`
  + `sessions.user_id` (idempotent migrations). Tests: `elo.test.ts` (21),
  `auth-elo.test.ts` (HTTP endpoints + rated/unrated full matches), migration case;
  `pnpm typecheck`/`lint`/`test` green, 500-game sim clean, client+server build +
  deployment smoke test pass. Design: [`docs/AUTH-ELO.md`](AUTH-ELO.md).

- 2026-07-11: **Matchmaking mode (auto-join open matches; ranked / unranked).**
  A "Find a match" flow: pick a size (2/3/4), tap once, and the server auto-joins
  you into an open matchmade room for that bucket (or opens one) and **auto-starts
  it when full** — no codes, no seat-picking. Signed-in players choose **ranked**
  (Elo counts) or **unranked**; guests get unranked only; Home shows a live
  per-bucket "N waiting" count (polled `GET /api/matchmaking`, aggregate-only so no
  private room leaks). The waiting view shows progress + the players, a host
  **"Start with bots"** (`fillBotsAndStart` — fills empty seats + starts, makes it
  unranked), and Cancel. Server-driven over the existing room machinery: a
  `matchmakingOpen` bucket registry (`${players}:${r|u}` → code), an empty-room
  helper (creation was welded to "creator at seat 0"), `seatSession`/`addBotToSeat`
  factored out, `startNewMatch(origin?)` made origin-optional for server-initiated
  auto-start, and a quick reaper that closes an emptied waiting room at once
  (no 15-min hold). **Critical rating fix:** Elo was *inferred* from seat
  composition, so an all-signed-in **unranked** game would have wrongly counted —
  `planMatchRating` now force-unrates a room with `matchmaking.ranked === false`
  (private code-rooms unchanged). Contract: additive/optional `hello.matchmaking`,
  `lobbyCmd.fillBotsAndStart`, `RoomStatePublic.matchmaking`; no `PROTOCOL_VERSION`
  bump. New `ServerOpts.matchmakingConfig` tunes the matchmade ruleset (tests use a
  low `winTarget`). Tests: `matchmaking.test.ts` (find-or-create, auto-start,
  ranked→rated, all-signed-in-unranked→unrated, fillBotsAndStart, ranked-needs-
  login, waiting counts, reaper); `pnpm typecheck`/`lint`/`test` green (484 unit),
  500-game sim clean, client+server build; auto-start verified in two live browsers.

## Achievements + titles (engagement)

- **New `@hp/achievements` package** (pure, zero-I/O, depends only on `@hp/engine`
  helpers): the catalogue of ~33 achievements as metadata + pure predicates over an
  `AchievementContext`, plus rating-derived titles (`titleForRating`) and prestige
  titles (`earnedTitles`/`effectiveTitleId`). One source of truth shared by the
  server (live eval + backfill) and client (rendering). 19 package tests.
- **Server**: new tables `user_achievements` (idempotent `INSERT OR IGNORE`),
  `match_participants` (durable user↔match link so **casual/bot games also count**),
  `meta` (backfill marker); `users.selected_title` column. `evaluateMatchAchievements`
  runs inside the match-end txn (all match types) after finishMatch+ratings;
  `backfillAchievements` one-time sweep of rated history (seat feats skipped,
  `events:null`), guarded by a meta marker + `pnpm --filter @hp/server backfill`.
  REST: `/api/profile` extended with `{achievements,title}`, new `POST /api/profile/title`,
  export includes achievements, GDPR erase clears both new tables. **No WS/protocol
  change** (frozen contract untouched). 7 server tests.
- **Client**: `AchievementsPanel` + `TitleSelector` on the profile, rating-derived
  `TitleBadge` next to names in the lobby, match-end "unlocked!" toasts (REST-diff),
  `titles`/`achievements` i18n namespaces (fi+en). i18n completeness test extended
  for the dynamic key families.
- Decisions (with user): casual+bots count · a few "häpeäpaita" badges · titles
  visible at table+profile · backfill on. Engine untouched → 500-game sim clean.
  Verified: 543 unit tests green, lint clean, client+server build, legacy-DB migration
  + boot backfill + route smoke.

## Table motion rework (feel)

- **`docs/MOTION.md`** — audit of the old, ad-hoc animation set (12 defects,
  measured by playing the offline learn scenarios at an iPhone-14 viewport) plus
  the motion language that replaced it. Read it before touching anything that
  moves on the table.
- **Motion tokens** (`tokens.css`): five durations, four curves, one stagger unit.
  Every table animation now picks from that set instead of the previous spread of
  a dozen arbitrary timings and five easings.
- **The hand is a real fan**, laid out with transforms instead of negative margins
  (`base.css`). That is the enabling change: playing a card now makes the
  neighbours glide into the gap, the raised card straightens out of the arc as it
  lifts, its neighbours part around it, and a fresh hand deals in card by card.
  Opponent hands use the same geometry, so their fans close up instead of the
  count silently ticking 9 → 6.
- **Your own speech bubble is attached to you again**: a `felt-foot` rail at the
  bottom of the felt holds your bubble, your reaction and (formerly) the
  countdown, so nothing floats unanchored mid-felt. Bubbles spring out of their
  speaker's tail and fade out before unmounting instead of popping.
- **The trick resolves in five beats** (land → hold → winner lift → gather → fly
  to the winner) and its offsets are a fraction of the trick box, so the stack can
  no longer glide off the felt and under the hand. The label moved above the cards.
  New per-seat **trick piles** give the felt something that accumulates.
- **New moments**: a felt-wide declaration flash when trump is set, scores that
  count up on staggered rows behind a blurred backdrop, a confetti *cannon*, and a
  läpäri shockwave. Turn arrival gets its own one-shot sweep, distinct from the
  waiting heartbeat, and the countdown drains as a bar along the hand's top edge.
- **Perf**: the three infinite turn-pulses no longer animate `background`/
  `box-shadow` (continuous repaint on up to three surfaces); each is now a static
  glow whose `opacity` animates.
- Every addition has a `prefers-reduced-motion` branch that keeps the information
  and drops the travel. Engine untouched. Verified: `pnpm typecheck`/`lint`/`test`
  green, e2e green.

## Backlog (post-MVP)

- Erlangen variant preset (rules doc §9).
