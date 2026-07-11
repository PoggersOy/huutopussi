/**
 * The Home-screen account block: the Google Sign-In button when signed out
 * (and login is enabled), or a chip with the account name + rating + links to
 * the profile and sign-out when signed in. Renders nothing when login is
 * disabled (no client id) — the app stays fully playable as a guest.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { renderGoogleButton, signOut } from '../auth';
import { useStore } from '../store';
import { RatingBadge } from './RatingBadge';

export function AuthPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useStore((s) => s.auth.user);
  const googleClientId = useStore((s) => s.auth.googleClientId);
  const loginReady = useStore((s) => s.auth.loginReady);
  const btnRef = useRef<HTMLDivElement>(null);

  // (Re)render the GIS button whenever it can be shown (login enabled, GIS
  // ready, and no user yet). loginReady flips true once GIS finishes loading.
  useEffect(() => {
    if (!user && googleClientId && loginReady && btnRef.current) {
      renderGoogleButton(btnRef.current);
    }
  }, [user, googleClientId, loginReady]);

  if (user) {
    return (
      <div className="panel auth-chip">
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            className="auth-chip__avatar"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="avatar" aria-hidden="true">
            {(user.name ?? '?').charAt(0).toUpperCase()}
          </span>
        )}
        <div className="auth-chip__id">
          <strong>{user.name ?? t('auth.signedIn')}</strong>
          <RatingBadge rating={user.rating} provisional={user.provisional} />
        </div>
        <div className="auth-chip__actions">
          <button type="button" className="btn--ghost" onClick={() => navigate('/profile')}>
            {t('auth.profile')}
          </button>
          <button type="button" className="btn--ghost" onClick={signOut}>
            {t('auth.signOut')}
          </button>
        </div>
      </div>
    );
  }

  if (googleClientId) {
    return (
      <div className="panel stack auth-panel">
        <span className="dim">{t('auth.signInPrompt')}</span>
        <div ref={btnRef} className="auth-panel__btn" />
      </div>
    );
  }

  return null; // login disabled → guest-only
}
