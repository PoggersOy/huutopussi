# Huutopussi Online

Online multiplayer version of the Finnish card game **Huutopussi**, built for
mobile browsers — no app install, just a room link. Play **2, 3, or 4 players**
(the 4-player game is the 2v2 partnership form) with selectable rulesets
(illisoft 2002 and the *päämuoto* main variant). TypeScript monorepo: a pure
event-sourced game engine, an authoritative WebSocket server, and a mobile-first
React PWA client, with AI bots, optional **Google sign-in with Elo ratings and
matchmaking**, fi/en i18n, reconnection handling, and persistent score history.

Rules source of truth: [`docs/huutopussin-saannot.md`](docs/huutopussin-saannot.md).
Architecture and plan: [`docs/plan.md`](docs/plan.md).

## Working on the code (humans & AI agents)

This repo is set up for cost-effective AI-assisted development. Start with
**[`AGENTS.md`](AGENTS.md)** — the tool-neutral guide (golden rules, repo map,
commands) read by Claude Code, Cursor, Copilot, Codex, and others. Then open the
one deep doc your task needs:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system map + the journey of one action + file-by-file responsibilities.
- [`docs/TASK-RECIPES.md`](docs/TASK-RECIPES.md) — ordered checklists for common changes.
- [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — Finnish/domain terms → code symbols.
- [`docs/TESTING.md`](docs/TESTING.md) — test taxonomy + fuzz invariants.
- [`docs/README.md`](docs/README.md) — the full doc index.

## Repository layout

| Package | What it is |
| --- | --- |
| `packages/engine` | Pure TS, zero-dependency, deterministic event-sourced rules engine |
| `packages/protocol` | zod schemas for the WebSocket wire contract |
| `packages/bots` | Bot actors + simulation/fuzz CLI |
| `packages/server` | Node `ws` server: rooms, sessions, timers, SQLite persistence |
| `packages/client` | React + Vite + PWA mobile client |

## Development quickstart

Prerequisites: Node 24, pnpm 10 (`corepack enable` picks the pinned version
from `package.json#packageManager`).

```sh
pnpm install

# Dev servers (two terminals):
pnpm --filter @hp/server dev    # WS + API server
pnpm --filter @hp/client dev    # Vite dev server (proxies WS to the server)
```

## Tests, checks, simulation

```sh
pnpm typecheck                    # tsc across all packages
pnpm lint                         # Biome check (pnpm lint:fix to autofix)
pnpm test                         # vitest across all packages
pnpm sim -- --games 500 --seed 42 # seeded engine fuzz harness
pnpm build:server                 # esbuild bundle -> packages/server/dist/server.js
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test + a 500-game
seeded simulation on every push and PR.

## Playing

**Quick match (matchmaking).** On the home screen tap **Find a match** and pick
a size (2/3/4 players): the server drops you into an open game for that bucket
(or opens one) and auto-starts it the moment it fills — no codes to share.
Signed-in players can choose **ranked** (Elo counts); guests play unranked.

**Private room (the room-link flow).**

1. Enter a nickname — no account needed. A per-tab session token (in
   `sessionStorage`) identifies you, so a reload or phone-wake reclaims your
   seat. Optionally **sign in with Google** to earn an Elo rating.
2. Create a room; you get a 5-character code and a shareable link
   (`https://huutopussi.online/r/CODE`). In the lobby the host picks the ruleset,
   player count, and other options.
3. Send the link to friends; anyone opening it joins the room lobby. Fill empty
   seats with bots if you are fewer than the table size.
4. The host starts the match. If someone drops (phone locked, tunnel, …) the
   game never stalls: after a grace period a bot plays their seat until they
   reopen the link and reclaim it.

## Deployment (Fly.io)

The app deploys as a single Docker image (see `Dockerfile`): the Node server
serves the built client and speaks WebSocket on the same origin. SQLite lives
on a Fly volume, so keep it at **exactly one machine** (`fly.toml` pins
`min_machines_running = 1`, `auto_stop_machines = false`; do not scale out).

### First-time setup

```sh
# 1. Authenticate
fly auth login

# 2. Create the app (fly.toml already exists — do not overwrite it)
fly apps create huutopussi

# 3. Create the volume for SQLite in the primary region (Stockholm)
fly volumes create hp_data --region arn --size 1

# 4. (Optional) Enable Google Sign-In + Elo. The OAuth 2.0 Web client ID is
#    PUBLIC, so it lives in fly.toml [env] as GOOGLE_CLIENT_ID (not a secret) —
#    it is already set for huutopussi.online; leave it unset to run guest-only.
#    The authorized JavaScript origin in Google Cloud must be your HTTPS site URL.

# 5. First deploy
fly deploy --remote-only
```

### Continuous deploys from GitHub

`.github/workflows/deploy.yml` deploys automatically after CI succeeds on
`main`. It skips (rather than fails) until you configure the token:

```sh
# Create a deploy token scoped to the app
fly tokens create deploy --app huutopussi

# Add it to the GitHub repo: Settings → Secrets and variables → Actions →
# New repository secret, name: FLY_API_TOKEN, value: the token (FlyV1 …)
```

### Custom domain: huutopussi.online

Point the domain straight at Fly (DNS-only, no proxy) so Fly can issue and
renew a Let's Encrypt cert over HTTP-01. The IPs below are **examples** — read
your app's real ones from `fly ips list`.

```sh
# 1. Get the app's public IPs (allocate a dedicated IPv4 if you want one)
fly ips list --app huutopussi
#   v4  66.241.xxx.xxx   (shared)
#   v6  2a09:8280:...    (dedicated)

# 2. Register the hostnames with Fly (this prints the exact DNS records to add)
fly certs add huutopussi.online --app huutopussi
fly certs add www.huutopussi.online --app huutopussi

# 3. At your DNS registrar for the zone huutopussi.online, add (DNS-only, NOT proxied):
#      A     huutopussi.online      -> <v4 from step 1>
#      AAAA  huutopussi.online      -> <v6 from step 1>
#      CNAME www.huutopussi.online  -> huutopussi.online
#    (fly certs add in step 2 may instead ask for an _acme-challenge CNAME —
#     use whatever that command prints; it is authoritative.)

# 4. Watch until issued, then verify HTTPS + health through the domain
fly certs check huutopussi.online --app huutopussi     # Status = Issued (a few min)
curl -sI https://huutopussi.online/healthz             # HTTP/2 200

# 5. Share https://huutopussi.online — create a room, send friends the /r/CODE link.
```

If you front the domain with Cloudflare, set the records **DNS-only** (grey
cloud) for `fly certs` HTTP-01 to succeed; if you proxy them (orange cloud),
switch SSL/TLS mode to **Full (strict)** — the server sets `force_https`, so
"Flexible"/"Off" causes a redirect loop.

### Operations notes

- Health check: `GET /healthz` (used by Fly and the deploy pipeline).
- Database: `DB_PATH=/data/hp.db` on the `hp_data` volume. In-flight matches
  survive deploys/crashes: events are persisted per action and replayed on
  boot, and clients resync on reconnect.
- Google Sign-In: `GOOGLE_CLIENT_ID` (a public OAuth Web client ID) in
  `fly.toml [env]` enables login + Elo ratings; unset ⇒ guest-only. The client
  reads it at runtime from `GET /api/auth-config`.
- Logs / console: `fly logs`, `fly ssh console --app huutopussi`.
