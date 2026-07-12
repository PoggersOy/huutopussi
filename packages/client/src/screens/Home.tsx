/**
 * Home: the front door. A small config block (nickname + player count) shared by
 * every mode, then three clearly separated ways to play:
 *   1. Etsi peli   — online matchmaking against real opponents (ranked/unranked).
 *   2. Pikapeli    — one tap to start immediately against bots.
 *   3. Kaverit     — create a private room to share, or join one by code.
 * A signed-in player's nickname field is pre-filled (editably) with their
 * display name ("First L."). Rejoinable/past games live on the History screen
 * (link at the bottom).
 */
import type { BotDifficulty, ConfigPatch } from '@hp/protocol';
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchMatchmaking, type MatchmakingBucket } from '../api';
import { AuthPanel } from '../components/AuthPanel';
import { ConnectionPill } from '../components/ConnectionPill';
import { resolveDefaultConfig, useDefaultConfigId } from '../defaultRuleConfig';
import {
  canVibrate,
  getHapticsOn,
  getSoundOn,
  setHapticsOn,
  setSoundOn,
  subscribePrefs,
} from '../feedback';
import { LANGUAGES, setLanguage } from '../i18n';
import { installAvailable, promptInstall, subscribeInstall } from '../install';
import { resolveConfigForPlayers } from '../rules';
import { connect, findMatch, sendLobby } from '../socket';
import { useStore } from '../store';

const NICKNAME_KEY = 'hp:nickname';
const DIFFICULTY_KEY = 'hp:botDifficulty';

export function savedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

const BOT_LEVELS: readonly BotDifficulty[] = ['easy', 'medium', 'hard'];

