/**
 * History: this device's game record in one place —
 *  1. Open games: rooms this device visited that the server confirms are still
 *     live (via a session-token-protected /api/rooms probe), each with a one-tap rejoin.
 *  2. Finished matches: every summary received via 'history' messages,
 *     persisted per room in localStorage, newest first.
 * Live updates while connected: a fresh 'history' message re-reads the set.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchOpenRooms, type OpenRoom } from '../api';
import { ConnectionPill } from '../components/ConnectionPill';
import { MatchList } from '../components/MatchList';
import { loadAllHistory, loadRecentRooms } from '../history';
import { loadSessionToken } from '../socket';
import { useStore } from '../store';

/**
 * A fanned hand of playing cards — the empty-state motif for "no matches yet".
 * Cream faces over a soft gold glow, in the four-colour deck the game uses
 * (K♠ black, A♥ red, 10♦ blue), splayed rightward like a held hand so each
 * card's corner index stays visible.
 */
function CardFanArt() {
  const cards = [
    { rank: 'K', suit: '♠', color: 'var(--card-black)', rot: -20 },
    { rank: 'A', suit: '♥', color: 'var(--card-red)', rot: 0 },
    { rank: '10', suit: '♦', color: 'var(--card-blue)', rot: 20 },
  ];
  return (
    <svg className="empty-state__art" viewBox="0 0 220 168" role="img" aria-hidden="true">
      <ellipse cx="110" cy="100" rx="88" ry="50" fill="var(--gold)" opacity="0.1" />
      {cards.map((c) => (
        <g key={c.rank} transform={`translate(110 152) rotate(${c.rot})`}>
          <rect
            x="-33"
            y="-96"
            width="66"
            height="94"
            rx="8"
            fill="var(--card-face)"
            stroke="var(--card-border)"
            strokeWidth="1.5"
          />
          <text x="-25" y="-73" fontSize="15" fontWeight="700" fill={c.color}>
            {c.rank}
          </text>
          <text x="-25.5" y="-59" fontSize="13" fill={c.color}>
            {c.suit}
          </text>
          <text x="0" y="-40" fontSize="34" textAnchor="middle" fill={c.color}>
            {c.suit}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function History() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const live = useStore((s) => s.ui.history);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` is the refresh trigger — a new 'history' message means localStorage changed.
  const entries = useMemo(() => loadAllHistory(), [live]);
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);

  // Probe the rooms this device remembers; keep only the ones still live.
  useEffect(() => {
    const rooms = loadRecentRooms().flatMap((r) => {
      const sessionToken = loadSessionToken(r.code);
      return sessionToken === null ? [] : [{ code: r.code, sessionToken }];
    });
    if (rooms.length === 0) return;
    let cancelled = false;
    void fetchOpenRooms(rooms).then((open) => {
      if (!cancelled) setOpenRooms(open);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const empty = openRooms.length === 0 && entries.length === 0;

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('history.title')}</h1>
          <ConnectionPill />
        </div>
      </header>
      <main className="screen__main">
        {empty ? (
          <div className="empty-state">
            <CardFanArt />
            <h2 className="empty-state__title">{t('history.empty')}</h2>
            <p className="empty-state__text">{t('history.emptyText')}</p>
            <button
              type="button"
              className="btn--primary empty-state__cta"
              onClick={() => navigate('/')}
            >
              {t('history.emptyCta')}
            </button>
          </div>
        ) : (
          <>
            {openRooms.length > 0 && (
              <section className="panel stack">
                <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('history.openGames')}</h2>
                <ul className="list">
                  {openRooms.map((room) => (
                    <li key={room.code}>
                      <button
                        type="button"
                        className="list__row"
                        onClick={() => navigate(`/r/${room.code}`)}
                      >
                        <strong className="room-code">{room.code}</strong>
                        <span className="dim">
                          {t(
                            room.status === 'playing'
                              ? 'history.statusPlaying'
                              : 'history.statusLobby',
                          )}
                          {' · '}
                          {t('history.seats', {
                            filled: room.seatsFilled,
                            total: room.seatsTotal,
                          })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {entries.length > 0 && (
              <div className="panel stack">
                {openRooms.length > 0 && (
                  <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('history.finished')}</h2>
                )}
                <MatchList entries={entries} showRoom={true} />
              </div>
            )}
          </>
        )}
      </main>
      <footer className="screen__bottom">
        <button type="button" style={{ width: '100%' }} onClick={() => navigate('/')}>
          {t('common.back')}
        </button>
      </footer>
    </div>
  );
}
