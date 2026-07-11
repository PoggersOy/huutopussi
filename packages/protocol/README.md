# @hp/protocol

The **WebSocket wire contract** between server and clients: zod schemas for
untrusted inbound messages + typed `ServerMsg` for trusted outbound ones.

**Frozen contract** (`src/index.ts`) — don't change shapes without an explicit
instruction; server and client are built against it. It carries **compile-time
drift guards** that fail `pnpm typecheck` if the schemas diverge from the engine's
`PlayerAction` / `RuleConfig`.

Key points:
- Client→server messages are **untrusted** → parsed with `clientMsgSchema`.
- Server→client messages are **trusted** (types only, no runtime validation).
- Sync model = **snapshot-per-change**: the server sends a full redacted
  `PlayerView` on every change; the client replaces state wholesale.
- `TurnInfo.hints` reveal hand structure → included **only** in messages to the
  acting seat.

- Add/change a message → [`../../docs/TASK-RECIPES.md`](../../docs/TASK-RECIPES.md) Recipe C
- System map → [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- Golden rules → [`../../AGENTS.md`](../../AGENTS.md)
