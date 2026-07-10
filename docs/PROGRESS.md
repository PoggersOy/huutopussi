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
