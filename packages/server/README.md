# @hp/server

The **authoritative** game server: `ws` endpoint + static client host, rooms,
sessions, timers, bot runner, and SQLite persistence. Depends on `engine`,
`protocol`, `bots`.

`createServer(opts)` serves the built client (SPA fallback for `/r/*`),
`GET /healthz`, and the WebSocket game endpoint `/ws`. Per accepted action:
**zod-parse → idempotency LRU → `validateAction` → `applyEvent` (persisted in one
txn) → one redacted `update` per recipient.** `TurnInfo.hints` go **only** to the
acting seat (hard security requirement); only redacted `PlayerView`s ever leave
the server.

| File | Role |
| --- | --- |
| `server.ts` | protocol handling + HTTP/WS wiring |
| `rooms.ts` | room registry, codes, `RoomStatePublic`, live `MatchState` |
| `sessions.ts` | token-bound sessions, last-connect-wins, actionId LRU |
| `timers.ts` | turn deadlines, disconnect grace, autoplay, idle reaper |
| `botRunner.ts` | bot turn computation (same pipeline as WS actions) |
| `db.ts` | `better-sqlite3` (WAL); events persisted per action → crash recovery |

Turn pacing is a **table setting** (`TableSettings`), deliberately *not* a
`RuleConfig` field — the engine stays timer-free and deterministic.

```sh
pnpm --filter @hp/server dev
pnpm --filter @hp/server test
```

- Change server behavior → [`../../docs/TASK-RECIPES.md`](../../docs/TASK-RECIPES.md) Recipe G
- System map + action journey → [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
