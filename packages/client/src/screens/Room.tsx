/** /r/:code — connects to the room and routes Lobby vs Table by room status. */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { connect } from '../socket';
import { useStore } from '../store';
import { savedNickname } from './Home';
import { Lobby } from './Lobby';
import { Table } from './Table';

export function Room() {
  const { t } = useTranslation();
  const { code } = useParams<{ code: string }>();
  const status = useStore((s) => s.server.room?.status);

  useEffect(() => {
    if (code === undefined) return;
    const nickname = savedNickname();
    connect(code, undefined, nickname === '' ? undefined : nickname);
  }, [code]);

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
