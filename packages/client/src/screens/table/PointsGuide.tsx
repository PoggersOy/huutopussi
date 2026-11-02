/**
 * Points guide for the bidding and contract turns: what every card and every
 * marriage is worth under THIS room's rules, plus a tally of the player's own
 * hand — so "how much can I bid / raise?" is arithmetic, not memory.
 *
 * Purely informational: it sums point values with the engine's own scoring
 * helpers (`cardPoints`, `marriageValue`, `totalDealPoints`). It never decides
 * what is legal — the bid/contract buttons stay driven by server hints.
 */
import {
  type Card,
  cardPoints,
  makeCard,
  marriageValue,
  RANKS,
  type RuleConfig,
  SUITS,
  type Suit,
  totalDealPoints,
} from '@hp/engine';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUIT_GLYPH } from './tableUtils';

export interface HandTally {
  /** Card points of the hand (A/10/K/Q/J per config.cardPoints). */
  cardPoints: number;
  /** Suits whose marriage (K+Q) is complete in hand. */
  marriages: Suit[];
  /** Suits with exactly one marriage half (K or Q) in hand. */
  halves: Suit[];
}

/** Point tally of a hand under `config` (pure; unit-tested). */
export function tallyHand(hand: readonly Card[], config: RuleConfig): HandTally {
  const has = (s: Suit, r: 'K' | 'Q'): boolean => hand.includes(makeCard(s, r));
  return {
    cardPoints: hand.reduce((sum, c) => sum + cardPoints(c, config), 0),
    marriages: SUITS.filter((s) => has(s, 'K') && has(s, 'Q')),
    halves: SUITS.filter((s) => has(s, 'K') !== has(s, 'Q')),
  };
}

function SuitGlyph({ suit }: { suit: Suit }): ReactElement {
  return <span className={`suit--${suit}`}>{SUIT_GLYPH[suit]}</span>;
}

function PointsOverlay({
  config,
  hand,
  onClose,
}: {
  config: RuleConfig;
  hand: readonly Card[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const tally = tallyHand(hand, config);
  const marriagePts = tally.marriages.reduce((sum, s) => sum + marriageValue(s, config), 0);
  const allMarriages = SUITS.reduce((sum, s) => sum + marriageValue(s, config), 0);
  // Only the ranks that score (9…6 are worth nothing in every variant).
  const scoring = RANKS.filter((r) => cardPoints(makeCard('S', r), config) > 0);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="points-title">
      <div className="overlay__panel stack points">
        <h2 id="points-title">{t('points.title')}</h2>

        <section className="points__section">
          <h3 className="points__heading">{t('points.yourHand')}</h3>
          <dl className="points__rows">
            <div>
              <dt>{t('points.handCards')}</dt>
              <dd>{tally.cardPoints}</dd>
            </div>
            <div>
              <dt>{t('points.handMarriages')}</dt>
              <dd>
                {tally.marriages.length === 0
                  ? '—'
                  : tally.marriages.map((s) => (
                      <span key={s} className="points__chip">
                        <SuitGlyph suit={s} /> {marriageValue(s, config)}
                      </span>
                    ))}
              </dd>
            </div>
            {tally.halves.length > 0 && (
              <div>
                <dt>{t('points.handHalves')}</dt>
                <dd>
                  {tally.halves.map((s) => (
                    <span key={s} className="points__chip points__chip--maybe">
                      <SuitGlyph suit={s} /> {marriageValue(s, config)}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div className="points__total">
              <dt>{t('points.handTotal')}</dt>
              <dd>{tally.cardPoints + marriagePts}</dd>
            </div>
          </dl>
          <p className="dim points__note">{t('points.handNote')}</p>
        </section>

        <section className="points__section">
          <h3 className="points__heading">{t('points.marriages')}</h3>
          <ul className="points__grid points__grid--two">
            {SUITS.map((s) => (
              <li key={s}>
                <span className="points__label">
                  <SuitGlyph suit={s} /> K+Q
                </span>
                <strong>{marriageValue(s, config)}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section className="points__section">
          <h3 className="points__heading">{t('points.cards')}</h3>
          <ul className="points__grid">
            {scoring.map((r) => (
              <li key={r}>
                <span className="points__label">{r}</span>
                <strong>{cardPoints(makeCard('S', r), config)}</strong>
              </li>
            ))}
            <li>
              <span className="points__label">9–6</span>
              <strong>0</strong>
            </li>
            <li className="points__wide">
              <span className="points__label">{t('points.lastTrick')}</span>
              <strong>+{config.lastTrickBonus}</strong>
            </li>
          </ul>
          <p className="dim points__note">
            {t('points.dealTotal', {
              cards: totalDealPoints(config),
              max: totalDealPoints(config) + allMarriages,
            })}
          </p>
        </section>

        <button type="button" className="btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

/** The "Pisteet" button for a bidding/contract sheet, plus its overlay. */
export function PointsGuideButton({
  config,
  hand,
}: {
  config: RuleConfig | null;
  hand: readonly Card[];
}): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (config === null) return null;
  return (
    <>
      <button type="button" className="points__open" onClick={() => setOpen(true)}>
        <span aria-hidden="true">ⓘ</span> {t('points.open')}
      </button>
      {open && <PointsOverlay config={config} hand={hand} onClose={() => setOpen(false)} />}
    </>
  );
}
