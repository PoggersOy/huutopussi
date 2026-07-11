/**
 * Profile: the signed-in player's Elo, W/L, streaks, and recent rated-match
 * deltas (from GET /api/profile). Shows a sign-in prompt when signed out.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getAuthToken, signOut } from '../auth';
import { type AuthUser, useStore } from '../store';

interface RatingEvent {
  matchId: string;
  seat: number;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  streakAfter: number;
  createdAt: number;
}

/** Games below this are provisional (mirrors the server's PROVISIONAL_GAMES). */
const PROVISIONAL_GAMES = 10;

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="profile__stat">
      <span className="profile__stat-value">{value}</span>
      <span className="dim">{label}</span>
    </div>
  );
}

export function Profile() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const storeUser = useStore((s) => s.auth.user);
  const [user, setUser] = useState<AuthUser | null>(storeUser);
  const [events, setEvents] = useState<RatingEvent[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    const token = getAuthToken();
    if (token === null) {
      setError(true);
      return;
    }
    let cancelled = false;
    void fetch('/api/profile', { headers: { authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error('unauthorized');
        return (await res.json()) as { user: AuthUser; ratingEvents: RatingEvent[] };
      })
      .then((body) => {
        if (cancelled) return;
        setUser(body.user);
        setEvents(body.ratingEvents);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('profile.title')}</h1>
          <button type="button" className="btn--ghost" onClick={() => navigate('/')}>
            {t('profile.back')}
          </button>
        </div>
      </header>
      <main className="screen__main">
        {error || user === null ? (
          <div className="panel stack">
            <p className="dim">{t('profile.signInRequired')}</p>
          </div>
        ) : (
          <>
            <div className="panel stack profile__head">
              {user.picture !== null && (
                <img
                  src={user.picture}
                  alt=""
                  className="auth-chip__avatar"
                  referrerPolicy="no-referrer"
                />
              )}
              <strong>{user.name ?? t('auth.signedIn')}</strong>
              <div className="profile__rating">
                <span className="profile__rating-num">{user.rating}</span>
                {user.provisional && <span className="dim">{t('profile.provisional')}</span>}
              </div>
              {user.provisional && (
                <p className="dim">{t('profile.provisionalHint', { n: PROVISIONAL_GAMES })}</p>
              )}
            </div>

            <div className="panel profile__stats">
              <Stat label={t('profile.games')} value={user.gamesPlayed} />
              <Stat label={t('profile.wins')} value={user.wins} />
              <Stat label={t('profile.losses')} value={user.losses} />
              <Stat label={t('profile.winStreak')} value={user.winStreak} />
              <Stat label={t('profile.bestStreak')} value={user.bestStreak} />
            </div>

            <div className="panel stack">
              <h2>{t('profile.recent')}</h2>
              {events.length > 0 ? (
                <ul className="list">
                  {events.map((e) => (
                    <li
                      key={e.matchId}
                      className="match-row row"
                      style={{ justifyContent: 'space-between' }}
                    >
                      <span className={e.delta >= 0 ? 'delta--pos' : 'delta--neg'}>
                        {signed(e.delta)}
                      </span>
                      <strong>{e.ratingAfter}</strong>
                      <span className="dim">{dateFmt.format(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dim">{t('profile.noGames')}</p>
              )}
            </div>
          </>
        )}
      </main>
      {user !== null && (
        <footer className="screen__bottom">
          <button
            type="button"
            className="btn--danger"
            style={{ width: '100%' }}
            onClick={() => {
              signOut();
              navigate('/');
            }}
          >
            {t('auth.signOut')}
          </button>
        </footer>
      )}
    </div>
  );
}
