/**
 * The in-table reaction palette. `Emote` ids are the wire contract
 * (@hp/protocol `emoteSchema`); this module owns their presentation — emoji,
 * i18n label key, and the situation group the picker shows them under. No free
 * text ever: a fixed, curated set. Add here in lockstep with the protocol enum.
 */
import type { Emote } from '@hp/protocol';

/** The situation a reaction belongs to (drives the picker's grouped rows). */
export type EmoteCategory = 'greeting' | 'praise' | 'celebrate' | 'dismay' | 'gg';

export interface EmoteDef {
  id: Emote;
  emoji: string;
  /** i18n key: `emote.<id>` — the short label / accessible name. */
  i18nKey: string;
  category: EmoteCategory;
}

export const EMOTE_CATEGORIES: readonly EmoteCategory[] = [
  'greeting',
  'praise',
  'celebrate',
  'dismay',
  'gg',
];

export const EMOTES: readonly EmoteDef[] = [
  { id: 'greet', emoji: '👋', i18nKey: 'emote.greet', category: 'greeting' },
  { id: 'wellPlayed', emoji: '👏', i18nKey: 'emote.wellPlayed', category: 'praise' },
  { id: 'nice', emoji: '👍', i18nKey: 'emote.nice', category: 'praise' },
  { id: 'fire', emoji: '🔥', i18nKey: 'emote.fire', category: 'praise' },
  { id: 'celebrate', emoji: '🎉', i18nKey: 'emote.celebrate', category: 'celebrate' },
  { id: 'confident', emoji: '😎', i18nKey: 'emote.confident', category: 'celebrate' },
  { id: 'strong', emoji: '💪', i18nKey: 'emote.strong', category: 'celebrate' },
  { id: 'thinking', emoji: '🤔', i18nKey: 'emote.thinking', category: 'dismay' },
  { id: 'sweat', emoji: '😅', i18nKey: 'emote.sweat', category: 'dismay' },
  { id: 'shock', emoji: '😱', i18nKey: 'emote.shock', category: 'dismay' },
  { id: 'laugh', emoji: '😂', i18nKey: 'emote.laugh', category: 'dismay' },
  { id: 'gg', emoji: '🤝', i18nKey: 'emote.gg', category: 'gg' },
  { id: 'thanks', emoji: '🙏', i18nKey: 'emote.thanks', category: 'gg' },
];

/** id → def, for O(1) lookup when rendering a received emote. */
export const emoteById: Record<Emote, EmoteDef> = Object.fromEntries(
  EMOTES.map((e) => [e.id, e]),
) as Record<Emote, EmoteDef>;
