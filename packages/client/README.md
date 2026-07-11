# @hp/client

The **mobile-first React PWA client** (Vite + zustand + i18next +
vite-plugin-pwa). Portrait layout (~390×844).

**The binding rules:**
- **UI legality comes only from server-sent `ActionHint`s** — never recompute
  what's legal locally.
- **No optimistic game mutations** — show a pending state until the confirming
  `update` arrives. The `server` store slice is written only by the socket layer
  and replaces snapshots wholesale.
- **All strings are i18n keys** (`i18n/{fi,en}.json`, Finnish fallback); server
  `error.*`/`event.*` codes are keys too.

Layout of the code:
- Network/state: `socket.ts` (typed WS: backoff reconnect, per-room session
  tokens, uuid actionIds, wake-resync), `store.ts` (`server` + `ui` slices).
- Screens: `screens/{Home,Lobby,Table,History}.tsx`; Table internals in
  `screens/table/`.
- PWA: `pwa.ts` (registerType `prompt` — never a silent mid-game reload).

```sh
pnpm --filter @hp/client dev
pnpm --filter @hp/client build
pnpm --filter @hp/client test
```

- Change a screen/sheet → [`../../docs/TASK-RECIPES.md`](../../docs/TASK-RECIPES.md) Recipe F
- Add an i18n string → [`../../docs/TASK-RECIPES.md`](../../docs/TASK-RECIPES.md) Recipe D
- System map → [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
