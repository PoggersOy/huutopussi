/**
 * Shared rule presentation. The single source of truth for turning a live
 * RuleConfig into the human-readable, grouped rows shown BOTH in the lobby's
 * "view all rules" overlay and on the standalone Peliohjeet (rules) screen —
 * so every surface reflects exactly what will actually be played.
 *
 * `presetConfig` mirrors the server's preset handling (server.ts
 * applyConfigPatch): a preset is its base ruleset with the mode fields
 * (players/talonSize/openTalon) applied on top. `presetOf` is the inverse used
 * to label a config.
 */
import { DEFAULT_RULES, ILLISOFT_RULES, type RuleConfig } from '@hp/engine';
import { useTranslation } from 'react-i18next';

export type Preset = 'illisoft' | 'paamuoto';

export const PRESET_RULES: Record<Preset, RuleConfig> = {
  illisoft: ILLISOFT_RULES,
  paamuoto: DEFAULT_RULES,
};

/** The 2-3p mode fields are orthogonal to the ruleset choice (spec §11). */
const MODE_FIELDS: ReadonlySet<string> = new Set(['players', 'talonSize', 'openTalon']);

function matchesPreset(config: RuleConfig, preset: RuleConfig): boolean {
  return (Object.keys(preset) as Array<keyof RuleConfig>).every(
    (key) => MODE_FIELDS.has(key) || config[key] === preset[key],
  );
}

/** Which preset a config is (custom if it matches neither base ruleset). */
export function presetOf(config: RuleConfig): Preset | 'custom' {
  if (matchesPreset(config, ILLISOFT_RULES)) return 'illisoft';
  if (matchesPreset(config, DEFAULT_RULES)) return 'paamuoto';
  return 'custom';
}

/** i18n key for a preset's short display name. */
export function presetLabelKey(preset: Preset | 'custom'): string {
  return preset === 'illisoft'
    ? 'config.presetIllisoft'
    : preset === 'paamuoto'
      ? 'config.presetPaamuoto'
      : 'config.presetCustom';
}

/**
 * The config a room plays under a given preset + player count — the base
 * ruleset with the player count applied (talonSize/openTalon keep the base
 * defaults, host-adjustable per room). Matches the server's applyConfigPatch.
 */
export function presetConfig(preset: Preset, players: 2 | 3 | 4): RuleConfig {
  return { ...PRESET_RULES[preset], players };
}

type Row = [label: string, value: string];
type Section = [titleKey: string, rows: Row[]];

/**
 * Every RuleConfig field, grouped into sections, rendered human-readably and
 * derived from the LIVE config — so it stays accurate for presets and for any
 * custom edits alike.
 */
