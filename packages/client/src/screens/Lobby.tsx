/** Lobby: seats + add bot + start. Placeholder screen (replaced next phase). */
import type { SeatInfo } from '@hp/protocol';
import { useTranslation } from 'react-i18next';
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
        <h1>{t('lobby.title')}</h1>
        <p className="dim">
          {t('lobby.shareHint')} <strong style={{ letterSpacing: '0.2em' }}>{room.code}</strong>
        </p>
      </header>
      <main className="screen__main">
        {room.seats.map((seat) => (
          <SeatRow key={seat.seat} seat={seat} mySeat={mySeat} hostSeat={room.hostSeat} />
        ))}
        <details>
          <summary className="dim">{t('lobby.config')}</summary>
          <pre className="raw">{JSON.stringify(room.config, null, 2)}</pre>
        </details>
      </main>
      <footer className="screen__bottom">
        {isHost ? (
          <button
            type="button"
            className="btn--primary"
            style={{ width: '100%' }}
            disabled={!allSeated}
            onClick={() => sendLobby({ type: 'startMatch' })}
          >
            {t('lobby.start')}
          </button>
        ) : (
          <p className="dim" style={{ textAlign: 'center' }}>
            {t('lobby.waitingForHost')}
          </p>
        )}
      </footer>
    </div>
  );
}

function SeatRow({
  seat,
  mySeat,
  hostSeat,
}: {
  seat: SeatInfo;
  mySeat: number | null;
  hostSeat: number | null;
}) {
  const { t } = useTranslation();
  const isMe = seat.seat === mySeat;

  return (
    <div className="panel row" style={{ justifyContent: 'space-between' }}>
      <div className="stack" style={{ gap: 'var(--space-1)' }}>
        <span className="dim">{t('table.seat', { seat: seat.seat + 1 })}</span>
        {seat.kind === 'empty' ? (
          <span className="dim">{t('lobby.empty')}</span>
        ) : (
          <strong>
            {seat.nickname ?? '—'}
            {isMe && ` (${t('common.you')})`}
          </strong>
        )}
        <span className="dim">
          {seat.kind === 'bot' && t('lobby.bot')}
          {seat.seat === hostSeat && ` · ${t('lobby.host')}`}
          {seat.kind === 'human' && !seat.connected && ` · ${t('lobby.disconnected')}`}
          {seat.botControlled && ` · ${t('lobby.botControlled')}`}
        </span>
      </div>
      <div className="row">
        {seat.kind === 'empty' && (
          <>
            <button type="button" onClick={() => sendLobby({ type: 'takeSeat', seat: seat.seat })}>
              {t('lobby.takeSeat')}
            </button>
            <button
              type="button"
              className="btn--ghost"
              onClick={() => sendLobby({ type: 'addBot', seat: seat.seat })}
            >
              {t('lobby.addBot')}
            </button>
          </>
        )}
        {seat.kind === 'bot' && (
          <button
            type="button"
            className="btn--ghost"
            onClick={() => sendLobby({ type: 'removeBot', seat: seat.seat })}
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
