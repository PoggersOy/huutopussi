/**
 * Shared rule presentation + editing. The single source of truth for:
 *  - turning a live RuleConfig into the human-readable, grouped rows shown in
 *    the lobby's "view all rules" overlay and on the Peliohjeet screen
 *    (RuleSections), and
 *  - the full field editor used in the profile to build saved configurations
 *    (RuleConfigEditor).
 *
 * A room's rules come from either the built-in DEFAULT_CONFIG ("Oletus") or one
 * of the player's saved configurations. The player count is chosen separately at
 * lobby creation, so resolveConfigForPlayers overlays it and strips the fields
 * that don't apply to that count (the server rejects those); configMatches says
 * which saved config a live room currently reflects (ignoring the mode fields).
 */
import { ILLISOFT_RULES, type RuleConfig } from '@hp/engine';
import type { ConfigPatch } from '@hp/protocol';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** The built-in "Oletus" configuration (never surfaced under any brand name). */
export const DEFAULT_CONFIG: RuleConfig = ILLISOFT_RULES;

/**
 * A complete config as the wire patch for a room of `players` seats: the config
 * with the chosen player count, minus the fields the server gates by count
 * (talonSize/openTalon are 2-3p only; exchangeCount is 4p only).
 */
export function resolveConfigForPlayers(config: RuleConfig, players: 2 | 3 | 4): ConfigPatch {
  const patch = { ...config, players } as Record<string, unknown>;
  if (players === 4) {
    delete patch.talonSize;
    delete patch.openTalon;
  } else {
    delete patch.exchangeCount;
  }
  return patch as ConfigPatch;
}

/**
 * Whether a candidate config would produce `roomConfig`'s rules at the room's
 * player count. Compares the wire patches both resolve to for that count, so the
 * fields stripped for the count (left at the server's base) never cause a false
 * mismatch. Used to light up the active entry in the lobby ruleset dropdown.
 */
export function configMatches(roomConfig: RuleConfig, candidate: RuleConfig): boolean {
  const players = roomConfig.players;
  const a = resolveConfigForPlayers(roomConfig, players) as Record<string, unknown>;
  const b = resolveConfigForPlayers(candidate, players) as Record<string, unknown>;
  return Object.keys(b).every((k) => a[k] === b[k]);
}

/**
 * Which lobby-dropdown option the live room reflects. Several options can match
 * structurally at once — a saved config whose rules equal "Oletus" at the room's
 * player count (identical, or differing only in fields stripped for that count,
 * e.g. koini in a 4p room) matches the built-in default too. The room's
 * `configName` records which one the host actually picked, so among the matches
 * prefer that; otherwise selecting such a config would snap the dropdown back to
 * the earlier-listed "Oletus". Returns null when nothing matches (a named config
 * that was edited/deleted after use — shown as a disabled placeholder).
 */
export function activeConfigId(
  options: readonly { id: string; name: string; config: RuleConfig }[],
  config: RuleConfig,
  configName: string | null,
): string | null {
  const matches = options.filter((o) => configMatches(config, o.config));
  return (matches.find((o) => o.id !== '' && o.name === configName) ?? matches[0])?.id ?? null;
}

/** A save-time validity check the per-field editor can't express on its own.
 *  Returns an i18n error key, or null when the config is valid. */
