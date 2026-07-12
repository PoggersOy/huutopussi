/**
 * defaultRuleConfig — the per-account "starred" saved ruleset, auto-selected for
 * new games. Covers the resolver's orphan fallback (a starred config deleted
 * elsewhere resolves to the built-in default, never to nothing) and the
 * per-user get/set, incl. guests (no account → always the default).
 */
import { ILLISOFT_RULES } from '@hp/engine';
import { describe, expect, it } from 'vitest';
import {
  getDefaultConfigId,
  resolveDefaultConfig,
  setDefaultConfigId,
} from '../src/defaultRuleConfig';
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

describe('get/setDefaultConfigId', () => {
  it('stores and reads a starred id per user', () => {
    setDefaultConfigId('u1', 'a');
    setDefaultConfigId('u2', 'b');
    expect(getDefaultConfigId('u1')).toBe('a');
    expect(getDefaultConfigId('u2')).toBe('b');
  });

  it("clears back to the default on ''", () => {
    setDefaultConfigId('u3', 'a');
    setDefaultConfigId('u3', '');
    expect(getDefaultConfigId('u3')).toBe('');
  });

  it('treats a guest (null user) as the default and never stores', () => {
    setDefaultConfigId(null, 'a');
    expect(getDefaultConfigId(null)).toBe('');
  });
});
