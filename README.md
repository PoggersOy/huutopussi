# Huutopussi Online

Online multiplayer version of the Finnish card game **Huutopussi** (4-player
partnership form, 2v2), built for mobile browsers — no app install, just a
room link. TypeScript monorepo: a pure event-sourced game engine, an
authoritative WebSocket server, and a mobile-first React PWA client, with AI
bots, fi/en i18n, reconnection handling, and persistent score history.

Rules source of truth: [`docs/huutopussin-saannot.md`](docs/huutopussin-saannot.md).
Architecture and plan: [`docs/plan.md`](docs/plan.md).

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

## Playing: the room-link flow

1. Open the deployed site and enter a nickname (no account needed — a session
   token in localStorage identifies you).
2. Create a room; you get a 5-character code and a shareable link
   (`https://huutopussi.com/r/CODE`).
3. Send the link to friends; anyone opening it joins the room lobby. Fill
   empty seats with bots if you are fewer than four.
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

# 4. Set any runtime secrets (none required for MVP; example)
# fly secrets set SOME_KEY=value

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

### Custom domain: huutopussi.com

```sh
# 1. Get the app's public IPs
fly ips list --app huutopussi
# (allocate if missing: fly ips allocate-v4 --shared && fly ips allocate-v6)

# 2. At your DNS provider, add records for both apex and www:
#    A     huutopussi.com      -> <IPv4 from above>
#    AAAA  huutopussi.com      -> <IPv6 from above>
#    A     www.huutopussi.com  -> <IPv4>   (or CNAME www -> huutopussi.fly.dev)
#    AAAA  www.huutopussi.com  -> <IPv6>

# 3. Issue TLS certificates
fly certs add huutopussi.com
fly certs add www.huutopussi.com

# 4. Watch until issued (DNS propagation permitting)
fly certs show huutopussi.com
```

### Operations notes

- Health check: `GET /healthz` (used by Fly and the deploy pipeline).
- Database: `DB_PATH=/data/hp.db` on the `hp_data` volume. In-flight matches
  survive deploys/crashes: events are persisted per action and replayed on
  boot, and clients resync on reconnect.
- Logs / console: `fly logs`, `fly ssh console --app huutopussi`.
