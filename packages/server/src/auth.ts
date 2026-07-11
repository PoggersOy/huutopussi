/**
 * auth.ts — Google Sign-In helpers and app-token crypto.
 *
 * The client uses Google Identity Services to obtain a Google ID token (a
 * short-lived JWT) and POSTs it to /auth/google. We verify it here, then mint
 * our OWN opaque, long-lived app token. Only the sha256 hash of that app token
 * is ever stored (a db leak yields no usable tokens); revocation is a row
 * delete. This decouples the app session from Google's ~1h ID-token expiry.
 *
 * The engine stays zero-dependency; google-auth-library is a server-only dep.
 */
import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

/** App tokens live ~90 days, then the client must sign in again. */
export const AUTH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The verified identity we take from a Google ID token. */
export interface GoogleIdentity {
  /** Google's stable subject id — the account key (never trust email as key). */
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity | null>;

/** Mint a fresh opaque app token (URL-safe, 256 bits of entropy). */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex of a raw token — only this hash is ever persisted. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Build a Google ID-token verifier bound to our client id, or null when no
 * client id is configured (login disabled → guest-only). The returned function
 * validates the signature (JWKS, handled by the library), the audience, the
 * issuer, expiry, and that the email is verified; it resolves to null on any
 * failure so callers can treat "invalid" uniformly.
 */
export function createGoogleVerifier(clientId: string | null | undefined): GoogleVerifier | null {
  if (!clientId) return null;
  const client = new OAuth2Client(clientId);
  return async (credential: string): Promise<GoogleIdentity | null> => {
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload || !payload.sub) return null;
      // Reject explicitly-unverified emails; absent flag (no email scope) is ok.
      if (payload.email_verified === false) return null;
      return {
        sub: payload.sub,
        email: payload.email ?? null,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
      };
    } catch {
      return null;
    }
  };
}
