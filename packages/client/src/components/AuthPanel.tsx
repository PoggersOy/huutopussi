/**
 * Compact header account control (top-right). Signed out (and login enabled):
 * the Google Sign-In icon button. Signed in: a small avatar + rating chip that
 * links to the profile (where Sign out lives). Renders nothing when login is
 * disabled (no client id) — the app stays fully playable as a guest.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { renderGoogleButton } from '../auth';
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
    // Layout: the ELO field on the left, then the user's avatar "ball" on the
    // far right edge. The whole row links to the profile.
    return (
      <button
        type="button"
        className="auth-header__chip"
        onClick={() => navigate('/profile')}
        aria-label={user.name ?? t('auth.signedIn')}
        title={t('auth.profile')}
      >
        <RatingBadge rating={user.rating} provisional={user.provisional} label={t('auth.elo')} />
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
    // GIS renders its own (icon) button into this slot; the title labels it.
    return <div ref={btnRef} className="auth-header__btn" title={t('auth.signInPrompt')} />;
  }

  return null; // login disabled → guest-only
}
