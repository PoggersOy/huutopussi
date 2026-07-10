/** Home: nickname + create/join. Placeholder screen (replaced next phase). */
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LANGUAGES, setLanguage } from '../i18n';
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

  return (
    <div className="screen">
      <header className="screen__top">
        <h1>{t('app.title')}</h1>
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
      </main>
      <footer className="screen__bottom row">
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
      </footer>
    </div>
  );
}
