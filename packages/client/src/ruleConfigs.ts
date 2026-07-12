/**
 * ruleConfigs.ts — client API for the signed-in player's saved rule
 * configurations (the lobby "Sääntömuoto" dropdown beyond the built-in
 * "Oletus"). Thin wrappers over /api/profile/configs that re-sync the store's
 * cached list on success, so the Profile editor and the lobby dropdown always
 * agree. All calls require a signed-in account (getAuthToken()).
 */
import type { RuleConfig } from '@hp/engine';
import { getAuthToken } from './auth';
import { type SavedRuleConfig, syncRuleConfigs } from './store';

/** Max saved configs per account — mirrors the server's cap (db.ts) for UI
 *  gating; the server is the source of truth (a POST past it returns 409). */
export const MAX_RULE_CONFIGS = 10;

export type ConfigMutationResult =
  | { ok: true; config: SavedRuleConfig }
  | { ok: false; error: 'limit' | 'unauthorized' | 'invalid' | 'network' };

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/** Create a saved configuration. 409 → the per-account limit is reached. */
export async function createRuleConfig(
  name: string,
  config: RuleConfig,
): Promise<ConfigMutationResult> {
  const token = getAuthToken();
  if (!token) return { ok: false, error: 'unauthorized' };
  try {
    const res = await fetch('/api/profile/configs', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name, config }),
    });
    if (res.status === 409) return { ok: false, error: 'limit' };
    if (res.status === 400) return { ok: false, error: 'invalid' };
    if (!res.ok) return { ok: false, error: 'network' };
    const body = (await res.json()) as { config: SavedRuleConfig };
    await syncRuleConfigs();
    return { ok: true, config: body.config };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** Update a saved configuration the user owns. */
export async function updateRuleConfig(
  id: string,
  name: string,
  config: RuleConfig,
): Promise<ConfigMutationResult> {
  const token = getAuthToken();
  if (!token) return { ok: false, error: 'unauthorized' };
  try {
    const res = await fetch(`/api/profile/configs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ name, config }),
    });
    if (res.status === 400) return { ok: false, error: 'invalid' };
    if (!res.ok) return { ok: false, error: 'network' };
    await syncRuleConfigs();
    return { ok: true, config: { id, name, config } };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/**
 * Star which saved configuration is auto-selected for new games — `''` clears
 * back to the built-in "Oletus". Persisted server-side, per account. Returns
 * whether the server accepted it (the caller reflects it optimistically and
 * reverts on false). No re-sync here, so the optimistic store value stands.
 */
export async function setDefaultRuleConfig(configId: string): Promise<boolean> {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const res = await fetch('/api/profile/configs/default', {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ configId: configId === '' ? null : configId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Delete a saved configuration the user owns. Returns whether it succeeded. */
export async function deleteRuleConfig(id: string): Promise<boolean> {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const res = await fetch(`/api/profile/configs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    if (!res.ok) return false;
    await syncRuleConfigs();
    return true;
  } catch {
    return false;
  }
}
