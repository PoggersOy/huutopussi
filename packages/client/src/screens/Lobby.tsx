/**
 * Lobby (room status 'lobby'): 4 seat cards around a mini felt table, share
 * block (link + copy + native share), host-editable rules panel bound to the
 * protocol's configPatchSchema fields, past matches of this room, and the
 * host's Start button. Non-hosts see the config read-only. All legality/
 * authority stays server-side — every control just submits a lobby command.
 */
import type { RuleConfig, Seat } from '@hp/engine';
import type { ConfigPatch, RoomStatePublic, SeatInfo } from '@hp/protocol';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionPill } from '../components/ConnectionPill';
import { MatchList } from '../components/MatchList';
import { loadRoomHistory } from '../history';
import { sendLobby } from '../socket';
import { useStore } from '../store';

export function Lobby() {
  const { t } = useTranslation();
  const room = useStore((s) => s.server.room);
  const mySeat = useStore((s) => s.server.seat);
  if (room === null) return null;

  const isHost = mySeat !== null && room.hostSeat === mySeat;
  const allSeated = room.seats.every((seat) => seat.kind !== 'empty');

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
        <ConfigPanel config={room.config} isHost={isHost} />
        <PastMatches roomCode={room.code} />
      </main>
      <footer className="screen__bottom stack" style={{ gap: 'var(--space-2)' }}>
        {isHost ? (
          <>
            <button
              type="button"
              className="btn--primary"
              style={{ width: '100%' }}
              disabled={!allSeated}
              onClick={() => sendLobby({ type: 'startMatch' })}
            >
              {t('lobby.start')}
            </button>
            {!allSeated && (
              <p className="dim" style={{ textAlign: 'center' }}>
                {t('lobby.needFourPlayers')}
              </p>
            )}
          </>
        ) : (
          <p className="dim" style={{ textAlign: 'center' }}>
            {t('lobby.waitingForHost')}
          </p>
        )}
      </footer>
    </div>
  );
}

// ── Mini table: 4 seat cards around a felt oval ──────────────────────────────

function MiniTable({
  room,
  mySeat,
  isHost,
}: {
  room: RoomStatePublic;
  mySeat: Seat | null;
  isHost: boolean;
}) {
  // Rotate so the viewer sits at the bottom (partner across, like at a table).
  const bottom = mySeat ?? 0;
  const at = (offset: number): SeatInfo => room.seats[(bottom + offset) % 4] as SeatInfo;

  const card = (info: SeatInfo, area: string) => (
    <div style={{ gridArea: area }} className="lobby-table__slot">
      <SeatCard info={info} mySeat={mySeat} hostSeat={room.hostSeat} viewerIsHost={isHost} />
    </div>
  );

  return (
    <div className="lobby-table">
      {card(at(2), 'top')}
      {card(at(1), 'left')}
      <div className="lobby-table__felt" style={{ gridArea: 'center' }} aria-hidden="true" />
      {card(at(3), 'right')}
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
  const isMe = info.seat === mySeat;
  const name = info.kind === 'bot' ? (info.nickname ?? t('lobby.bot')) : (info.nickname ?? '—');

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
        <strong className="seat-card__name">{name}</strong>
      )}
      {badges.length > 0 && <span className="dim seat-card__badges">{badges.join(' · ')}</span>}
      <div className="seat-card__actions">
        {info.kind === 'empty' && (
          <button type="button" onClick={() => sendLobby({ type: 'takeSeat', seat: info.seat })}>
            {t('lobby.takeSeat')}
          </button>
        )}
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
        {isMe && (
          <button
            type="button"
            className="btn--ghost"
            onClick={() => sendLobby({ type: 'leaveSeat' })}
          >
            {t('lobby.leaveSeat')}
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

// ── Rules config panel (configPatchSchema fields; host-editable) ─────────────

const MIN_BID_OPTIONS = [0, 25, 50, 75, 100, 150, 200];
const WIN_TARGET_OPTIONS = [250, 500, 750, 1000];

function numberOptions(base: readonly number[], current: number): number[] {
  return base.includes(current) ? [...base] : [...base, current].sort((a, b) => a - b);
}

function ConfigPanel({ config, isHost }: { config: RuleConfig; isHost: boolean }) {
  const { t } = useTranslation();
  const patch = (p: ConfigPatch): void => {
    sendLobby({ type: 'setConfig', patch: p });
  };

  return (
    <section className="panel stack">
      <h2 style={{ fontSize: 'var(--fs-md)' }}>{t('lobby.config')}</h2>
      {!isHost && <p className="dim">{t('config.hostOnly')}</p>}

      <label className="config-row">
        <span>{t('config.cardPoints')}</span>
        <select
          value={config.cardPoints}
          disabled={!isHost}
          onChange={(e) => patch({ cardPoints: e.target.value as 'A' | 'B' })}
        >
          <option value="A">{t('config.cardPointsA')}</option>
          <option value="B">{t('config.cardPointsB')}</option>
        </select>
      </label>

      <label className="config-row">
        <span>{t('config.trumpValues')}</span>
        <select
          value={config.trumpValues}
          disabled={!isHost}
          onChange={(e) => patch({ trumpValues: e.target.value as 'heartsHigh' | 'bridge' })}
        >
          <option value="heartsHigh">{t('config.trumpValuesHeartsHigh')}</option>
          <option value="bridge">{t('config.trumpValuesBridge')}</option>
        </select>
      </label>

      <label className="config-row">
        <span>{t('config.minBid')}</span>
        <select
          value={config.minBid}
          disabled={!isHost}
          onChange={(e) => patch({ minBid: Number(e.target.value) })}
        >
          {numberOptions(MIN_BID_OPTIONS, config.minBid).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <label className="config-row">
        <span>{t('config.winTarget')}</span>
        <select
          value={config.winTarget}
          disabled={!isHost}
          onChange={(e) => patch({ winTarget: Number(e.target.value) })}
        >
          {numberOptions(WIN_TARGET_OPTIONS, config.winTarget).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <label className="config-row">
        <span>{t('config.declareRight')}</span>
        <select
          value={config.declareRight}
          disabled={!isHost}
          onChange={(e) =>
            patch({ declareRight: e.target.value as 'ownLedWonTrick' | 'anyWonTrick' })
          }
        >
          <option value="ownLedWonTrick">{t('config.declareRightOwnLedWonTrick')}</option>
          <option value="anyWonTrick">{t('config.declareRightAnyWonTrick')}</option>
        </select>
      </label>

      <label className="config-row">
        <span>{t('config.showLastTrick')}</span>
        <input
          type="checkbox"
          checked={config.showLastTrick}
          disabled={!isHost}
          onChange={(e) => patch({ showLastTrick: e.target.checked })}
        />
      </label>
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
