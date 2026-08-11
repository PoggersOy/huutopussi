/**
 * Learning modes: a menu (LearnMenu) listing the guided tutorial + the practice
 * puzzles, and the player (LearnPlay) that starts an offline scenario and hands
 * off to the normal Table UI. Everything runs client-side via localMatch.ts; the
 * LearnGuide overlay (rendered by the Table) narrates each step.
 */
import { type ReactElement, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { exitLearn, startLearn } from '../localMatch';
import { PUZZLES, SCENARIOS, scenarioById } from '../scenarios';
import { Table } from './Table';

const TOPIC_ICON: Record<string, string> = {
  bidding: '📣',
  marriage: '💍',
  trick: '🃏',
  endgame: '👑',
};

export function LearnMenu(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tutorial = SCENARIOS.find((s) => s.kind === 'tutorial');

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="screen__topbar">
          <h1 className="brand">
            <span className="brand__title">{t('learn.menuTitle')}</span>
          </h1>
        </div>
        <p className="dim">{t('learn.menuIntro')}</p>
      </header>

      <main className="screen__main">
        {tutorial !== undefined && (
          <section className="mode-card">
            <div className="mode-card__head">
              <span className="mode-card__icon" aria-hidden="true">
                🎓
              </span>
              <div className="mode-card__text">
                <h3 className="mode-card__title">{t('learn.tutorialTitle')}</h3>
                <p className="dim mode-card__desc">{t('learn.tutorialDesc')}</p>
              </div>
            </div>
            <button
              type="button"
              className="btn--primary"
              onClick={() => navigate(`/opettele/${tutorial.id}`)}
            >
              {t('learn.start')}
            </button>
          </section>
        )}

        <h2 className="home-heading">{t('learn.puzzlesTitle')}</h2>

        {PUZZLES.map((p) => (
          <section key={p.id} className="mode-card">
            <div className="mode-card__head">
              <span className="mode-card__icon" aria-hidden="true">
                {TOPIC_ICON[p.topic] ?? '🧩'}
              </span>
              <div className="mode-card__text">
                <h3 className="mode-card__title">{t(`learn.scenarioTitle.${p.id}`)}</h3>
                <p className="dim mode-card__desc">{t(`learn.scenarioDesc.${p.id}`)}</p>
              </div>
            </div>
            <button type="button" onClick={() => navigate(`/opettele/${p.id}`)}>
              {t('learn.play')}
            </button>
          </section>
        ))}

        <Link className="btn btn--ghost" to="/">
          {t('common.back')}
        </Link>
      </main>
    </div>
  );
}

export function LearnPlay(): ReactElement | null {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const scenario = id !== undefined ? scenarioById(id) : undefined;

  useEffect(() => {
    if (scenario === undefined) {
      navigate('/opettele', { replace: true });
      return;
    }
    startLearn(scenario);
    return () => exitLearn();
  }, [scenario, navigate]);

  if (scenario === undefined) return null;
  return <Table />;
}
