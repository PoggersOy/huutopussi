/** /r/:code — connects to the room and routes Lobby vs Table by room status. */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { recordRecentRoom } from '../history';
import { connect, disconnect } from '../socket';
import { useStore } from '../store';
import { savedNickname } from './Home';
import { Lobby } from './Lobby';
import { Table } from './Table';

export function Room() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { code } = useParams<{ code: string }>();
  const status = useStore((s) => s.server.room?.status);
  const joinedCode = useStore((s) => s.server.room?.code);
  const fatal = useStore((s) => s.server.fatal);

  useEffect(() => {
    if (code === undefined) return;
    const nickname = savedNickname();
    connect(code, undefined, nickname === '' ? undefined : nickname);
  }, [code]);

  // Only rooms the server confirmed (welcome received) enter the recents list.
  useEffect(() => {
    if (joinedCode !== undefined) recordRecentRoom(joinedCode);
  }, [joinedCode]);

  // Terminal dead-end (room gone/full, session replaced, version): the socket
  // layer has stopped retrying, so show a way out instead of spinning forever.
  if (fatal !== null) {
    return (
      <div className="screen">
        <div
          className="screen__main stack"
          style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}
        >
          <p>{t(fatal)}</p>
          <button
            type="button"
            className="btn--primary"
            onClick={() => {
              disconnect();
              navigate('/');
            }}
          >
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  if (status === undefined) {
    return (
      <div className="screen">
        <div className="screen__main" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <p className="dim">{t('connection.connecting')}</p>
        </div>
      </div>
    );
  }
  return status === 'lobby' ? <Lobby /> : <Table />;
}
