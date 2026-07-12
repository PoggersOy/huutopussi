/**
 * activeConfigId — which lobby ruleset-dropdown option a live room reflects.
 * Regression cover for the bug where selecting a saved config whose rules equal
 * "Oletus" (identical, or differing only in fields stripped for the room's
 * player count) snapped the dropdown back to the earlier-listed default instead
 * of showing the config the host picked.
 */
import { ILLISOFT_RULES, type RuleConfig } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { activeConfigId } from '../src/rules';

type Opt = { id: string; name: string; config: RuleConfig };
const opt = (id: string, name: string, config: RuleConfig): Opt => ({ id, name, config });
// Mirrors the lobby: the built-in default is listed first, id ''.
const DEFAULT_OPT = opt('', 'Oletus', ILLISOFT_RULES);

describe('activeConfigId', () => {
  it('prefers the host-picked named config when its rules equal the default', () => {
    // A saved config byte-identical to the default. The room applied it, so its
    // config is (structurally) the default — but configName records the pick.
    const twin = opt('x1', 'House rules', ILLISOFT_RULES);
    expect(activeConfigId([DEFAULT_OPT, twin], ILLISOFT_RULES, 'House rules')).toBe('x1');
  });

  it('ignores fields stripped for the player count (koini in a 4p room)', () => {
    // Differs from the default only in the 2-3p koini fields, which are stripped
    // at 4p → equal to the default there, but the host still picked it by name.
    const koini: RuleConfig = { ...ILLISOFT_RULES, talonSize: 6, openTalon: false };
    expect(activeConfigId([DEFAULT_OPT, opt('x1', 'Koini', koini)], ILLISOFT_RULES, 'Koini')).toBe(
      'x1',
    );
  });

  it('resolves to the built-in default when the room carries no name', () => {
    const twin = opt('x1', 'House rules', ILLISOFT_RULES);
    expect(activeConfigId([DEFAULT_OPT, twin], ILLISOFT_RULES, null)).toBe('');
  });

  it('matches a genuinely different config', () => {
    const custom: RuleConfig = { ...ILLISOFT_RULES, winTarget: 1000 };
    expect(activeConfigId([DEFAULT_OPT, opt('x1', 'Long game', custom)], custom, 'Long game')).toBe(
      'x1',
    );
  });

  it('returns null for a named config no longer among the options (edited/deleted)', () => {
    const custom: RuleConfig = { ...ILLISOFT_RULES, winTarget: 1000 };
    expect(activeConfigId([DEFAULT_OPT], custom, 'Gone')).toBeNull();
  });
});
