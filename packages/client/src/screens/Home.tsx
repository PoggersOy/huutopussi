/**
 * Home: nickname (persisted) + create room + join by code + recent rooms +
 * language toggle + subtle PWA install affordance.
 */
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ConnectionPill } from '../components/ConnectionPill';
import { loadRecentRooms, type RecentRoom } from '../history';
import { LANGUAGES, setLanguage } from '../i18n';
import { installAvailable, promptInstall, subscribeInstall } from '../install';
import { connect } from '../socket';
import { useStore } from '../store';

const NICKNAME_KEY = 'hp:nickname';

export function savedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(savedNickname);
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [recents] = useState<RecentRoom[]>(loadRecentRooms);
  const canInstall = useSyncExternalStore(subscribeInstall, installAvailable);
  const createdCode = useStore((s) => s.server.room?.code);

  // Room creation: the code arrives in the welcome message; then navigate.
  useEffect(() => {
    if (creating && createdCode !== undefined) navigate(`/r/${createdCode}`);
  }, [creating, createdCode, navigate]);

  function persistNickname(): string | undefined {
    const nick = nickname.trim();
    try {
      if (nick !== '') localStorage.setItem(NICKNAME_KEY, nick);
    } catch {
      // Not persisted; still used for this connection.
    }
    return nick === '' ? undefined : nick;
  }

  function onCreate(): void {
    setCreating(true);
    connect(undefined, undefined, persistNickname());
  }

  function onJoin(e: FormEvent): void {
    e.preventDefault();
    persistNickname();
    const trimmed = code.trim().toUpperCase();
    if (trimmed !== '') navigate(`/r/${trimmed}`);
  }

  function onOpenRecent(roomCode: string): void {
    persistNickname();
    navigate(`/r/${roomCode}`);
  }

  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('app.title')}</h1>
          <ConnectionPill />
        </div>
        <p className="dim">{t('home.tagline')}</p>
      </header>
      <main className="screen__main">
        <div className="panel stack">
          <label className="stack">
            <span className="dim">{t('home.nickname')}</span>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={t('home.nicknamePlaceholder')}
              maxLength={20}
              autoComplete="nickname"
            />
          </label>
          <button type="button" className="btn--primary" onClick={onCreate} disabled={creating}>
            {creating ? t('connection.connecting') : t('home.create')}
          </button>
        </div>
        <form className="panel stack" onSubmit={onJoin}>
          <span className="dim">{t('home.orJoin')}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('home.codePlaceholder')}
            maxLength={5}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" disabled={code.trim().length !== 5}>
            {t('home.join')}
          </button>
        </form>
        {recents.length > 0 && (
          <section className="panel stack">
            <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('home.recentRooms')}</h2>
            <ul className="list">
              {recents.map((room) => (
                <li key={room.code}>
                  <button
                    type="button"
                    className="list__row"
                    onClick={() => onOpenRecent(room.code)}
                  >
                    <strong className="room-code">{room.code}</strong>
                    <span className="dim">{dateFmt.format(room.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <button type="button" className="btn--ghost" onClick={() => navigate('/history')}>
          {t('home.historyLink')}
        </button>
      </main>
      <footer className="screen__bottom row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <span className="dim">{t('home.language')}:</span>
          {LANGUAGES.map((lang) => (
            <button
              type="button"
              key={lang}
              className={i18n.language === lang ? 'btn--primary' : 'btn--ghost'}
              onClick={() => setLanguage(lang)}
            >
              {lang.toUpperCase()}
            </button>
          ))}
        </div>
        {canInstall && (
          <button type="button" className="btn--ghost" onClick={() => void promptInstall()}>
            {t('home.install')}
          </button>
        )}
      </footer>
    </div>
  );
}
