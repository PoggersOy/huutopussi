# Build progress

Plan: `docs/plan.md`. Rules: `docs/huutopussin-saannot.md`.

| Phase | Status | Verified by |
|---|---|---|
| P0 Scaffolding | in progress | — |
| P1 Engine: deal/bid/exchange/scoring | pending | — |
| P2 Engine: tricks/declarations/fuzz | pending | — |
| P3 Server | pending | — |
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
  huutopussi.com domain are the new deployment targets. 50k fuzz gate running.

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
