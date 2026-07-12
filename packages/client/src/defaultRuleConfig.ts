/**
 * defaultRuleConfig — helper for the account's "starred" saved ruleset: the one
 * auto-selected when a room is created / a ruleset picker first appears. The
 * starred id itself is persisted server-side and cached in the zustand `auth`
 * slice (`auth.defaultConfigId`, '' = the built-in "Oletus"); this module only
 * resolves that id against the current list.
 */
import type { SavedRuleConfig } from './store';

/**
 * Resolve the starred saved config against the account's current list. Returns
 * the saved config to auto-select, or null when the built-in "Oletus" default is
 * starred OR the starred id no longer exists (deleted elsewhere) — so an orphaned
 * star always falls back to the default rather than showing nothing.
 */
export function resolveDefaultConfig(
  configs: readonly SavedRuleConfig[],
  starredId: string,
): SavedRuleConfig | null {
  if (starredId === '') return null;
  return configs.find((c) => c.id === starredId) ?? null;
}
