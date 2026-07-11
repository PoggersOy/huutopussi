/**
 * History: this device's game record in one place —
 *  1. Open games: rooms this device visited that the server confirms are still
 *     live (via GET /api/rooms), each with a one-tap rejoin.
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
import { useStore } from '../store';

export function History() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const live = useStore((s) => s.ui.history);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` is the refresh trigger — a new 'history' message means localStorage changed.
  const entries = useMemo(() => loadAllHistory(), [live]);
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);

  // Probe the rooms this device remembers; keep only the ones still live.
  useEffect(() => {
    const codes = loadRecentRooms().map((r) => r.code);
    if (codes.length === 0) return;
    let cancelled = false;
    void fetchOpenRooms(codes).then((rooms) => {
      if (!cancelled) setOpenRooms(rooms);
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
          <p className="dim" style={{ textAlign: 'center' }}>
            {t('history.empty')}
          </p>
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
