/**
 * Procedural sound engine — Web Audio, zero audio assets. Every cue is
 * synthesized from oscillators + envelopes on demand, so it needs no bundled
 * files (works offline under the PWA's strict CSP) and is trivially tweakable.
 *
 * The AudioContext is created lazily and starts SUSPENDED (browser autoplay
 * policy); `resumeAudio()` is called from the first user gesture (see
 * feedback.ts). If the context can't be created or is still suspended, `play`
 * is a silent no-op — sound is a nicety, never load-bearing.
 */

export type SoundCue =
  | 'card'
  | 'tap'
  | 'bid'
  | 'declare'
  | 'trickWin'
  | 'trickLose'
  | 'yourTurn'
  | 'dealScore'
  | 'lapari'
  | 'matchWin'
  | 'matchLose'
  | 'emote';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Lazily create (or return) the shared context + master bus. */
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx !== null) return ctx;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AC === undefined) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = 0.5;
  // A gentle limiter keeps stacked cues (rapid card plays) from clipping.
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  return ctx;
}

/** Resume the context after a user gesture (browsers start it suspended). */
export function resumeAudio(): void {
  const c = audio();
  if (c !== null && c.state === 'suspended') void c.resume();
}

interface ToneOpts {
  freq: number;
  start: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  /** Exponential glide target reached at `start + dur`. */
  glideTo?: number;
}

function tone(c: AudioContext, o: ToneOpts): void {
  if (master === null) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, o.start);
  if (o.glideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(o.glideTo, o.start + o.dur);
  }
  const peak = o.gain ?? 0.25;
  // Fast attack, exponential decay — a plucked/bell-ish envelope.
  g.gain.setValueAtTime(0.0001, o.start);
  g.gain.exponentialRampToValueAtTime(peak, o.start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, o.start + o.dur);
  osc.connect(g);
  g.connect(master);
  osc.start(o.start);
  osc.stop(o.start + o.dur + 0.03);
}

/** A short band-passed noise burst — the "whoosh" of a card hitting the felt. */
function noise(c: AudioContext, start: number, dur: number, gain: number): void {
  if (master === null) return;
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = 1400;
  filt.Q.value = 0.8;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filt);
  filt.connect(g);
  g.connect(master);
  src.start(start);
}

/** A rising/falling run of notes (arpeggios for the big celebratory cues). */
function arp(
  c: AudioContext,
  t0: number,
  freqs: number[],
  step: number,
  dur: number,
  gain: number,
  type: OscillatorType,
): void {
  freqs.forEach((f, i) => tone(c, { freq: f, start: t0 + i * step, dur, type, gain }));
}

export function playSound(cue: SoundCue): void {
  const c = audio();
  if (c === null || master === null) return;
  if (c.state === 'suspended') void c.resume();
  const t = c.currentTime + 0.001;
  switch (cue) {
    case 'card':
      noise(c, t, 0.11, 0.1);
      tone(c, { freq: 210, start: t, dur: 0.09, type: 'triangle', gain: 0.1, glideTo: 150 });
      break;
    case 'tap':
      tone(c, { freq: 660, start: t, dur: 0.05, type: 'sine', gain: 0.1 });
      break;
    case 'bid':
      tone(c, { freq: 440, start: t, dur: 0.09, type: 'triangle', gain: 0.14 });
      tone(c, { freq: 620, start: t + 0.06, dur: 0.1, type: 'triangle', gain: 0.14 });
      break;
    case 'declare':
      // A warm perfect fifth — ties in with the gold "trump made" bubble.
      tone(c, { freq: 392, start: t, dur: 0.34, type: 'sine', gain: 0.2 });
      tone(c, { freq: 587, start: t + 0.04, dur: 0.34, type: 'sine', gain: 0.18 });
      break;
    case 'trickWin':
      tone(c, { freq: 659, start: t, dur: 0.1, type: 'sine', gain: 0.18 });
      tone(c, { freq: 988, start: t + 0.08, dur: 0.16, type: 'sine', gain: 0.2 });
      break;
    case 'trickLose':
      tone(c, { freq: 300, start: t, dur: 0.14, type: 'sine', gain: 0.11, glideTo: 220 });
      break;
    case 'yourTurn':
      tone(c, { freq: 523, start: t, dur: 0.12, type: 'sine', gain: 0.16 });
      tone(c, { freq: 784, start: t + 0.1, dur: 0.16, type: 'sine', gain: 0.16 });
      break;
    case 'dealScore':
      arp(c, t, [523, 659, 784], 0.05, 0.3, 0.14, 'sine');
      break;
    case 'lapari':
      // A bright four-note fanfare for a clean sweep.
      arp(c, t, [523, 659, 784, 1047], 0.09, 0.35, 0.18, 'triangle');
      break;
    case 'matchWin':
      arp(c, t, [523, 659, 784, 1047, 1319], 0.1, 0.4, 0.2, 'sine');
      tone(c, { freq: 1047, start: t + 0.56, dur: 0.5, type: 'triangle', gain: 0.16 });
      break;
    case 'matchLose':
      arp(c, t, [523, 466, 392, 311], 0.13, 0.3, 0.15, 'sine');
      break;
    case 'emote':
      tone(c, { freq: 700, start: t, dur: 0.12, type: 'sine', gain: 0.15, glideTo: 1100 });
      break;
  }
}
