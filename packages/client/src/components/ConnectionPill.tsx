import { useTranslation } from 'react-i18next';
import { useStore } from '../store';

/**
 * Compact connection-status pill shared across screens (Home/Lobby/History).
 * Green dot = live socket; amber pulsing dot = connecting/reconnecting.
 * Hidden before any connection has been attempted (nothing to report).
 */
export function ConnectionPill() {
  const { t } = useTranslation();
  const connected = useStore((s) => s.server.connected);
  const hasRoom = useStore((s) => s.server.room !== null);
  if (!connected && !hasRoom) return null;
  return (
    <span className={`pill ${connected ? 'pill--ok' : 'pill--warn'}`}>
      <span className="pill__dot" aria-hidden="true" />
      {t(connected ? 'connection.connected' : 'connection.connecting')}
    </span>
  );
}
