/**
 * resolveDefaultConfig — resolves the account's starred ruleset id (persisted
 * server-side in auth.defaultConfigId) against the current saved list. Covers the
 * orphan fallback: a starred config deleted elsewhere resolves to the built-in
 * default, never to nothing.
 */
import { ILLISOFT_RULES } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import { resolveDefaultConfig } from '../src/defaultRuleConfig';
import type { SavedRuleConfig } from '../src/store';

const cfg = (id: string, name: string): SavedRuleConfig => ({ id, name, config: ILLISOFT_RULES });
const configs: SavedRuleConfig[] = [cfg('a', 'A'), cfg('b', 'B')];

describe('resolveDefaultConfig', () => {
  it("returns null (the built-in default) when '' is starred", () => {
    expect(resolveDefaultConfig(configs, '')).toBeNull();
  });

  it('returns the matching saved config when its id is starred', () => {
    expect(resolveDefaultConfig(configs, 'b')?.name).toBe('B');
  });

  it('falls back to the default when the starred id no longer exists', () => {
    expect(resolveDefaultConfig(configs, 'gone')).toBeNull();
  });
});
