/**
 * The learning-mode guidance layer, rendered by the Table while a learn session
 * is active (store `ui.learn`). Two parts:
 *  - a persistent banner with the scenario's goal + a BIG, phase-specific
 *    instruction for what to do right now (the "isot vaihekohtaiset ohjeet");
 *  - a completion overlay when the deal is scored (win/goal feedback, läpäri
 *    celebration, retry / back to the menu).
 *
 * Instruction text falls back scenario → common → generic via i18next key
 * arrays, so most content lives in the catalogues, not here.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { startLearn } from '../localMatch';
import { scenarioById } from '../scenarios';
import { type LearnSession, useStore } from '../store';
import { Confetti } from './Confetti';

export function LearnGuide(): ReactElement | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const learn = useStore((s) => s.ui.learn);
  const view = useStore((s) => s.server.view);
  const turn = useStore((s) => s.server.turn);
  const seat = useStore((s) => s.server.seat);

  if (learn === null) return null;

  if (learn.status === 'complete') {
    return (
      <Completion
        learn={learn}
        onRetry={() => {
          const sc = scenarioById(learn.scenarioId);
          if (sc !== undefined) startLearn(sc);
        }}
        onBack={() => navigate('/learn')}
      />
    );
  }

  const id = learn.scenarioId;
  const phase = view?.deal?.phase.name ?? null;
  const myTurn = seat !== null && turn !== null && turn.seat === seat;
  const bodyKeys =
    phase !== null && myTurn
      ? [`learn.${id}.${phase}`, `learn.common.${phase}`, 'learn.common.act']
      : ['learn.common.wait'];

  return (
    <div className={`learn-guide${myTurn ? ' learn-guide--act' : ''}`}>
      <div className="learn-guide__goal">{t(`learn.${id}.goal`)}</div>
      <div className="learn-guide__body">{t(bodyKeys)}</div>
      <button
        type="button"
        className="learn-guide__exit"
        onClick={() => navigate('/learn')}
        aria-label={t('learn.exit')}
      >
        ✕
      </button>
    </div>
  );
}

function Completion({
  learn,
  onRetry,
  onBack,
}: {
  learn: LearnSession;
  onRetry: () => void;
  onBack: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const view = useStore((s) => s.server.view);
  // Hold the overlay back briefly so the final trick + any läpäri sweep are seen.
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 1_400);
    return () => clearTimeout(timer);
  }, []);
  if (!show) return null;

  const result =
    view?.deal !== null && view?.deal !== undefined && view.deal.phase.name === 'scored'
      ? view.deal.phase.result
      : null;
  const total = result ? result.sides.reduce((a, s) => a + s.tricks, 0) : 0;
  const laapari = result !== null && total > 0 && result.sides.some((s) => s.tricks === total);
  const tutorial = learn.kind === 'tutorial';
  const won = learn.won;
  const celebrate = tutorial || won === true;

  const title = tutorial
    ? t('learn.done.tutorialTitle')
    : won
      ? t('learn.done.winTitle')
      : t('learn.done.loseTitle');
  const body = tutorial
    ? t('learn.done.tutorialBody')
    : won
      ? t([`learn.${learn.scenarioId}.doneWin`, 'learn.done.winBody'])
      : t([`learn.${learn.scenarioId}.doneLose`, 'learn.done.loseBody']);

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      {celebrate && <Confetti count={laapari ? 100 : 60} />}
      <div className="overlay__panel stack">
        {laapari && celebrate && (
          <div className="laapari">
            <span className="laapari__word">{t('overlay.laapari')}</span>
          </div>
        )}
        <h2 className={celebrate ? 'overlay__win' : undefined}>{title}</h2>
        <p className="tsheet__center">{body}</p>
        <button type="button" className="btn--primary tsheet__big" onClick={onRetry}>
          {t('learn.retry')}
        </button>
        <button type="button" className="btn--ghost" onClick={onBack}>
          {t('learn.backToMenu')}
        </button>
      </div>
    </div>
  );
}
