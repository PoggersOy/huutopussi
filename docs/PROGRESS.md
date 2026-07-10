# Build progress

Plan: `docs/plan.md`. Rules: `docs/huutopussin-saannot.md`.

| Phase | Status | Verified by |
|---|---|---|
| P0 Scaffolding | in progress | — |
| P1 Engine: deal/bid/exchange/scoring | pending | — |
| P2 Engine: tricks/declarations/fuzz | pending | — |
| P3 Server | done | integration+chaos+hidden-info+persistence tests (9) green |
| P4 Client MVP | pending | — |
| P5 Reconnect + PWA + i18n | pending | — |
| P6 Persistence + deploy | pending | — |
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
