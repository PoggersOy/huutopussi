import { useTranslation } from 'react-i18next';
import { useStore } from '../store';

/** Fixed top banner while a previously-established connection is down. */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const connected = useStore((s) => s.server.connected);
  const room = useStore((s) => s.server.room);
  if (connected || room === null) return null;
  return <div className="banner">{t('connection.reconnecting')}</div>;
}
