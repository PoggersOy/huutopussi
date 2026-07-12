/**
 * Lobby (room status 'lobby'): 4 seat cards around a mini felt table, share
 * block (link + copy + native share), host-editable rules panel bound to the
 * protocol's configPatchSchema fields, past matches of this room, and the
 * host's Start button. Non-hosts see the config read-only. All legality/
 * authority stays server-side — every control just submits a lobby command.
 */
import type { RuleConfig, Seat } from '@hp/engine';
import type { RoomStatePublic, SeatInfo, TableSettings, TableSettingsPatch } from '@hp/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useBotName } from '../botNames';
import { ConnectionPill } from '../components/ConnectionPill';
import { MatchList } from '../components/MatchList';
import { RatingBadge } from '../components/RatingBadge';
import { TitleBadge } from '../components/TitleBadge';
import { loadRoomHistory } from '../history';
import { configMatches, DEFAULT_CONFIG, RuleSections, resolveConfigForPlayers } from '../rules';
import { disconnect, sendLobby } from '../socket';
import { useStore } from '../store';

export function Lobby() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const room = useStore((s) => s.server.room);
  const mySeat = useStore((s) => s.server.seat);
  const pushToast = useStore((s) => s.pushToast);
  if (room === null) return null;

  const isHost = mySeat !== null && room.hostSeat === mySeat;
  // Matchmade rooms show a simplified "searching / waiting" view (no share/
  // config/seat-picking) — the server auto-seats and auto-starts. (Truthy check:
  // private rooms send null, and older snapshots may omit the field entirely.)
  if (room.matchmaking) {
    return <MatchmakingWaiting room={room} isHost={isHost} />;
  }
  // Defensive slice: only config.players seats are active (protocol sends that
  // many, but a stale 4-entry snapshot must not block a 2-3p start).
  const activeSeatInfos = room.seats.slice(0, room.config.players);
  const allSeated = activeSeatInfos.every((seat) => seat.kind !== 'empty');

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('lobby.title')}</h1>
          <ConnectionPill />
        </div>
        <p className="dim">
          {t('lobby.shareHint')} <strong className="room-code">{room.code}</strong>
        </p>
      </header>
      <main className="screen__main">
        <MiniTable room={room} mySeat={mySeat} isHost={isHost} />
        <ShareBlock code={room.code} />
        <ConfigPanel config={room.config} configName={room.configName} isHost={isHost} />
        <TableSettingsPanel settings={room.tableSettings} isHost={isHost} />
        <PastMatches roomCode={room.code} />
      </main>
      <footer className="screen__bottom stack" style={{ gap: 'var(--space-2)' }}>
        {isHost ? (
          // The Start button stays pressable while seats are empty so a tap can
          // explain WHY it's blocked — a truly `disabled` button swallows the
          // click and the guidance with it. aria-disabled carries the greyed
          // look (see base.css) + the a11y state without eating the press.
          <button
            type="button"
            className="btn--primary"
            style={{ width: '100%' }}
            aria-disabled={!allSeated}
            onClick={() =>
              allSeated
                ? sendLobby({ type: 'startMatch' })
                : pushToast({ kind: 'info', code: 'lobby.needAllSeats' })
            }
          >
            {t('lobby.start')}
          </button>
        ) : (
          <p className="dim" style={{ textAlign: 'center' }}>
            {t('lobby.waitingForHost')}
          </p>
        )}
        {/* An escape hatch for everyone: never trap a guest in a lobby whose host
            never starts (leaving drops the seat; the browser back button alone
            shouldn't be the only way out). */}
        <button
          type="button"
          className="btn--ghost"
          style={{ width: '100%' }}
          onClick={() => {
            disconnect();
            navigate('/');
          }}
        >
          {t('overlay.backToMenu')}
        </button>
      </footer>
    </div>
  );
}

// ── Matchmaking: searching / waiting view ────────────────────────────────────

