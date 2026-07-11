/**
 * Home: nickname (persisted) + create room + join by code + language toggle +
 * subtle PWA install affordance. Rejoinable/past games live on the History
 * screen (reached via the link below), not here.
 */
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchMatchmaking, type MatchmakingBucket } from '../api';
import { AuthPanel } from '../components/AuthPanel';
import { ConnectionPill } from '../components/ConnectionPill';
import { LANGUAGES, setLanguage } from '../i18n';
import { installAvailable, promptInstall, subscribeInstall } from '../install';
import { connect, findMatch } from '../socket';
import { useStore } from '../store';

const NICKNAME_KEY = 'hp:nickname';

export function savedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist a nickname (trimmed) for reuse across sessions; no-op if blank. */
export function storeNickname(nick: string): void {
  const trimmed = nick.trim();
  if (trimmed === '') return;
  try {
    localStorage.setItem(NICKNAME_KEY, trimmed);
  } catch {
    // Not persisted (private mode); still used for this connection.
  }
}

export function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(savedNickname);
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  /** Game mode (2/3/4 players) — shared by Find match and Create room. */
  const [players, setPlayers] = useState<2 | 3 | 4>(4);
  const [ranked, setRanked] = useState(false);
  const [buckets, setBuckets] = useState<MatchmakingBucket[]>([]);
  const canInstall = useSyncExternalStore(subscribeInstall, installAvailable);
  const createdCode = useStore((s) => s.server.room?.code);
  const signedIn = useStore((s) => s.auth.user !== null);
  const effectiveRanked = ranked && signedIn;

  // Room creation OR matchmaking: the code arrives in the welcome; then navigate.
  useEffect(() => {
    if ((creating || searching) && createdCode !== undefined) navigate(`/r/${createdCode}`);
  }, [creating, searching, createdCode, navigate]);

  // Ranked needs a signed-in account; drop the toggle on sign-out.
  useEffect(() => {
    if (!signedIn) setRanked(false);
  }, [signedIn]);

  // Poll live waiting counts per bucket while on Home.
  useEffect(() => {
    let active = true;
    const load = (): void => {
      void fetchMatchmaking().then((b) => {
        if (active) setBuckets(b);
      });
    };
    load();
    const id = setInterval(load, 5_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const waiting =
    buckets.find((b) => b.players === players && b.ranked === effectiveRanked)?.waiting ?? 0;

  function persistNickname(): string | undefined {
    const nick = nickname.trim();
    storeNickname(nick);
    return nick === '' ? undefined : nick;
  }

  function onCreate(): void {
    setCreating(true);
    connect(undefined, undefined, persistNickname(), { players });
  }

  function onFindMatch(): void {
    setSearching(true);
    findMatch(players, effectiveRanked, persistNickname());
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
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('app.title')}</h1>
          <div className="row auth-header">
            <ConnectionPill />
            <AuthPanel />
          </div>
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
          <label className="stack">
            <span className="dim">{t('config.players')}</span>
            <select
              value={players}
              onChange={(e) => setPlayers(Number(e.target.value) as 2 | 3 | 4)}
            >
              {([2, 3, 4] as const).map((n) => (
                <option key={n} value={n}>
                  {t('config.playersOpt', { n })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="panel stack">
          <span className="dim">{t('matchmaking.title')}</span>
          <div className={`toggle${effectiveRanked ? ' toggle--on' : ''}`}>
            <span className="toggle__thumb" aria-hidden="true" />
            <button
              type="button"
              className="toggle__opt"
              aria-pressed={!effectiveRanked}
              onClick={() => setRanked(false)}
            >
              {t('matchmaking.unranked')}
            </button>
            <button
              type="button"
              className="toggle__opt"
              aria-pressed={effectiveRanked}
              onClick={() => setRanked(true)}
              disabled={!signedIn}
            >
              {t('matchmaking.ranked')}
            </button>
          </div>
          {ranked && !signedIn && <span className="dim">{t('matchmaking.rankedSignInHint')}</span>}
          <button type="button" className="btn--primary" onClick={onFindMatch} disabled={searching}>
            {searching ? t('matchmaking.searching') : t('matchmaking.find')}
            {!searching && waiting > 0 && (
              <span className="mm-count">
                {' '}
                · {t('matchmaking.waitingCount', { count: waiting })}
              </span>
            )}
          </button>
        </div>

        <div className="panel stack">
          <button type="button" onClick={onCreate} disabled={creating}>
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
