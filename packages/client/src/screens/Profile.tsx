/**
 * Profile: the signed-in player's skill rating (Elo), record, and recent
 * rated-match changes (from GET /api/profile). The rating is presented as a
 * "skill level" with a plain-language explainer, since not every player knows
 * what "Elo" means. Shows a sign-in prompt when signed out.
 */
import type { Seat, Side } from '@hp/engine';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { deleteAccount, getAuthToken, signOut } from '../auth';
import { ProfileScorecard } from '../components/ProfileScorecard';
import { type AuthUser, useStore } from '../store';

/** Compact finished-match scorecard the server embeds in each rating event. */
export interface RatingMatchInfo {
  players: 2 | 3 | 4;
  winnerSide: Side;
  finalScores: number[];
  names: (string | null)[] | null;
  deals: number;
}

export interface RatingEvent {
  matchId: string;
  seat: Seat;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  streakAfter: number;
  createdAt: number;
  /** null when the match row is gone or didn't finish normally (no scorecard). */
  match: RatingMatchInfo | null;
}

/** Games below this are provisional (mirrors the server's PROVISIONAL_GAMES). */
const PROVISIONAL_GAMES = 10;
/** Every player opens here (mirrors the server's STARTING_RATING). */
const STARTING_RATING = 1000;

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** A gold crown, the same motif the header ELO wears, sized for the hero. */
function CrownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" role="img" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2.5 8.2a1.25 1.25 0 1 0-1.2-1.6L3.2 17.2A1 1 0 0 0 4.18 18h15.64a1 1 0 0 0 .98-.8L22.7 6.6a1.25 1.25 0 1 0-1.2 1.6l-4.03 2.9-3.5-5.2a1.2 1.2 0 0 0-1.94 0l-3.5 5.2L2.5 8.2z"
      />
      <rect x="4.6" y="19.2" width="14.8" height="1.7" rx="0.85" fill="currentColor" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="profile__stat">
      <span className="profile__stat-value">{value}</span>
      <span className="profile__stat-label">{label}</span>
    </div>
  );
}

