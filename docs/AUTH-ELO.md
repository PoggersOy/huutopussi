# Google login + Elo rating

Optional Google-only sign-in and a chess.com-style Elo ladder. Guests keep the
"room link + nickname" flow untouched; only signed-in players earn a rating.
When no `GOOGLE_CLIENT_ID` is set, login self-disables and the app is guest-only
(the local-dev and e2e default).

## Auth flow (Google Identity Services ID-token)

Chosen over the OAuth redirect/auth-code flow because this is a same-origin SPA
whose identity rides on the WebSocket — the ID-token flow needs no callback
route, cookies, CSRF token, client secret, or PWA/service-worker redirect
handling.

1. Client loads GIS (`packages/client/src/auth.ts`), fetches the public client id
   from `GET /api/auth-config`, and renders the Sign-In button.
2. The GIS callback yields a Google **ID token** (JWT, ~1h). Client POSTs it to
   `POST /auth/google`.
3. Server (`packages/server/src/auth.ts`) verifies it with `google-auth-library`
   (`OAuth2Client.verifyIdToken`, checking `aud`/`iss`/`exp`/`email_verified`),
   upserts a `users` row keyed on the Google **`sub`** (never email), and mints an
   opaque app token (`crypto.randomBytes(32)`). Only its **sha256 hash** is stored
   (`auth_tokens`, ~90-day expiry); revocation is a row delete.
4. Client stores the app token in **localStorage** (`hp:auth`) — persistent across
   tab close, deliberately separate from the per-tab room token in sessionStorage.
5. The WS `hello` carries the app token as `auth`; the server resolves it to a
   `userId`, binds it to the `Session`, and defaults the nickname to the Google
   name. A stale/invalid token silently degrades to guest — it never rejects a
   join. Restore-on-boot uses `GET /auth/me`; `POST /auth/logout` revokes.

**Endpoints** (raw `node:http` in `server.ts`, dispatched before the non-GET 405
guard): `GET /api/auth-config`, `POST /auth/google`, `GET /auth/me`,
`POST /auth/logout`, `GET /api/profile`. A small per-IP token bucket rate-limits
them; bodies are size-capped at 16 KB.

## Elo model (`packages/server/src/elo.ts`, pure + unit-tested)

One algorithm for all three modes via `sideCount` (2p→2, 4p→2 team sides, 3p→3):

- **Pairwise Elo between sides**, K scaled by `1/(n−1)` so every mode spends one
  game's K-budget. A **side rating** is the mean of its members' ratings; K is
  per-member. Reduces to textbook Elo for 2 sides.
- **The official winner is anchored** (sort key = +∞) so it beats every side;
  non-winning sides are ranked among themselves by final score. This is essential:
  the engine's `winTiebreak:'declarer'` can crown a lower-scoring side, and pure
  score-ranking would wrongly charge the winner a rating loss.
- **4p**: both team members get the full side delta (keeps one rating scale; still
  zero-sum).
- **Win-streak bonus**: gains-only, winner-only, `min(streak, 5)·2` (≤ +10).
- Constants: start 1000, provisional < 30 games (K=40), else K=20 (K=10 ≥ 2100),
  rating floor 100.

**Rated eligibility** (evaluated at match end, `planMatchRating` in `server.ts`):
every active seat is a `kind==='human'` session with a non-null `userId`, and all
userIds are **distinct** (guards the one-browser-two-seats case). Bots or guests
present → unrated; AFK autoplay (`botControlled`) does **not** unrate. Ratings are
persisted in the same transaction as `finishMatch`.

## Data model

New tables (`packages/server/src/db.ts`, idempotent migrations):

- `users` — `google_sub` (unique), profile fields, `rating`, `games_played`,
  `wins`/`losses`, `win_streak`, `best_streak`.
- `auth_tokens` — `token_hash` (PK), `user_id`, `expires_at`.
- `rating_events` — per-match `(match_id, user_id)` delta (profile + reconnect).
- `sessions.user_id` — links a live session to an account (null = guest).

## Wire contract (frozen — additive only, no version bump)

`packages/protocol/src/index.ts`: optional `hello.auth` (client→server, zod),
optional `SeatInfo.rating`/`provisional` and `update.ratings: MatchRatingResult`
(server→client, types-only). `PROTOCOL_VERSION` is intentionally **not** bumped —
the strict-equality check force-closes mismatched clients, so a bump would evict
every open PWA client; instead old clients simply omit `auth` and stay guests.

## Deploying login

1. Create a Google Cloud **OAuth 2.0 Web client**; set the authorized JavaScript
   origin to your site (e.g. `https://huutopussi.online`).
2. Set `GOOGLE_CLIENT_ID` (public value — `fly.toml [env]` or `fly secrets set`).
   Unset ⇒ guest-only.

## Surfaces (client)

- `screens/Profile.tsx` (`/profile`) — rating, W/L, streaks, recent deltas.
- `MatchEndedOverlay` — the viewer's Elo delta (or an "unrated" note).
- Lobby seat cards + the Home account chip — `components/RatingBadge.tsx`.