export function RuleSections({ config }: { config: RuleConfig }) {
  const { t } = useTranslation();
  const yn = (b: boolean): string => t(b ? 'rules.yes' : 'rules.no');
  const is4p = config.players === 4;

  const deal: Row[] = [[t('config.players'), t('config.playersOpt', { n: config.players })]];
  if (!is4p) {
    deal.push([t('config.talonSize'), t('config.cardsOpt', { n: config.talonSize })]);
    deal.push([
      t('config.openTalon'),
      t(config.openTalon ? 'config.openTalonOpen' : 'config.openTalonSecret'),
    ]);
  } else {
    deal.push([t('rules.exchangeCount'), t('config.cardsOpt', { n: config.exchangeCount })]);
  }
  deal.push([
    t('rules.redealCondition'),
    t(
      config.redealCondition === 'fourSixes'
        ? 'rules.redealConditionFourSixes'
        : config.redealCondition === 'threeSixesOrNoneAboveJack'
          ? 'rules.redealConditionThreeSixes'
          : 'rules.redealConditionOff',
    ),
  ]);
  if (config.redealCondition !== null) {
    deal.push([
      t('rules.redealWindow'),
      t(
        config.redealWindow === 'bidAndExchange'
          ? 'rules.redealWindowBidAndExchange'
          : 'rules.redealWindowFirstBidTurn',
      ),
    ]);
  }

  const cards: Row[] = [
    [
      t('config.cardPoints'),
      t(config.cardPoints === 'A' ? 'config.cardPointsA' : 'config.cardPointsB'),
    ],
    [t('rules.lastTrickBonus'), t('rules.points', { n: config.lastTrickBonus })],
    [
      t('config.trumpValues'),
      t(
        config.trumpValues === 'heartsHigh'
          ? 'config.trumpValuesHeartsHigh'
          : 'config.trumpValuesBridge',
      ),
    ],
  ];

  const bidding: Row[] = [
    [t('config.minBid'), String(config.minBid)],
    [t('rules.bidStep'), String(config.bidStep)],
    [t('rules.maxBid'), config.maxBid === null ? t('rules.unbounded') : String(config.maxBid)],
    [
      t('rules.firstBidder'),
      t(
        config.firstBidder === 'dealer'
          ? 'rules.firstBidderDealer'
          : 'rules.firstBidderLeftOfDealer',
      ),
    ],
    [t('rules.forcedOpening'), yn(config.forcedOpening)],
    [
      t('rules.allPassOutcome'),
      t(
        config.allPassOutcome === 'contractlessDeal'
          ? 'rules.allPassOutcomeContractlessDeal'
          : 'rules.allPassOutcomeForceLastSeat',
      ),
    ],
    [
      t('rules.bidBanThreshold'),
      config.bidBanThreshold === null ? t('rules.off') : String(config.bidBanThreshold),
    ],
  ];
  if (config.bidBanThreshold !== null) {
    bidding.push([t('rules.bidBanReopen'), yn(config.bidBanReopen)]);
  }
  if (is4p) {
    bidding.push([
      t('rules.contractTiming'),
      t(
        config.contractTiming === 'afterExchange'
          ? 'rules.contractTimingAfterExchange'
          : 'rules.contractTimingBeforeReturn',
      ),
    ]);
  }

  const play: Row[] = [
    [
      t('rules.firstTrickRules'),
      t(
        config.firstTrickRules === 'aceShow'
          ? 'rules.firstTrickRulesAceShow'
          : 'rules.firstTrickRulesFree',
      ),
    ],
    [
      t('config.declareRight'),
      t(
        config.declareRight === 'anyWonTrick'
          ? 'config.declareRightAnyWonTrick'
          : 'config.declareRightOwnLedWonTrick',
      ),
    ],
    [
      t('rules.askLockouts'),
      t(config.askLockouts === 'illisoft' ? 'rules.askLockoutsIllisoft' : 'rules.askLockoutsBasic'),
    ],
    [t('rules.askHalfMustHoldCard'), yn(config.askHalfMustHoldCard)],
  ];

  const scoring: Row[] = [
    [
      t('rules.opponentRounding'),
      t(
        config.opponentRounding === 'nearest5'
          ? 'rules.opponentRoundingNearest'
          : 'rules.opponentRoundingNone',
      ),
    ],
    [
      t('rules.declarerPorvooBasis'),
      t(
        config.declarerPorvooBasis === 'contract'
          ? 'rules.declarerPorvooBasisContract'
          : 'rules.declarerPorvooBasisBid',
      ),
    ],
    [
      t('rules.declarerPorvooScope'),
      t(
        config.declarerPorvooScope === 'side'
          ? 'rules.declarerPorvooScopeSide'
          : 'rules.declarerPorvooScopeSeat',
      ),
    ],
  ];

  const winning: Row[] = [
    [t('config.winTarget'), String(config.winTarget)],
    [
      t('rules.winCondition'),
      t(config.winCondition === 'exceed' ? 'rules.winConditionExceed' : 'rules.winConditionReach'),
    ],
    [
      t('rules.winTiebreak'),
      t(
        config.winTiebreak === 'declarer' ? 'rules.winTiebreakDeclarer' : 'rules.winTiebreakHigher',
      ),
    ],
  ];

  const sections: Section[] = [
    ['rules.secDeal', deal],
    ['rules.secCards', cards],
    ['rules.secBidding', bidding],
    ['rules.secPlay', play],
    ['rules.secScoring', scoring],
    ['rules.secWinning', winning],
    ['rules.secDisplay', [[t('config.showLastTrick'), yn(config.showLastTrick)]]],
  ];

  return (
    <>
      {sections.map(([title, rows]) => (
        <section key={title} className="stack rules-group">
          <h3 className="rules-group__title">{t(title)}</h3>
          <dl className="rules-list">
            {rows.map(([label, value]) => (
              <div key={label} className="rules-list__row">
                <dt className="dim">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}