export function Profile() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const storeUser = useStore((s) => s.auth.user);
  const [user, setUser] = useState<AuthUser | null>(storeUser);
  const [events, setEvents] = useState<RatingEvent[]>([]);
  const [selected, setSelected] = useState<RatingEvent | null>(null);
  const [error, setError] = useState(false);
  /** Account-management (data export / erasure) local UI state. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  /** GDPR art. 20: fetch everything we hold and save it as a JSON download. */
  async function handleExport(): Promise<void> {
    const token = getAuthToken();
    if (token === null) return;
    try {
      const res = await fetch('/api/account/export', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = 'huutopussi-omat-tiedot.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      // best-effort; a failed export leaves the account untouched
    }
  }

  /** GDPR art. 17: permanently delete the account, then return to the front page. */
  async function handleDelete(): Promise<void> {
    setDeleting(true);
    setDeleteFailed(false);
    const ok = await deleteAccount();
    setDeleting(false);
    if (ok) navigate('/');
    else setDeleteFailed(true);
  }

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

  const sinceStart = user !== null ? user.rating - STARTING_RATING : 0;
  const winRate =
    user !== null && user.gamesPlayed > 0
      ? `${Math.round((user.wins / user.gamesPlayed) * 100)}%`
      : '—';

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
            {/* Hero: identity + the rating, framed as a skill level so the number
                reads as "how good am I", not a bare, unexplained figure. */}
            <section className="panel profile__hero">
              <div className="profile__id">
                {user.picture !== null && (
                  <img
                    src={user.picture}
                    alt=""
                    className="profile__avatar"
                    referrerPolicy="no-referrer"
                  />
                )}
                <strong className="profile__name">{user.name ?? t('auth.signedIn')}</strong>
              </div>

              <div className="profile__rating">
                <span className="profile__crown" aria-hidden="true">
                  <CrownIcon />
                </span>
                <span className="profile__rating-num">{user.rating}</span>
              </div>

              <div className="profile__rating-cap">
                <span className="profile__rating-name">{t('profile.ratingName')}</span>
                <span className="profile__tag">Elo</span>
              </div>

              <p className="profile__summary dim">{t('profile.ratingSummary')}</p>

              {sinceStart !== 0 && (
                <span className={`profile__delta ${sinceStart > 0 ? 'delta--pos' : 'delta--neg'}`}>
                  {sinceStart > 0 ? '▲' : '▼'} {signed(sinceStart)} {t('profile.sinceStart')}
                </span>
              )}

              {user.provisional && (
                <span className="profile__provisional">
                  <span className="profile__badge">{t('profile.provisional')}</span>
                  <span className="dim">
                    {t('profile.provisionalHint', { n: PROVISIONAL_GAMES })}
                  </span>
                </span>
              )}
            </section>

            {/* Progressive-disclosure explainer: quiet for players who know Elo,
                a full plain-language answer for those who don't. */}
            <details className="panel profile__explainer">
              <summary className="profile__explainer-q">{t('profile.whatIsElo')}</summary>
              <p className="dim profile__explainer-a">
                {t('profile.eloExplainer', { start: STARTING_RATING })}
              </p>
            </details>

            <div className="panel profile__stats">
              <Stat label={t('profile.games')} value={user.gamesPlayed} />
              <Stat label={t('profile.winRate')} value={winRate} />
              <Stat label={t('profile.bestStreak')} value={user.bestStreak} />
              <Stat label={t('profile.wins')} value={user.wins} />
              <Stat label={t('profile.losses')} value={user.losses} />
              <Stat label={t('profile.winStreak')} value={user.winStreak} />
            </div>

            <div className="panel stack">
              <h2>{t('profile.recent')}</h2>
              {events.length > 0 ? (
                <ul className="list">
                  {events.slice(0, 10).map((e) => {
                    const content = (
                      <>
                        <span
                          className={`match-row__delta ${e.delta >= 0 ? 'delta--pos' : 'delta--neg'}`}
                        >
                          {e.delta >= 0 ? '▲' : '▼'} {signed(e.delta)}
                        </span>
                        <span className="match-row__after">{e.ratingAfter}</span>
                        <span className="dim match-row__when">{dateFmt.format(e.createdAt)}</span>
                        {e.match !== null && <span className="match-row__chev">›</span>}
                      </>
                    );
                    return (
                      <li key={e.matchId} className="match-row match-row--rating">
                        {e.match !== null ? (
                          <button
                            type="button"
                            className="match-row__btn match-row__btn--rating"
                            onClick={() => setSelected(e)}
                            aria-label={t('profile.scorecardOpen')}
                          >
                            {content}
                          </button>
                        ) : (
                          content
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="dim">{t('profile.noGames')}</p>
              )}
            </div>

            {/* Account management: the GDPR self-service controls — download
                everything we hold (art. 20), read the policy, or permanently
                erase the account (art. 17, guarded by an inline confirm). */}
            <div className="panel stack">
              <h2>{t('account.title')}</h2>
              <button type="button" className="btn--ghost" onClick={() => void handleExport()}>
                {t('account.exportData')}
              </button>
              <button type="button" className="btn--ghost" onClick={() => navigate('/privacy')}>
                {t('account.privacyPolicy')}
              </button>
              {confirmingDelete ? (
                <div className="stack">
                  <p className="dim">{t('account.deleteConfirmBody')}</p>
                  {deleteFailed && <p className="dim">{t('account.deleteFailed')}</p>}
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <button
                      type="button"
                      className="btn--ghost"
                      onClick={() => {
                        setConfirmingDelete(false);
                        setDeleteFailed(false);
                      }}
                      disabled={deleting}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className="btn--danger"
                      onClick={() => void handleDelete()}
                      disabled={deleting}
                    >
                      {deleting ? t('common.loading') : t('account.deleteConfirm')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn--danger"
                  onClick={() => setConfirmingDelete(true)}
                >
                  {t('account.deleteAccount')}
                </button>
              )}
            </div>
          </>
        )}
      </main>
      {selected !== null && <ProfileScorecard event={selected} onClose={() => setSelected(null)} />}
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
