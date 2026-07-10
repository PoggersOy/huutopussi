/**
 * History: every match summary this device has received via 'history'
 * messages (persisted per room in localStorage), newest first. Live updates
 * while connected: a fresh 'history' message re-reads the persisted set.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ConnectionPill } from '../components/ConnectionPill';
import { MatchList } from '../components/MatchList';
import { loadAllHistory } from '../history';
import { useStore } from '../store';

export function History() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const live = useStore((s) => s.ui.history);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` is the refresh trigger — a new 'history' message means localStorage changed.
  const entries = useMemo(() => loadAllHistory(), [live]);

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('history.title')}</h1>
          <ConnectionPill />
        </div>
      </header>
      <main className="screen__main">
        {entries.length === 0 ? (
          <p className="dim" style={{ textAlign: 'center' }}>
            {t('history.empty')}
          </p>
        ) : (
          <div className="panel">
            <MatchList entries={entries} showRoom={true} />
          </div>
        )}
      </main>
      <footer className="screen__bottom">
        <button type="button" style={{ width: '100%' }} onClick={() => navigate('/')}>
          {t('common.back')}
        </button>
      </footer>
    </div>
  );
}
