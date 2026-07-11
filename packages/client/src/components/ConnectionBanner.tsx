import { useTranslation } from 'react-i18next';
import { useStore } from '../store';

/** Fixed top banner while a previously-established connection is down. */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const connected = useStore((s) => s.server.connected);
  const room = useStore((s) => s.server.room);
  const fatal = useStore((s) => s.server.fatal);
  // `fatal` means the socket layer has given up retrying and a dead-end screen
  // is showing (e.g. the host closed the room). Don't promise a reconnect on
  // top of it.
  if (connected || room === null || fatal !== null) return null;
  return <div className="banner">{t('connection.reconnecting')}</div>;
}