function MatchmakingWaiting({ room, isHost }: { room: RoomStatePublic; isHost: boolean }) {
  const { t } = useTranslation();
  const botName = useBotName();
  const navigate = useNavigate();
  const players = room.config.players;
  const seats = room.seats.slice(0, players);
  const filled = seats.filter((s) => s.kind !== 'empty').length;
  const ranked = room.matchmaking?.ranked === true;
  const modeLabel = `${ranked ? t('matchmaking.ranked') : t('matchmaking.unranked')} · ${t(
    'config.playersOpt',
    { n: players },
  )}`;

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('matchmaking.title')}</h1>
          <ConnectionPill />
        </div>
        <p className="dim">{modeLabel}</p>
      </header>
      <main className="screen__main">
        <div className="panel stack mm-wait">
          <p className="mm-wait__status" aria-live="polite">
            {t('matchmaking.searching')}
          </p>
          <p className="mm-wait__progress">
            {t('matchmaking.progress', { filled, total: players })}
          </p>
          <ul className="mm-wait__players">
            {seats.map((s) => (
              <li key={s.seat} className="mm-wait__player">
                {s.kind === 'empty' ? (
                  <span className="dim">{t('matchmaking.waiting')}</span>
                ) : (
                  <span>
                    {s.kind === 'bot' ? (botName(s.seat) ?? t('lobby.bot')) : (s.nickname ?? '—')}
                    {s.kind === 'human' && (
                      <RatingBadge rating={s.rating} provisional={s.provisional} />
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </main>
      <footer className="screen__bottom stack" style={{ gap: 'var(--space-2)' }}>
        {isHost && (
          <>
            <button
              type="button"
              className="btn--ghost"
              style={{ width: '100%' }}
              onClick={() => sendLobby({ type: 'fillBotsAndStart' })}
            >
              {t('matchmaking.startWithBots')}
            </button>
            <p className="dim" style={{ textAlign: 'center' }}>
              {t('matchmaking.unrankedNote')}
            </p>
          </>
        )}
        <button
          type="button"
          className="btn--danger"
          style={{ width: '100%' }}
          onClick={() => {
            disconnect();
            navigate('/');
          }}
        >
          {t('matchmaking.leave')}
        </button>
      </footer>
    </div>
  );
}

// ── Mini table: config.players seat cards around a felt oval ─────────────────

function MiniTable({
  room,
  mySeat,
  isHost,
}: {
  room: RoomStatePublic;
  mySeat: Seat | null;
  isHost: boolean;
}) {
  const players = room.config.players;
  const seats = room.seats.slice(0, players);
  // Rotate so the viewer sits at the bottom (4p: partner across, like at a table).
  const bottom = mySeat !== null && mySeat < players ? mySeat : 0;
  const at = (offset: number): SeatInfo => seats[(bottom + offset) % players] as SeatInfo;

  const card = (info: SeatInfo, area: string) => (
    <div key={area} style={{ gridArea: area }} className="lobby-table__slot">
      <SeatCard info={info} mySeat={mySeat} hostSeat={room.hostSeat} viewerIsHost={isHost} />
    </div>
  );

  return (
    <div className="lobby-table">
      {players === 4 && card(at(2), 'top')}
      {players === 2 && card(at(1), 'top')}
      {players >= 3 && card(at(1), 'left')}
      <div className="lobby-table__felt" style={{ gridArea: 'center' }} aria-hidden="true" />
      {players === 4 && card(at(3), 'right')}
      {players === 3 && card(at(2), 'right')}
      {card(at(0), 'bottom')}
    </div>
  );
}

function SeatCard({
  info,
  mySeat,
  hostSeat,
  viewerIsHost,
}: {
  info: SeatInfo;
  mySeat: Seat | null;
  hostSeat: Seat | null;
  viewerIsHost: boolean;
}) {
  const { t } = useTranslation();
  const botName = useBotName();
  const isMe = info.seat === mySeat;
  const name =
    info.kind === 'bot' ? (botName(info.seat) ?? t('lobby.bot')) : (info.nickname ?? '—');

  const badges: string[] = [];
  if (info.seat === hostSeat) badges.push(t('lobby.host'));
  if (isMe) badges.push(t('common.you'));
  if (info.kind === 'bot') badges.push(t('lobby.bot'));
  if (info.kind === 'human' && !info.connected) badges.push(t('lobby.disconnected'));
  if (info.botControlled) badges.push(t('lobby.botControlled'));

  return (
    <div className={`seat-card${isMe ? ' seat-card--me' : ''}`}>
      <span
        className={`avatar${info.kind === 'bot' ? ' avatar--bot' : ''}${
          info.kind === 'empty' ? ' avatar--empty' : ''
        }`}
        aria-hidden="true"
      >
        {info.kind === 'empty' ? '+' : name.charAt(0).toUpperCase()}
      </span>
      {info.kind === 'empty' ? (
        <span className="dim">{t('lobby.empty')}</span>
      ) : (
        <strong className="seat-card__name">
          {name}
          {info.kind === 'human' && (
            <RatingBadge rating={info.rating} provisional={info.provisional} />
          )}
          {info.kind === 'human' && (
            <TitleBadge rating={info.rating} provisional={info.provisional} />
          )}
        </strong>
      )}
      {badges.length > 0 && <span className="dim seat-card__badges">{badges.join(' · ')}</span>}
      {/* Seats are server-assigned (the host is always at the bottom, guests are
          auto-seated on join) — there's no seat picker. The host still fills or
          frees the remaining seats with bots. */}
      <div className="seat-card__actions">
        {info.kind === 'empty' && viewerIsHost && (
          <button
            type="button"
            className="btn--ghost"
            onClick={() => sendLobby({ type: 'addBot', seat: info.seat })}
          >
            {t('lobby.addBot')}
          </button>
        )}
        {info.kind === 'bot' && viewerIsHost && (
          <button
            type="button"
            className="btn--ghost"
            onClick={() => sendLobby({ type: 'removeBot', seat: info.seat })}
          >
            {t('lobby.removeBot')}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Share block: link + copy + native share ─────────────────────────────────

function ShareBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const pushToast = useStore((s) => s.pushToast);
  const url = `${location.origin}/r/${code}`;
  const canNativeShare = typeof navigator.share === 'function';

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ kind: 'info', code: 'lobby.linkCopied' });
    } catch {
      pushToast({ kind: 'error', code: 'lobby.copyFailed' });
    }
  }

  function onShare(): void {
    navigator.share({ title: t('app.title'), url }).catch(() => {
      // User cancelled the share sheet — not an error.
    });
  }

  return (
    <section className="panel stack">
      <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('lobby.share')}</h2>
      <input
        readOnly
        value={url}
        className="share-url"
        aria-label={t('lobby.share')}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="row">
        <button type="button" onClick={() => void onCopy()}>
          {t('lobby.copyLink')}
        </button>
        {canNativeShare && (
          <button type="button" className="btn--ghost" onClick={onShare}>
            {t('lobby.shareLink')}
          </button>
        )}
      </div>
    </section>
  );
}

// ── Rules config panel: player count + saved-config picker (host-editable) ────

/**
 * The lobby's rules control. The host picks the player count (2/3/4) and a rule
 * configuration from a dropdown — the built-in "Oletus" plus any the account
 * saved in their profile. There is no per-field editing here: full customization
 * lives in the profile. Everyone sees the active config's name and can open the
 * "view all rules" overlay for the complete, always-accurate picture. The turn
 * timer is a SEPARATE panel (TableSettingsPanel), not a rule.
 */
function ConfigPanel({
  config,
  configName,
  isHost,
}: {
  config: RuleConfig;
  configName: string | null;
  isHost: boolean;
}) {
  const { t } = useTranslation();
  const [showAllRules, setShowAllRules] = useState(false);
  const savedConfigs = useStore((s) => s.auth.ruleConfigs);
  const players = config.players;

  // Built-in "Oletus" (id '') + the account's saved configs. The active entry is
  // whichever the live room config currently resolves to (mode fields aside).
  const options = useMemo(
    () => [{ id: '', name: t('config.default'), config: DEFAULT_CONFIG }, ...savedConfigs],
    [savedConfigs, t],
  );
  const activeId = options.find((o) => configMatches(config, o.config))?.id ?? null;
  // A named config not in the list (e.g. edited/deleted after use) shows as a
  // disabled placeholder; an unnamed unmatched config is just the default.
  const unmatchedNamed = activeId === null && configName !== null;
  const selectValue = activeId ?? (unmatchedNamed ? '__current__' : '');

  const send = (
    opt: { id: string; name: string; config: RuleConfig },
    nextPlayers: 2 | 3 | 4,
  ): void => {
    sendLobby({
      type: 'setConfig',
      patch: resolveConfigForPlayers(opt.config, nextPlayers),
      configName: opt.id === '' ? null : opt.name,
    });
  };

  return (
    <section className="panel stack">
      <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('lobby.config')}</h2>
      {!isHost && <p className="dim">{t('config.hostOnly')}</p>}

      <label className="config-row">
        <span>{t('config.players')}</span>
        <select
          value={players}
          disabled={!isHost}
          onChange={(e) => {
            const next = Number(e.target.value) as 2 | 3 | 4;
            const cur = options.find((o) => o.id === (activeId ?? '')) ?? options[0];
            if (cur) send(cur, next);
          }}
        >
          {([2, 3, 4] as const).map((n) => (
            <option key={n} value={n}>
              {t('config.playersOpt', { n })}
            </option>
          ))}
        </select>
      </label>

      {/* A div (not a label): the non-host branch renders plain text, not a
          form control, and the host select carries its own aria-label. */}
      <div className="config-row">
        <span>{t('config.ruleset')}</span>
        {isHost ? (
          <select
            aria-label={t('config.ruleset')}
            value={selectValue}
            onChange={(e) => {
              const chosen = options.find((o) => o.id === e.target.value);
              if (chosen) send(chosen, players);
            }}
          >
            {unmatchedNamed && (
              <option value="__current__" disabled>
                {configName}
              </option>
            )}
            {options.map((o) => (
              <option key={o.id || 'default'} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <strong>{configName ?? t('config.default')}</strong>
        )}
      </div>

      <button type="button" className="rules-link" onClick={() => setShowAllRules(true)}>
        {t('config.viewAll')}
      </button>

      {showAllRules && (
        <AllRulesOverlay
          config={config}
          configName={configName}
          onClose={() => setShowAllRules(false)}
        />
      )}
    </section>
  );
}

// ── "View all rules" overlay: the full ruleset, read-only ────────────────────

/**
 * The full, honest picture of what will actually be played: every RuleConfig
 * field, grouped and derived from the LIVE config (see ../rules RuleSections —
 * shared with the standalone Peliohjeet screen). The lobby panel only exposes a
 * handful of fields; this overlay shows all of them.
 */
function AllRulesOverlay({
  config,
  configName,
  onClose,
}: {
  config: RuleConfig;
  configName: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  // Dismiss on Escape, mirroring the click-outside affordance below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rulesetLabel = configName ?? t('config.default');

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users dismiss via Escape (handled above) or the × / Close buttons; this is the click-outside touch affordance
    <div
      className="rules-overlay"
      role="dialog"
      aria-modal="true"
      // Click the dimmed backdrop (but not the panel) to dismiss.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="rules-overlay__panel stack">
        <button
          type="button"
          className="btn--ghost rules-overlay__close"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          ✕
        </button>
        <h2>{t('rules.title')}</h2>
        <p className="dim rules-overlay__preset">{rulesetLabel}</p>
        <RuleSections config={config} />
        <button type="button" className="btn--primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

// ── Turn timer panel (tableSettingsPatchSchema; host-editable) ───────────────

const TIMEOUT_OPTIONS = [30, 45, 60, 90, 120, 180];

/** Base option list plus `current` if it isn't already one of them (sorted). */
function numberOptions(base: readonly number[], current: number): number[] {
  return base.includes(current) ? [...base] : [...base, current].sort((a, b) => a - b);
}

/**
 * Autoplay + per-turn time limit. These are turn PACING, not game rules (the
 * engine is timer-free), so they live on RoomStatePublic.tableSettings — a
 * channel separate from configPatchSchema — and may be changed mid-match.
 */
function TableSettingsPanel({ settings, isHost }: { settings: TableSettings; isHost: boolean }) {
  const { t } = useTranslation();
  const patch = (p: TableSettingsPatch): void => {
    sendLobby({ type: 'setTableSettings', patch: p });
  };

  return (
    <section className="panel stack">
      <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('tableSettings.title')}</h2>
      {!isHost && <p className="dim">{t('tableSettings.hostOnly')}</p>}

      <label className="config-row">
        <span>{t('tableSettings.autoplay')}</span>
        <select
          value={settings.autoplay ? 'on' : 'off'}
          disabled={!isHost}
          onChange={(e) => patch({ autoplay: e.target.value === 'on' })}
        >
          <option value="on">{t('tableSettings.autoplayOn')}</option>
          <option value="off">{t('tableSettings.autoplayOff')}</option>
        </select>
      </label>

      <label className="config-row">
        <span>{t('tableSettings.turnTimeout')}</span>
        <select
          value={settings.turnTimeoutSec}
          disabled={!isHost || !settings.autoplay}
          onChange={(e) => patch({ turnTimeoutSec: Number(e.target.value) })}
        >
          {numberOptions(TIMEOUT_OPTIONS, settings.turnTimeoutSec).map((n) => (
            <option key={n} value={n}>
              {t('tableSettings.seconds', { n })}
            </option>
          ))}
        </select>
      </label>

      <p className="dim tsettings__hint">
        {settings.autoplay
          ? t('tableSettings.hintOn', { n: settings.turnTimeoutSec })
          : t('tableSettings.hintOff')}
      </p>
    </section>
  );
}

// ── Past matches of this room ────────────────────────────────────────────────

function PastMatches({ roomCode }: { roomCode: string }) {
  const { t } = useTranslation();
  const live = useStore((s) => s.ui.history);
  const matches = useMemo(() => live ?? loadRoomHistory(roomCode), [live, roomCode]);
  if (matches.length === 0) return null;
  return (
    <section className="panel stack">
      <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('lobby.pastMatches')}</h2>
      <MatchList entries={matches.map((match) => ({ roomCode, match }))} showRoom={false} />
    </section>
  );
}
