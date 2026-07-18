/**
 * NotFound: the 404 screen for any URL that matches no route. The server serves
 * the SPA shell for unknown app paths (with a 404 status), so React Router's
 * catch-all lands here. Localized, in the app's own look, with one tap back to
 * the front page — never a dead-end browser error.
 */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ConnectionPill } from '../components/ConnectionPill';

/**
 * A scattered hand — three cards drifting apart, one face-down — the visual
 * cue for "this page went missing", in the game's four-colour deck.
 */
function LostCardsArt() {
  const cards = [
    { rank: 'A', suit: '♥', color: 'var(--card-red)', x: 62, rot: -16 },
    { rank: '?', suit: '', color: 'var(--text-dim)', x: 110, rot: 3, faceDown: true },
    { rank: '10', suit: '♦', color: 'var(--card-blue)', x: 158, rot: 17 },
  ];
  return (
    <svg className="empty-state__art" viewBox="0 0 220 168" role="img" aria-hidden="true">
      <ellipse cx="110" cy="104" rx="90" ry="50" fill="var(--gold)" opacity="0.1" />
      {cards.map((c) => (
        <g key={c.rank} transform={`translate(${c.x} 150) rotate(${c.rot})`}>
          <rect
            x="-33"
            y="-96"
            width="66"
            height="94"
            rx="8"
            fill={c.faceDown ? 'var(--card-back)' : 'var(--card-face)'}
            stroke="var(--card-border)"
            strokeWidth="1.5"
          />
          {c.faceDown ? (
            <text
              x="0"
              y="-42"
              fontSize="40"
              fontWeight="700"
              textAnchor="middle"
              fill="var(--gold)"
            >
              ?
            </text>
          ) : (
            <>
              <text x="-25" y="-73" fontSize="15" fontWeight="700" fill={c.color}>
                {c.rank}
              </text>
              <text x="-25.5" y="-59" fontSize="13" fill={c.color}>
                {c.suit}
              </text>
              <text x="0" y="-40" fontSize="34" textAnchor="middle" fill={c.color}>
                {c.suit}
              </text>
            </>
          )}
        </g>
      ))}
    </svg>
  );
}

export function NotFound() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('notFound.title')}</h1>
          <ConnectionPill />
        </div>
      </header>
      <main className="screen__main">
        <div className="empty-state">
          <LostCardsArt />
          <h2 className="empty-state__title">{t('notFound.heading')}</h2>
          <p className="empty-state__text">{t('notFound.text')}</p>
          <button
            type="button"
            className="btn--primary empty-state__cta"
            onClick={() => navigate('/')}
          >
            {t('notFound.home')}
          </button>
        </div>
      </main>
    </div>
  );
}
