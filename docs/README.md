# Docs index

Everything written for people (and AI agents) working on Huutopussi Online.
Start with the one row that matches your task.

## For making changes (start here)

| Doc | Use it when you… |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | …land in the repo cold. The canonical, tool-neutral agent guide: golden rules, repo map, commands, doc index. **Read first.** |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | …need the system map + the journey of one action + file-by-file responsibilities. |
| [`TASK-RECIPES.md`](TASK-RECIPES.md) | …have a specific change to make (add a rule, an i18n string, a bot behavior, a screen…). Ordered checklists with exact files. |
| [`GLOSSARY.md`](GLOSSARY.md) | …hit a Finnish/domain term (*Porvoo, koini, läpäri, marriage, päämuoto*) and want the code symbol. |
| [`TESTING.md`](TESTING.md) | …add/run tests, reproduce a fuzz failure, or want the invariant list. |
| [`AUTH-ELO.md`](AUTH-ELO.md) | …work on Google Sign-In or the Elo rating system (auth flow, rating math, data model, deploy). |

## Source-of-truth references

| Doc | What it is |
| --- | --- |
| [`huutopussin-saannot.md`](huutopussin-saannot.md) | **Authoritative rules** + all documented variations. Rules disputes are settled here. |
| [`illisoft-saannot-spec.md`](illisoft-saannot-spec.md) | Spec for the illisoft 2002 ruleset (the lobby default preset, `ILLISOFT_RULES`). |
| [`plan.md`](plan.md) | The approved implementation plan: architecture, protocol, phases, decisions, risks. |
| [`PROGRESS.md`](PROGRESS.md) | Build progress log + post-MVP backlog. Update on milestones. |
| [`lahteet/`](lahteet/) | Primary sources (original illisoft help text, Matrix ry rules PDF). |

> Note: `plan.md`'s "event+gap resync" section is superseded by the
> **snapshot-per-change** sync model actually built — see `ARCHITECTURE.md` §2
> and the `protocol/src/index.ts` header. `plan.md` is otherwise current.

## The self-documenting contract

The engine's public API isn't duplicated in prose because the source *is* the
spec — read it directly:

- [`../packages/engine/src/types.ts`](../packages/engine/src/types.ts) — all state/event/action/view types.
- [`../packages/engine/src/config.ts`](../packages/engine/src/config.ts) — `RuleConfig` (every variation) + the pinned rulings.
- [`../packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) — the WebSocket wire contract.

## Keeping docs healthy

These docs are navigational, not a second copy of the code. When you change
behavior, update the doc that *describes* it (usually a `config.ts` comment,
`TASK-RECIPES.md`, or `PROGRESS.md`) in the same change — a wrong doc costs an
agent more than a missing one.
