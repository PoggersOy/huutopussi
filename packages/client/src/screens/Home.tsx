/**
 * Home: the front door. A small config block (nickname + player count) shared by
 * every mode, then three clearly separated ways to play:
 *   1. Etsi peli   — online matchmaking against real opponents (ranked/unranked).
 *   2. Pikapeli    — one tap to start immediately against bots.
 *   3. Kaverit     — create a private room to share, or join one by code.
 * A signed-in player's nickname field is pre-filled (editably) with their first
 * name. Rejoinable/past games live on the History screen (link at the bottom).
 */
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchMatchmaking, type MatchmakingBucket } from '../api';
import { AuthPanel } from '../components/AuthPanel';
import { ConnectionPill } from '../components/ConnectionPill';
import { LANGUAGES, setLanguage } from '../i18n';
import { installAvailable, promptInstall, subscribeInstall } from '../install';
import { connect, findMatch, sendLobby } from '../socket';
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

/** The leading token of a full name ("Samuli Vainio" → "Samuli"); '' if none. */
function firstName(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** Which start flow is in flight — decides how we route on the room's welcome. */
type Pending = 'find' | 'quick' | 'create';

export function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useStore((s) => s.auth.user);
  const signedIn = user !== null;
  const [nickname, setNickname] = useState(savedNickname);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  /** Game mode (2/3/4 players) — shared by every start flow. */
  const [players, setPlayers] = useState<2 | 3 | 4>(4);
  const [ranked, setRanked] = useState(false);
  const [buckets, setBuckets] = useState<MatchmakingBucket[]>([]);
  const canInstall = useSyncExternalStore(subscribeInstall, installAvailable);
  const createdCode = useStore((s) => s.server.room?.code);
  const effectiveRanked = ranked && signedIn;

  // Signing in pre-fills the nickname with the account's first name — but only
  // when the field is empty, so a name the player deliberately typed/saved wins.
  // Keyed on `user` alone on purpose: run once per sign-in, not per keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nickname` is read as a one-shot guard, not a trigger.
  useEffect(() => {
    if (user && nickname.trim() === '') {
      const first = firstName(user.name);
      if (first !== '') setNickname(first);
    }
  }, [user]);

  // A start flow's room code arrives in the welcome (creation OR matchmaking).
  // Quick-vs-bots additionally fills the empty seats and starts before we route.
  useEffect(() => {
    if (pending === null || createdCode === undefined) return;
    if (pending === 'quick') sendLobby({ type: 'fillBotsAndStart' });
    navigate(`/r/${createdCode}`);
  }, [pending, createdCode, navigate]);

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

  function onFindMatch(): void {
    setPending('find');
    findMatch(players, effectiveRanked, persistNickname());
  }

  function onQuickBots(): void {
    setPending('quick');
    connect(undefined, undefined, persistNickname(), { players });
  }

  function onCreate(): void {
    setPending('create');
    connect(undefined, undefined, persistNickname(), { players });
  }

  function onJoin(e: FormEvent): void {
    e.preventDefault();
    persistNickname();
    const trimmed = code.trim().toUpperCase();
    if (trimmed !== '') navigate(`/r/${trimmed}`);
  }

  const busy = pending !== null;

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 className="brand">
            <img
              className="brand__logo"
              src="/logo.png"
              alt=""
              aria-hidden="true"
              width={68}
              height={44}
            />
            {t('app.title')}
          </h1>
          <div className="row auth-header">
            <ConnectionPill />
            <AuthPanel />
          </div>
        </div>
        <p className="dim">{t('home.tagline')}</p>
      </header>

      <main className="screen__main">
        {/* Shared config: who you are + how many at the table. */}
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
          <div className="stack">
            <span className="dim">{t('config.players')}</span>
            <div className="seg">
              {([2, 3, 4] as const).map((n) => (
                <button
                  type="button"
                  key={n}
                  className="seg__opt"
                  aria-pressed={players === n}
                  onClick={() => setPlayers(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        <h2 className="home-heading">{t('home.chooseMode')}</h2>

        {/* 1 — Online matchmaking. */}
        <section className="mode-card">
          <div className="mode-card__head">
            <span className="mode-card__icon" aria-hidden="true">
              🔎
            </span>
            <div className="mode-card__text">
              <h3 className="mode-card__title">{t('home.online.title')}</h3>
              <p className="dim mode-card__desc">{t('home.online.desc')}</p>
            </div>
          </div>
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
          <button type="button" className="btn--primary" onClick={onFindMatch} disabled={busy}>
            {pending === 'find' ? t('matchmaking.searching') : t('home.online.action')}
            {pending !== 'find' && waiting > 0 && (
              <span className="mm-count">
                {' '}
                · {t('matchmaking.waitingCount', { count: waiting })}
              </span>
            )}
          </button>
        </section>

        {/* 2 — Quick match against bots. */}
        <section className="mode-card">
          <div className="mode-card__head">
            <span className="mode-card__icon" aria-hidden="true">
              🤖
            </span>
            <div className="mode-card__text">
              <h3 className="mode-card__title">{t('home.bots.title')}</h3>
              <p className="dim mode-card__desc">{t('home.bots.desc')}</p>
            </div>
          </div>
          <button type="button" onClick={onQuickBots} disabled={busy}>
            {pending === 'quick' ? t('connection.connecting') : t('home.bots.action')}
          </button>
        </section>

        {/* 3 — Private room: create & share, or join by code. */}
        <section className="mode-card">
          <div className="mode-card__head">
            <span className="mode-card__icon" aria-hidden="true">
              👥
            </span>
            <div className="mode-card__text">
              <h3 className="mode-card__title">{t('home.friends.title')}</h3>
              <p className="dim mode-card__desc">{t('home.friends.desc')}</p>
            </div>
          </div>
          <button type="button" onClick={onCreate} disabled={busy}>
            {pending === 'create' ? t('connection.connecting') : t('home.create')}
          </button>
          <div className="mode-card__or">
            <span>{t('home.friends.or')}</span>
          </div>
          <form className="row mode-card__join" onSubmit={onJoin}>
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
        </section>

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
