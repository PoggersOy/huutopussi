/**
 * auth.ts — Google Sign-In (client side).
 *
 * Uses Google Identity Services (GIS) to obtain a Google ID token in-page, then
 * exchanges it at POST /auth/google for our own opaque app token. That app token
 * lives in localStorage (`hp:auth`) — persistent across tab close, and kept
 * deliberately SEPARATE from the per-tab room session token in sessionStorage.
 * The WS layer reads it via `getAuthToken()` and sends it on `hello`.
 *
 * Login is entirely optional: if the server reports no client id
 * (`/api/auth-config` → { googleClientId: null }) the whole flow self-disables
 * and the app runs guest-only.
 *
 * Privacy: the Google GIS script is loaded LAZILY (warmGoogleSignIn), only when
 * a visitor shows intent to sign in — so no Google script or cookie touches
 * anyone who never signs in, and the app sets no cookies of its own at all.
 */
import { type AuthUser, authApply } from './store';

const AUTH_KEY = 'hp:auth';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

// ── Minimal Google Identity Services typings (only what we call) ─────────────

interface GoogleCredentialResponse {
  credential: string;
}
interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

let clientId: string | null = null;
let gisReady = false;
let gisLoading: Promise<boolean> | null = null;
let gisInitialized = false;

// ── App-token storage (localStorage) ─────────────────────────────────────────

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_KEY);
  } catch {
    return null;
  }
}
function storeAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_KEY, token);
  } catch {
    // Private mode etc. — sign-in survives only for this page load.
  }
}
function clearStoredToken(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Restore any existing session and learn whether login is enabled. Safe to call
 * once at app start; resolves when auth state settles. Deliberately does NOT
 * load Google Identity Services — that happens lazily on the first sign-in
 * intent (warmGoogleSignIn), so a visitor who never signs in is never touched
 * by Google's script or cookies.
 */
export async function initAuth(): Promise<void> {
  // 1. Restore a stored session first (works regardless of the client id).
  const token = getAuthToken();
  if (token) await refreshMe(token);

  // 2. Learn whether login is enabled at all.
  try {
    const res = await fetch('/api/auth-config');
    if (res.ok) {
      const body = (await res.json()) as { googleClientId: string | null };
      clientId = body.googleClientId;
    }
  } catch {
    clientId = null;
  }
  authApply.setClientId(clientId);
}

/**
 * Lazily load + initialise Google Identity Services. Called the moment a
 * visitor signals they want to sign in (hover/focus/press on the sign-in
 * control) — never at boot — so Google is contacted only for people who choose
 * to. Idempotent and safe to call repeatedly; no-op when login is disabled.
 * `auto_select: false` keeps us off One Tap (no silent prompt / auto sign-in).
 */
export async function warmGoogleSignIn(): Promise<void> {
  if (!clientId) return;
  if (!gisReady) {
    const ok = await loadGis();
    if (!ok) return;
  }
  if (window.google && !gisInitialized) {
    window.google.accounts.id.initialize({
      client_id: clientId,
      auto_select: false,
      callback: (resp) => {
        void onGoogleCredential(resp.credential);
      },
    });
    gisInitialized = true;
    authApply.setLoginReady();
  }
}

function loadGis(): Promise<boolean> {
  if (gisReady) return Promise.resolve(true);
  if (gisLoading) return gisLoading;
  gisLoading = new Promise<boolean>((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      gisReady = true;
      resolve(true);
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return gisLoading;
}

// ── Sign-in / restore / sign-out ─────────────────────────────────────────────

async function onGoogleCredential(credential: string): Promise<void> {
  authApply.setStatus('authing');
  try {
    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) {
      authApply.setStatus('anon');
      return;
    }
    const body = (await res.json()) as { token: string; user: AuthUser };
    storeAuthToken(body.token);
    authApply.setUser(body.user);
  } catch {
    authApply.setStatus('anon');
  }
}

/** Validate a stored token against the server; clears it if rejected. */
async function refreshMe(token: string): Promise<void> {
  try {
    const res = await fetch('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body = (await res.json()) as { user: AuthUser };
      authApply.setUser(body.user);
      return;
    }
  } catch {
    // network error — keep the token, try again next boot
    return;
  }
  // 401/anything else: the token is dead.
  clearStoredToken();
  authApply.setUser(null);
}

/**
 * Render the Google Sign-In button into `parent`. We ask GIS for a compact
 * circular icon button, but the caller overlays it at opacity 0 on top of our
 * own app-styled disc — so this rendered button is only the (invisible) click
 * surface that keeps us on Google's real credential flow. No-op when login is
 * disabled or GIS hasn't loaded yet (the caller re-invokes on state changes).
 */
export function renderGoogleButton(parent: HTMLElement): void {
  if (!clientId || !gisReady || !window.google) return;
  parent.replaceChildren();
  window.google.accounts.id.renderButton(parent, {
    type: 'icon',
    shape: 'circle',
    theme: 'outline',
    size: 'large',
  });
}

/** Sign out: revoke the token server-side, forget it locally, reset GIS. */
export function signOut(): void {
  const token = getAuthToken();
  if (token) {
    void fetch('/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {
      // best-effort; the token is cleared locally regardless
    });
  }
  clearStoredToken();
  window.google?.accounts.id.disableAutoSelect();
  authApply.setUser(null);
}

/**
 * Permanently delete the signed-in account (GDPR art. 17). On success the
 * server has already erased everything it holds and revoked every token, so we
 * forget the local token and drop to the anonymous state. Returns whether the
 * deletion succeeded; false leaves the session untouched so the UI can retry.
 */
export async function deleteAccount(): Promise<boolean> {
  const token = getAuthToken();
  if (!token) return false;
  let ok = false;
  try {
    const res = await fetch('/auth/account', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    ok = res.ok; // 204 on success
  } catch {
    ok = false;
  }
  if (ok) {
    clearStoredToken();
    window.google?.accounts.id.disableAutoSelect();
    authApply.setUser(null);
  }
  return ok;
}
