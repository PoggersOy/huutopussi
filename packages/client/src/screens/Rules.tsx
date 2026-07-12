/**
 * Rules ("Peliohjeet"): a standalone, always-accurate rules reference reachable
 * from the front page. Two halves:
 *   1. A friendly "how the game works" walkthrough (objective → cards → bidding
 *      → exchange → play → marriages → scoring) — the shared narrative common to
 *      both rulesets.
 *   2. A ruleset explorer: pick a preset (Illisoft 2002 / päämuoto) and a table
 *      size, and see the EXACT settings that will be played — rendered by the
 *      same <RuleSections> the lobby uses, from the real preset configs. So this
 *      page can never drift from what the engine actually does.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ConnectionPill } from '../components/ConnectionPill';
import { type Preset, presetConfig, RuleSections } from '../rules';

/** The A 10 K Q J 9 8 7 6 rank order (10 beats the King — a classic gotcha). */
const RANK_ORDER = ['A', '10', 'K', 'Q', 'J', '9', '8', '7', '6'] as const;

/** Marriage / trump-declaration values, hearts-high (the default order). */
const SUIT_VALUES: ReadonlyArray<{ symbol: string; color: string; value: number }> = [
  { symbol: '♥', color: 'var(--suit-red)', value: 100 },
  { symbol: '♦', color: 'var(--suit-blue)', value: 80 },
  { symbol: '♣', color: 'var(--suit-green)', value: 60 },
  { symbol: '♠', color: 'var(--suit-black)', value: 40 },
];

/**
 * How-to steps, in play order. Keys are written out in full (not built from a
 * slug) so the i18n completeness sweep sees them referenced. The `cards` step
 * renders the extra rank/suit visuals below its text.
 */
const STEPS: ReadonlyArray<{ icon: string; title: string; body: string; visual?: 'cards' }> = [
  { icon: '🎯', title: 'rulesPage.how.objective.title', body: 'rulesPage.how.objective.body' },
  {
    icon: '🃏',
    title: 'rulesPage.how.cards.title',
    body: 'rulesPage.how.cards.body',
    visual: 'cards',
  },
  { icon: '📣', title: 'rulesPage.how.bidding.title', body: 'rulesPage.how.bidding.body' },
  { icon: '🔄', title: 'rulesPage.how.exchange.title', body: 'rulesPage.how.exchange.body' },
  { icon: '🖐️', title: 'rulesPage.how.play.title', body: 'rulesPage.how.play.body' },
  { icon: '💍', title: 'rulesPage.how.marriage.title', body: 'rulesPage.how.marriage.body' },
  { icon: '🧮', title: 'rulesPage.how.scoring.title', body: 'rulesPage.how.scoring.body' },
];

export function Rules() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [preset, setPreset] = useState<Preset>('illisoft');
  const [players, setPlayers] = useState<2 | 3 | 4>(4);

  return (
    <div className="screen">
      <header className="screen__top">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>{t('rulesPage.title')}</h1>
          <ConnectionPill />
        </div>
        <p className="dim">{t('rulesPage.intro')}</p>
      </header>

      <main className="screen__main">
        {/* 1 — Friendly walkthrough, shared by both rulesets. */}
        <h2 className="home-heading">{t('rulesPage.howTitle')}</h2>
        {STEPS.map((step) => (
          <section key={step.title} className="mode-card">
            <div className="mode-card__head">
              <span className="mode-card__icon" aria-hidden="true">
                {step.icon}
              </span>
              <div className="mode-card__text">
                <h3 className="mode-card__title">{t(step.title)}</h3>
                <p className="dim mode-card__desc">{t(step.body)}</p>
              </div>
            </div>
            {step.visual === 'cards' && (
              <div className="stack" style={{ gap: 'var(--space-3)' }}>
                <div className="stack" style={{ gap: 'var(--space-1)' }}>
                  <span className="dim rules-cap">{t('rulesPage.rankOrder')}</span>
                  <div className="rank-strip">
                    <span className="rank-strip__end">{t('rulesPage.strongest')}</span>
                    {RANK_ORDER.map((r) => (
                      <span key={r} className="rank-pill">
                        {r}
                      </span>
                    ))}
                    <span className="rank-strip__end">{t('rulesPage.weakest')}</span>
                  </div>
                </div>
                <div className="stack" style={{ gap: 'var(--space-1)' }}>
                  <span className="dim rules-cap">{t('rulesPage.suitValues')}</span>
                  <div className="suit-values">
                    {SUIT_VALUES.map((s) => (
                      <span key={s.symbol} className="suit-chip">
                        <span className="suit-chip__symbol" style={{ color: s.color }}>
                          {s.symbol}
                        </span>
                        {s.value}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
        ))}

        {/* 2 — Ruleset explorer: exact settings for the chosen preset + size. */}
        <h2 className="home-heading">{t('rulesPage.settingsTitle')}</h2>
        <section className="panel stack">
          <p className="dim">{t('rulesPage.settingsIntro')}</p>

          <div className="stack">
            <span className="dim">{t('config.preset')}</span>
            <div className="seg">
              {(['illisoft', 'paamuoto'] as const).map((p) => (
                <button
                  type="button"
                  key={p}
                  className="seg__opt"
                  aria-pressed={preset === p}
                  onClick={() => setPreset(p)}
                >
                  {t(p === 'illisoft' ? 'config.presetIllisoft' : 'config.presetPaamuoto')}
                </button>
              ))}
            </div>
          </div>

          <div className="stack">
            <span className="dim">{t('config.players')}</span>
            <div className="seg">
              {([2, 3, 4] as const).map((n) => (
                <button
                  type="button"
                  key={n}
                  className="seg__opt"
                  aria-pressed={players === n}
                  onClick={() => setPlayers(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <p className="dim rules-preset-desc">
            {t(
              preset === 'illisoft'
                ? 'rulesPage.presetIllisoftDesc'
                : 'rulesPage.presetPaamuotoDesc',
            )}
          </p>

          <RuleSections config={presetConfig(preset, players)} />

          <p className="dim rules-cap">{t('rulesPage.hostNote')}</p>
        </section>
      </main>

      <footer className="screen__bottom">
        <button type="button" style={{ width: '100%' }} onClick={() => navigate('/')}>
          {t('common.back')}
        </button>
      </footer>
    </div>
  );
}
