/**
 * Compact header account control (top-right). Signed out (and login enabled):
 * the Google Sign-In icon button. Signed in: a small avatar + rating chip that
 * links to the profile (where Sign out lives). Renders nothing when login is
 * disabled (no client id) — the app stays fully playable as a guest.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { renderGoogleButton, warmGoogleSignIn } from '../auth';
import { useStore } from '../store';
import { RatingBadge } from './RatingBadge';

export function AuthPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useStore((s) => s.auth.user);
  const googleClientId = useStore((s) => s.auth.googleClientId);
  const loginReady = useStore((s) => s.auth.loginReady);
  const btnRef = useRef<HTMLDivElement>(null);
  const signinRef = useRef<HTMLDivElement>(null);

  // (Re)render the GIS button whenever it can be shown (login enabled, GIS
  // ready, and no user yet). loginReady flips true once GIS finishes loading.
  useEffect(() => {
    if (!user && googleClientId && loginReady && btnRef.current) {
      renderGoogleButton(btnRef.current);
    }
  }, [user, googleClientId, loginReady]);

  // Lazily warm up Google Identity Services on the first hover/press/focus of
  // the sign-in control, so Google (and any cookie it sets) is contacted only
  // once a visitor moves to sign in — never for people who never do. The
  // listeners are attached imperatively (not as JSX handlers on a static div)
  // because the real interactive element is the GIS button inside the overlay.
  useEffect(() => {
    const el = signinRef.current;
    if (!el || user || !googleClientId) return;
    const warm = (): void => {
      void warmGoogleSignIn();
    };
    el.addEventListener('pointerenter', warm);
    el.addEventListener('pointerdown', warm);
    el.addEventListener('focusin', warm);
    return () => {
      el.removeEventListener('pointerenter', warm);
      el.removeEventListener('pointerdown', warm);
      el.removeEventListener('focusin', warm);
    };
  }, [user, googleClientId]);

  if (user) {
    // Layout: the ELO field on the left, then the user's avatar "ball" on the
    // far right edge. The whole row links to the profile. A crown glyph stands
    // in for the "ELO" label so the whole cluster stays on one header line.
    return (
      <button
        type="button"
        className="auth-header__chip"
        onClick={() => navigate('/profile')}
        aria-label={user.name ?? t('auth.signedIn')}
        title={t('auth.profile')}
      >
        <RatingBadge rating={user.rating} provisional={user.provisional} icon={<CrownIcon />} />
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            className="auth-header__avatar"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="auth-header__avatar auth-header__avatar--fallback" aria-hidden="true">
            {(user.name ?? '?').charAt(0).toUpperCase()}
          </span>
        )}
      </button>
    );
  }

  if (googleClientId) {
    // A custom, app-styled circular button (dark felt disc + gold ring + the
    // Google "G"). The *real* GIS icon button is rendered into the overlay slot
    // on top of it at opacity 0, so the actual sign-in click still runs through
    // Google Identity Services — we get our look without touching the flow.
    //
    // GIS is loaded LAZILY (see the warm-up effect above): on a warm hover the
    // overlay is ready for the click; on a cold first tap it arms and the
    // visitor taps once more.
    return (
      <div ref={signinRef} className="auth-header__signin" title={t('auth.signInPrompt')}>
        <span className="auth-header__signin-face" aria-hidden="true">
          <GoogleG />
        </span>
        <div ref={btnRef} className="auth-header__gis" aria-hidden="true" />
      </div>
    );
  }

  return null; // login disabled → guest-only
}

/** A compact gold crown that prefixes the ELO value (inherits `currentColor`). */
function CrownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" role="img" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2.5 8.2a1.25 1.25 0 1 0-1.2-1.6L3.2 17.2A1 1 0 0 0 4.18 18h15.64a1 1 0 0 0 .98-.8L22.7 6.6a1.25 1.25 0 1 0-1.2 1.6l-4.03 2.9-3.5-5.2a1.2 1.2 0 0 0-1.94 0l-3.5 5.2L2.5 8.2z"
      />
      <rect x="4.6" y="19.2" width="14.8" height="1.7" rx="0.85" fill="currentColor" />
    </svg>
  );
}

/** The official multi-colour Google "G" mark. */
function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" role="img" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.17-2 3.44-4.95 3.44-8.38z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.1 0 5.7-1.03 7.6-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.88 1.1-2.98 0-5.5-2.01-6.4-4.72H1.75v2.98A11.99 11.99 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.6 14.7A7.2 7.2 0 0 1 5.22 12c0-.94.16-1.85.38-2.7V6.32H1.75A12 12 0 0 0 .48 12c0 1.94.46 3.77 1.27 5.38l3.85-2.68z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.68 0 3.19.58 4.38 1.71l3.28-3.28C17.7 1.19 15.1 0 12 0 7.31 0 3.26 2.69 1.75 6.62l3.85 2.98C6.5 6.78 9.02 4.77 12 4.77z"
      />
    </svg>
  );
}
