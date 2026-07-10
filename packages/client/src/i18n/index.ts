/**
 * i18next setup: fi + en bundled resources, English fallback, language
 * detected from a persisted toggle (localStorage) falling back to the
 * browser's language list. All server/engine codes (error.*, event.*) are
 * i18n keys per CLAUDE.md conventions.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import fi from './fi.json';

export type Language = 'fi' | 'en';
export const LANGUAGES: readonly Language[] = ['fi', 'en'];

const STORAGE_KEY = 'hp:lang';

export function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'fi' || stored === 'en') return stored;
  } catch {
    // localStorage unavailable — fall through to navigator detection.
  }
  const candidates = typeof navigator !== 'undefined' ? (navigator.languages ?? []) : [];
  for (const lang of candidates) {
    if (lang.toLowerCase().startsWith('fi')) return 'fi';
    if (lang.toLowerCase().startsWith('en')) return 'en';
  }
  return 'fi';
}

/** Change + persist the UI language (the Home screen toggle calls this). */
export function setLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not persisted; still switches for this session.
  }
  void i18next.changeLanguage(lang);
}

i18next.use(initReactI18next).init({
  resources: {
    fi: { translation: fi },
    en: { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnEmptyString: false,
});

export default i18next;
