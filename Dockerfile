# syntax=docker/dockerfile:1
#
# Huutopussi Online — single-image deploy (server serves the built client).
#
# ── Chosen build strategy (and why) ──────────────────────────────────────────
# The server is bundled to ONE file (dist/server.js) with esbuild, with the
# native module better-sqlite3 kept EXTERNAL, and the runtime node_modules is
# produced with `pnpm deploy --filter @hp/server --prod --legacy`.
#
# Why not a plain `tsc` build of @hp/server? The workspace packages
# (@hp/engine, @hp/protocol, @hp/bots) intentionally ship TypeScript sources
# (`"main": "./src/index.ts"`). Compiled server JS would `import '@hp/engine'`
# and Node would resolve to a .ts file inside node_modules — Node's type
# stripping explicitly refuses files under node_modules, so it cannot run.
# Bundling with esbuild inlines all workspace TS (plus ws/zod) into a single
# JS file, sidestepping that entirely.
#
# Why keep better-sqlite3 external + `pnpm deploy` for runtime deps? It is a
# native addon: it must NOT be bundled, and its binary must be the one
# installed/built for linux inside this image (never copied from the host —
# .dockerignore excludes node_modules). `pnpm deploy --prod` gives a flat,
# lockfile-faithful production node_modules for exactly @hp/server's dep
# subtree. Its build script is allow-listed via `onlyBuiltDependencies` in
# pnpm-workspace.yaml; build tools (python3/make/g++) are present in the build
# stage as a fallback for platforms without a prebuilt binary.
# (`--legacy` is required by pnpm 10 because this workspace does not use
# injected workspace packages.)
#
# NOTE for the integration phase: `esbuild` is declared as a root devDependency
# in package.json but `pnpm install` has NOT been run yet — run it once to
# update pnpm-lock.yaml, or the deps stage below will fail on --frozen-lockfile.
#
# Runtime contract the server implements (see fly.toml):
#   PORT=8080          HTTP+WS listen port
#   DB_PATH=/data/hp.db  SQLite database file (Fly volume mounted at /data)
#   CLIENT_DIST=/app/public  static client build served at /
#   GET /healthz       liveness endpoint (200 when ready)

# ── base: node + pnpm (via corepack, pinned by package.json#packageManager) ──
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# No TTY in docker build: make pnpm non-interactive (it otherwise aborts when
# it wants to recreate the modules dir created by `pnpm fetch`).
ENV CI=true
RUN corepack enable
WORKDIR /repo

# ── deps: lockfile-cached package store (only invalidated by lockfile edits) ─
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm fetch populates the store from the lockfile alone — maximal cache reuse.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# ── build: install offline, build client, bundle server, prune prod deps ─────
FROM deps AS build
# Toolchain fallback for native builds (better-sqlite3) when no prebuilt
# binary matches; harmless bloat here, never reaches the runtime stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
# --prefer-offline (not --offline): `pnpm fetch` populates the store from the
# lockfile alone, but skips some root-level tooling tarballs (e.g. biome);
# prefer-offline reuses the cached store and downloads only what's missing.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install -r --frozen-lockfile --prefer-offline

# Client → packages/client/dist (vite)
RUN pnpm --filter @hp/client build

# Production node_modules for @hp/server only (contains the linux-built
# better-sqlite3; everything else in it is redundant-but-tiny since the
# bundle inlines the JS deps). Must run before esbuild writes into /out:
# pnpm deploy insists on an empty target directory.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --filter @hp/server --prod --legacy /out

# Server → single self-contained ESM file; workspace TS + ws + zod inlined,
# native better-sqlite3 left external. The createRequire banner lets any
# CJS-interop `require` calls inside bundled deps work under ESM.
RUN pnpm exec esbuild packages/server/src/index.ts \
      --bundle \
      --platform=node \
      --format=esm \
      --target=node24 \
      --external:better-sqlite3 \
      --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
      --outfile=/out/dist/server.js

# ── runtime: minimal image, no toolchain, no pnpm ────────────────────────────
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/hp.db
ENV CLIENT_DIST=/app/public
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /repo/packages/client/dist ./public

VOLUME /data
EXPOSE 8080
CMD ["node", "dist/server.js"]
