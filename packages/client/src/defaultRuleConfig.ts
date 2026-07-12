/**
 * defaultRuleConfig — the signed-in player's "starred" saved rule configuration:
 * the one auto-selected when a room is created / a ruleset picker first appears.
 * A single per-account preference; the id `''` means the built-in "Oletus"
 * default (the always-available fallback).
 *
 * Stored in localStorage as a `{ [userId]: configId }` map so different accounts
 * on one browser keep separate choices; degrades safely under blocked storage
 * (private mode — the choice still applies for the session). A tiny pub/sub lets
 * the Profile list re-render via useSyncExternalStore (mirrors feedback.ts).
 */
import { useSyncExternalStore } from 'react';
import type { SavedRuleConfig } from './store';

/** localStorage key: a JSON map of userId → starred config id (`''` = Oletus). */
const KEY = 'hp:defaultConfig';

type StarMap = Record<string, string>;

function readMap(): StarMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StarMap) : {};
  } catch {
    return {};
  }
}

function writeMap(m: StarMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // Private mode — the choice still applies for this session (in-memory).
  }
}

let cache: StarMap = readMap();

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to changes (for useSyncExternalStore). */
export function subscribeDefaultConfig(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The raw starred config id for a user (`''` = built-in Oletus / none / guest). */
export function getDefaultConfigId(userId: string | null): string {
  if (userId === null) return '';
  return cache[userId] ?? '';
}

/** Star a config id for a user; `''` clears back to the built-in Oletus. */
export function setDefaultConfigId(userId: string | null, id: string): void {
  if (userId === null) return;
  const next = { ...cache };
  if (id === '') delete next[userId];
  else next[userId] = id;
  cache = next;
  writeMap(cache);
  notify();
}

/** Reactive read of the starred id for `userId` (empty string when unset). */
export function useDefaultConfigId(userId: string | null): string {
  return useSyncExternalStore(subscribeDefaultConfig, () => getDefaultConfigId(userId));
}

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