export function ruleConfigError(config: RuleConfig): string | null {
  if (config.maxBid !== null && config.minBid > config.maxBid) return 'config.errMinMaxBid';
  if (config.minBid % config.bidStep !== 0) return 'config.errMinBidStep';
  if (config.maxBid !== null && config.maxBid % config.bidStep !== 0) {
    return 'config.errMaxBidStep';
  }
  return null;
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

// ── Full rule-config editor (profile: build/edit a saved configuration) ───────

const MIN_BID_OPTS = [0, 25, 50, 60, 75, 100, 120, 150, 200];
const BID_STEP_OPTS = [1, 5, 10, 20, 25];
const WIN_TARGET_OPTS = [250, 300, 500, 750, 1000];
const LAST_TRICK_OPTS = [0, 10, 20];
const EXCHANGE_OPTS = [1, 2, 3, 4, 5, 6];
const MAX_BID_OPTS = [200, 300, 420, 440, 1000];
const BID_BAN_OPTS = [0, -1, -250, -500, -1000];

/** Base option list plus `current` if it isn't already one of them (sorted). */
function withCurrent(base: readonly number[], current: number): number[] {
  return base.includes(current) ? [...base] : [...base, current].sort((a, b) => a - b);
}

function SelectRow({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="config-row">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="config-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function numOptions(values: number[]) {
  return values.map((n) => (
    <option key={n} value={n}>
      {n}
    </option>
  ));
}

/**
 * Edits every host-transmittable RuleConfig field (the `configPatchSchema`
 * fields except `players`, which is picked at lobby creation). Grouped like
 * RuleSections. Mode-specific fields are labelled with the count they apply to;
 * the lobby strips the irrelevant ones when a room is created.
 */
export function RuleConfigEditor({
  value,
  onChange,
}: {
  value: RuleConfig;
  onChange: (next: RuleConfig) => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<RuleConfig>): void => onChange({ ...value, ...patch });
  const modeSuffix = (key: string): string => ` ${t(key)}`;

  return (
    <div className="stack rule-editor">
      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secCards')}</h3>
        <SelectRow
          label={t('config.cardPoints')}
          value={value.cardPoints}
          onChange={(v) => set({ cardPoints: v as 'A' | 'B' })}
        >
          <option value="A">{t('config.cardPointsA')}</option>
          <option value="B">{t('config.cardPointsB')}</option>
        </SelectRow>
        <SelectRow
          label={t('rules.lastTrickBonus')}
          value={String(value.lastTrickBonus)}
          onChange={(v) => set({ lastTrickBonus: Number(v) })}
        >
          {numOptions(withCurrent(LAST_TRICK_OPTS, value.lastTrickBonus))}
        </SelectRow>
        <SelectRow
          label={t('config.trumpValues')}
          value={value.trumpValues}
          onChange={(v) => set({ trumpValues: v as 'heartsHigh' | 'bridge' })}
        >
          <option value="heartsHigh">{t('config.trumpValuesHeartsHigh')}</option>
          <option value="bridge">{t('config.trumpValuesBridge')}</option>
        </SelectRow>
      </section>

      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secBidding')}</h3>
        <SelectRow
          label={t('config.minBid')}
          value={String(value.minBid)}
          onChange={(v) => set({ minBid: Number(v) })}
        >
          {numOptions(withCurrent(MIN_BID_OPTS, value.minBid))}
        </SelectRow>
        <SelectRow
          label={t('rules.bidStep')}
          value={String(value.bidStep)}
          onChange={(v) => set({ bidStep: Number(v) })}
        >
          {numOptions(withCurrent(BID_STEP_OPTS, value.bidStep))}
        </SelectRow>
        <SelectRow
          label={t('rules.maxBid')}
          value={value.maxBid === null ? 'unbounded' : String(value.maxBid)}
          onChange={(v) => set({ maxBid: v === 'unbounded' ? null : Number(v) })}
        >
          <option value="unbounded">{t('rules.unbounded')}</option>
          {numOptions(
            value.maxBid === null ? MAX_BID_OPTS : withCurrent(MAX_BID_OPTS, value.maxBid),
          )}
        </SelectRow>
        <SelectRow
          label={t('rules.firstBidder')}
          value={value.firstBidder}
          onChange={(v) => set({ firstBidder: v as 'leftOfDealer' | 'dealer' })}
        >
          <option value="leftOfDealer">{t('rules.firstBidderLeftOfDealer')}</option>
          <option value="dealer">{t('rules.firstBidderDealer')}</option>
        </SelectRow>
        <CheckRow
          label={t('rules.forcedOpening')}
          checked={value.forcedOpening}
          onChange={(v) => set({ forcedOpening: v })}
        />
        <SelectRow
          label={t('rules.allPassOutcome')}
          value={value.allPassOutcome}
          onChange={(v) => set({ allPassOutcome: v as 'forceLastSeat' | 'contractlessDeal' })}
        >
          <option value="contractlessDeal">{t('rules.allPassOutcomeContractlessDeal')}</option>
          <option value="forceLastSeat">{t('rules.allPassOutcomeForceLastSeat')}</option>
        </SelectRow>
        <SelectRow
          label={t('rules.bidBanThreshold')}
          value={value.bidBanThreshold === null ? 'off' : String(value.bidBanThreshold)}
          onChange={(v) => set({ bidBanThreshold: v === 'off' ? null : Number(v) })}
        >
          <option value="off">{t('rules.off')}</option>
          {numOptions(
            value.bidBanThreshold === null
              ? BID_BAN_OPTS
              : withCurrent(BID_BAN_OPTS, value.bidBanThreshold),
          )}
        </SelectRow>
        <CheckRow
          label={t('rules.bidBanReopen')}
          checked={value.bidBanReopen}
          onChange={(v) => set({ bidBanReopen: v })}
        />
        <SelectRow
          label={`${t('rules.contractTiming')}${modeSuffix('config.modeFourPlayers')}`}
          value={value.contractTiming}
          onChange={(v) => set({ contractTiming: v as 'beforeReturn' | 'afterExchange' })}
        >
          <option value="afterExchange">{t('rules.contractTimingAfterExchange')}</option>
          <option value="beforeReturn">{t('rules.contractTimingBeforeReturn')}</option>
        </SelectRow>
        <SelectRow
          label={`${t('rules.exchangeCount')}${modeSuffix('config.modeFourPlayers')}`}
          value={String(value.exchangeCount)}
          onChange={(v) => set({ exchangeCount: Number(v) })}
        >
          {numOptions(withCurrent(EXCHANGE_OPTS, value.exchangeCount))}
        </SelectRow>
      </section>

      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secPlay')}</h3>
        <SelectRow
          label={t('rules.firstTrickRules')}
          value={value.firstTrickRules}
          onChange={(v) => set({ firstTrickRules: v as 'aceShow' | 'free' })}
        >
          <option value="aceShow">{t('rules.firstTrickRulesAceShow')}</option>
          <option value="free">{t('rules.firstTrickRulesFree')}</option>
        </SelectRow>
        <SelectRow
          label={t('config.declareRight')}
          value={value.declareRight}
          onChange={(v) => set({ declareRight: v as 'ownLedWonTrick' | 'anyWonTrick' })}
        >
          <option value="anyWonTrick">{t('config.declareRightAnyWonTrick')}</option>
          <option value="ownLedWonTrick">{t('config.declareRightOwnLedWonTrick')}</option>
        </SelectRow>
        <SelectRow
          label={`${t('rules.askLockouts')}${modeSuffix('config.modeFourPlayers')}`}
          value={value.askLockouts}
          onChange={(v) => set({ askLockouts: v as 'illisoft' | 'basic' })}
        >
          <option value="illisoft">{t('rules.askLockoutsIllisoft')}</option>
          <option value="basic">{t('rules.askLockoutsBasic')}</option>
        </SelectRow>
        <CheckRow
          label={`${t('rules.askHalfMustHoldCard')}${modeSuffix('config.modeFourPlayers')}`}
          checked={value.askHalfMustHoldCard}
          onChange={(v) => set({ askHalfMustHoldCard: v })}
        />
      </section>

      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secScoring')}</h3>
        <SelectRow
          label={t('rules.opponentRounding')}
          value={value.opponentRounding}
          onChange={(v) => set({ opponentRounding: v as 'nearest5' | 'none' })}
        >
          <option value="nearest5">{t('rules.opponentRoundingNearest')}</option>
          <option value="none">{t('rules.opponentRoundingNone')}</option>
        </SelectRow>
        <SelectRow
          label={t('rules.declarerPorvooBasis')}
          value={value.declarerPorvooBasis}
          onChange={(v) => set({ declarerPorvooBasis: v as 'bid' | 'contract' })}
        >
          <option value="contract">{t('rules.declarerPorvooBasisContract')}</option>
          <option value="bid">{t('rules.declarerPorvooBasisBid')}</option>
        </SelectRow>
        <SelectRow
          label={t('rules.declarerPorvooScope')}
          value={value.declarerPorvooScope}
          onChange={(v) => set({ declarerPorvooScope: v as 'seat' | 'side' })}
        >
          <option value="side">{t('rules.declarerPorvooScopeSide')}</option>
          <option value="seat">{t('rules.declarerPorvooScopeSeat')}</option>
        </SelectRow>
      </section>

      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secWinning')}</h3>
        <SelectRow
          label={t('config.winTarget')}
          value={String(value.winTarget)}
          onChange={(v) => set({ winTarget: Number(v) })}
        >
          {numOptions(withCurrent(WIN_TARGET_OPTS, value.winTarget))}
        </SelectRow>
        <SelectRow
          label={t('rules.winCondition')}
          value={value.winCondition}
          onChange={(v) => set({ winCondition: v as 'exceed' | 'reach' })}
        >
          <option value="exceed">{t('rules.winConditionExceed')}</option>
          <option value="reach">{t('rules.winConditionReach')}</option>
        </SelectRow>
        <SelectRow
          label={t('rules.winTiebreak')}
          value={value.winTiebreak}
          onChange={(v) => set({ winTiebreak: v as 'declarer' | 'higher' })}
        >
          <option value="declarer">{t('rules.winTiebreakDeclarer')}</option>
          <option value="higher">{t('rules.winTiebreakHigher')}</option>
        </SelectRow>
      </section>

      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secDeal')}</h3>
        <SelectRow
          label={`${t('config.talonSize')}${modeSuffix('config.modeTwoThreePlayers')}`}
          value={String(value.talonSize)}
          onChange={(v) => set({ talonSize: Number(v) as 3 | 6 })}
        >
          {numOptions([3, 6])}
        </SelectRow>
        <SelectRow
          label={`${t('config.openTalon')}${modeSuffix('config.modeTwoThreePlayers')}`}
          value={value.openTalon ? 'open' : 'secret'}
          onChange={(v) => set({ openTalon: v === 'open' })}
        >
          <option value="open">{t('config.openTalonOpen')}</option>
          <option value="secret">{t('config.openTalonSecret')}</option>
        </SelectRow>
        <SelectRow
          label={t('rules.redealCondition')}
          value={value.redealCondition ?? 'off'}
          onChange={(v) =>
            set({
              redealCondition:
                v === 'off' ? null : (v as 'fourSixes' | 'threeSixesOrNoneAboveJack'),
            })
          }
        >
          <option value="fourSixes">{t('rules.redealConditionFourSixes')}</option>
          <option value="threeSixesOrNoneAboveJack">{t('rules.redealConditionThreeSixes')}</option>
          <option value="off">{t('rules.redealConditionOff')}</option>
        </SelectRow>
        {value.redealCondition !== null && (
          <SelectRow
            label={t('rules.redealWindow')}
            value={value.redealWindow}
            onChange={(v) => set({ redealWindow: v as 'firstBidTurn' | 'bidAndExchange' })}
          >
            <option value="bidAndExchange">{t('rules.redealWindowBidAndExchange')}</option>
            <option value="firstBidTurn">{t('rules.redealWindowFirstBidTurn')}</option>
          </SelectRow>
        )}
      </section>

      <section className="stack rules-group">
        <h3 className="rules-group__title">{t('rules.secDisplay')}</h3>
        <CheckRow
          label={t('config.showLastTrick')}
          checked={value.showLastTrick}
          onChange={(v) => set({ showLastTrick: v })}
        />
      </section>
    </div>
  );
}