/** The persisted Pikapeli bot level; medium if unset/invalid. */
function savedDifficulty(): BotDifficulty {
  try {
    const v = localStorage.getItem(DIFFICULTY_KEY);
    if (v === 'easy' || v === 'medium' || v === 'hard') return v;
  } catch {
    // Private mode — fall through to the default.
  }
  return 'medium';
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

/** Which start flow is in flight — decides how we route on the room's welcome. */
type Pending = 'find' | 'quick' | 'create';

export function Home() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useStore((s) => s.auth.user);
  const signedIn = user !== null;
  // The account's saved rulesets + the starred ("ensisijainen") one, auto-applied
  // as the initial config when this player creates a room (see initialConfig).
  const ruleConfigs = useStore((s) => s.auth.ruleConfigs);
  const starredId = useDefaultConfigId(user?.id ?? null);
  const [nickname, setNickname] = useState(savedNickname);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  /** Game mode (2/3/4 players) — shared by every start flow. */
  const [players, setPlayers] = useState<2 | 3 | 4>(4);
  /** Pikapeli bot skill level. */
  const [difficulty, setDifficulty] = useState<BotDifficulty>(savedDifficulty);
  const [ranked, setRanked] = useState(false);
  const [buckets, setBuckets] = useState<MatchmakingBucket[]>([]);
  const canInstall = useSyncExternalStore(subscribeInstall, installAvailable);
  const createdCode = useStore((s) => s.server.room?.code);
  const effectiveRanked = ranked && signedIn;
  // Device feedback prefs (sound + haptics) — persisted, read via the feedback store.
  const soundOn = useSyncExternalStore(subscribePrefs, getSoundOn, getSoundOn);
  const hapticsOn = useSyncExternalStore(subscribePrefs, getHapticsOn, getHapticsOn);

  // Signing in pre-fills the nickname with the account's display name ("First
  // L.") — but only when the field is empty, so a name the player deliberately
  // typed/saved wins. Keyed on `user` alone on purpose: run once per sign-in,
  // not per keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nickname` is read as a one-shot guard, not a trigger.
  useEffect(() => {
    if (user && nickname.trim() === '') {
      const displayName = (user.name ?? '').trim();
      if (displayName !== '') setNickname(displayName);
    }
  }, [user]);

  // A start flow's room code arrives in the welcome (creation OR matchmaking).
  // Quick-vs-bots additionally fills the empty seats and starts before we route.
  useEffect(() => {
    if (pending === null || createdCode === undefined) return;
    if (pending === 'quick') sendLobby({ type: 'fillBotsAndStart', difficulty });
    navigate(`/r/${createdCode}`);
  }, [pending, createdCode, difficulty, navigate]);

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

  function chooseDifficulty(level: BotDifficulty): void {
    setDifficulty(level);
    try {
      localStorage.setItem(DIFFICULTY_KEY, level);
    } catch {
      // Private mode — the choice still applies to this session.
    }
  }

  /**
   * The initial room config for a create/quick flow: the player's starred saved
   * ruleset (resolved to the chosen player count), or the built-in "Oletus"
   * default when nothing is starred. Matchmaking is excluded — ranked/found rooms
   * always use standard rules.
   */
  function initialConfig(): { patch: ConfigPatch; configName: string | null } {
    const starred = resolveDefaultConfig(ruleConfigs, starredId);
    if (starred !== null) {
      return { patch: resolveConfigForPlayers(starred.config, players), configName: starred.name };
    }
    return { patch: { players }, configName: null };
  }

  function onQuickBots(): void {
    setPending('quick');
    const init = initialConfig();
    connect(undefined, undefined, persistNickname(), init.patch, init.configName);
  }

  function onCreate(): void {
    setPending('create');
    const init = initialConfig();
    connect(undefined, undefined, persistNickname(), init.patch, init.configName);
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
        <div className="screen__topbar">
          <h1 className="brand">
            <img
              className="brand__logo"
              src="/logo.png"
              alt=""
              aria-hidden="true"
              width={68}
              height={44}
            />
            <span className="brand__title">{t('app.title')}</span>
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
          <div className="stack">
            <span className="dim">{t('home.bots.difficulty')}</span>
            <div className="seg">
              {BOT_LEVELS.map((level) => (
                <button
                  type="button"
                  key={level}
                  className="seg__opt"
                  aria-pressed={difficulty === level}
                  onClick={() => chooseDifficulty(level)}
                >
                  {t(`home.bots.level.${level}`)}
                </button>
              ))}
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

        {/* Learn to play: guided tutorial + practice puzzles (offline). */}
        <section className="mode-card">
          <div className="mode-card__head">
            <span className="mode-card__icon" aria-hidden="true">
              🎓
            </span>
            <div className="mode-card__text">
              <h3 className="mode-card__title">{t('learn.tutorialTitle')}</h3>
              <p className="dim mode-card__desc">{t('learn.homeDesc')}</p>
            </div>
          </div>
          <button type="button" onClick={() => navigate('/learn')}>
            {t('learn.homeAction')}
          </button>
        </section>

        {/* Device feedback: sound effects + haptics (this device only). */}
        <div className="panel stack">
          <div className="prefrow">
            <span>{t('home.prefs.sound')}</span>
            <div className="seg">
              <button
                type="button"
                className="seg__opt"
                aria-pressed={soundOn}
                onClick={() => setSoundOn(true)}
              >
                {t('common.on')}
              </button>
              <button
                type="button"
                className="seg__opt"
                aria-pressed={!soundOn}
                onClick={() => setSoundOn(false)}
              >
                {t('common.off')}
              </button>
            </div>
          </div>
          {canVibrate() && (
            <div className="prefrow">
              <span>{t('home.prefs.haptics')}</span>
              <div className="seg">
                <button
                  type="button"
                  className="seg__opt"
                  aria-pressed={hapticsOn}
                  onClick={() => setHapticsOn(true)}
                >
                  {t('common.on')}
                </button>
                <button
                  type="button"
                  className="seg__opt"
                  aria-pressed={!hapticsOn}
                  onClick={() => setHapticsOn(false)}
                >
                  {t('common.off')}
                </button>
              </div>
            </div>
          )}
        </div>

        <button type="button" className="btn--ghost" onClick={() => navigate('/history')}>
          {t('home.historyLink')}
        </button>

        <button type="button" className="btn--ghost" onClick={() => navigate('/rules')}>
          {t('home.rulesLink')}
        </button>

        <button type="button" className="btn--ghost" onClick={() => navigate('/privacy')}>
          {t('home.privacyLink')}
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
