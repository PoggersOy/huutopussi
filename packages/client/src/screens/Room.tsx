/** /r/:code — connects to the room and routes Lobby vs Table by room status. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { recordRecentRoom } from '../history';
import { connect, disconnect, loadSessionToken } from '../socket';
import { useStore } from '../store';
import { savedNickname, storeNickname } from './Home';
import { Lobby } from './Lobby';
import { Table } from './Table';

export function Room() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { code } = useParams<{ code: string }>();
  const status = useStore((s) => s.server.room?.status);
  const joinedCode = useStore((s) => s.server.room?.code);
  const fatal = useStore((s) => s.server.fatal);

  // Force a name on every JOIN so nobody sits down nameless (rendered "—").
  // The gate shows for a fresh join (no session token for this room yet) and is
  // pre-filled with any saved nickname; it's skipped for a reconnect/reload and
  // for the host arriving from room creation — both already hold a session token.
  const [nick, setNick] = useState(savedNickname);
  const [joining, setJoining] = useState(
    () => code !== undefined && loadSessionToken(code) !== null,
  );

  useEffect(() => {
    if (code === undefined || !joining) return;
    const saved = savedNickname().trim();
    connect(code, undefined, saved === '' ? undefined : saved);
  }, [code, joining]);

  // Only rooms the server confirmed (welcome received) enter the recents list.
  useEffect(() => {
    if (joinedCode !== undefined) recordRecentRoom(joinedCode);
  }, [joinedCode]);

  // Nickname gate: entering/confirming a name is required before a fresh join.
  if (!joining) {
    const submit = (): void => {
      if (nick.trim() === '') return;
      storeNickname(nick);
      setJoining(true);
    };
    return (
      <div className="screen">
        <div
          className="screen__main stack"
          style={{ justifyContent: 'center', alignItems: 'center' }}
        >
          <form
            className="panel stack"
            style={{ width: 'min(360px, 100%)' }}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <h2>{t('room.joinTitle', { code })}</h2>
            <label className="stack">
              <span className="dim">{t('home.nickname')}</span>
              <input
                value={nick}
                onChange={(e) => setNick(e.target.value)}
                placeholder={t('home.nicknamePlaceholder')}
                maxLength={20}
                autoComplete="nickname"
                // biome-ignore lint/a11y/noAutofocus: single-purpose join gate
                autoFocus
              />
            </label>
            <button type="submit" className="btn--primary" disabled={nick.trim() === ''}>
              {t('room.joinAction')}
            </button>
            <button type="button" className="btn--ghost" onClick={() => navigate('/')}>
              {t('common.back')}
            </button>
          </form>
        </div>
      </div>
    );
  }

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
