/**
 * Feedback layer — maps semantic game moments to sound (sound.ts) + haptics
 * (navigator.vibrate), gated by two persisted user prefs. This is the ONLY
 * module the rest of the app calls for "juice": `cue('trickWin')` etc.
 *
 * Prefs live in localStorage and in-memory; reads are synchronous (the store's
 * update path fires cues without React). A tiny pub/sub lets settings UIs
 * subscribe via useSyncExternalStore.
 */
import { playSound, resumeAudio, type SoundCue } from './sound';

/** A feedback moment. Same set as the synthesized sound cues. */
export type Cue = SoundCue;

const SOUND_KEY = 'hp:sound';
const HAPTICS_KEY = 'hp:haptics';

function readBool(key: string, dflt: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch {
    return dflt;
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    // Private mode — the choice still applies for this session.
  }
}

let soundOn = readBool(SOUND_KEY, true);
let hapticsOn = readBool(HAPTICS_KEY, true);

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to pref changes (for useSyncExternalStore in settings UIs). */
export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSoundOn(): boolean {
  return soundOn;
}

export function getHapticsOn(): boolean {
  return hapticsOn;
}

export function setSoundOn(v: boolean): void {
  soundOn = v;
  writeBool(SOUND_KEY, v);
  if (v) resumeAudio(); // toggling on is itself a gesture — unlock audio now
  notify();
}

export function setHapticsOn(v: boolean): void {
  hapticsOn = v;
  writeBool(HAPTICS_KEY, v);
  notify();
}

/** Whether this device can vibrate at all (hide the haptics toggle otherwise). */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function vibrate(pattern: number | number[]): void {
  if (!hapticsOn || !canVibrate()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw on odd patterns / in the background — ignore.
  }
}

/** Unlock audio on a user gesture (contexts start suspended). Cheap to call often. */
export function primeAudio(): void {
  if (soundOn) resumeAudio();
}

/** Haptic pattern per cue (ms on/off…). Omitted cues get no buzz. */
const HAPTIC: Partial<Record<Cue, number | number[]>> = {
  card: 8,
  tap: 5,
  bid: 10,
  declare: [12, 30, 12],
  trickWin: [10, 30, 10],
  trickLose: 6,
  yourTurn: 18,
  dealScore: 20,
  lapari: [20, 40, 20, 40, 30],
  matchWin: [30, 50, 30, 50, 70],
  matchLose: 40,
  emote: 8,
};

/** Fire a feedback moment: play its sound and buzz, subject to the user prefs. */
export function cue(c: Cue): void {
  if (soundOn) playSound(c);
  const h = HAPTIC[c];
  if (h !== undefined) vibrate(h);
}

// One-time: unlock audio on the very first user interaction anywhere, so the
// first game sound (which may be a bot's move) isn't swallowed by the suspended
// context. Removes itself once fired.
if (typeof window !== 'undefined') {
  const unlock = (): void => {
    primeAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });
}
