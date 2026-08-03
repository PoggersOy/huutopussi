/**
 * Count a number up from zero when it first appears (docs/MOTION.md §3.5).
 *
 * The deal-scored and match-ended cards used to spring in with every figure
 * already printed, so the one moment the player actually cares about a number
 * gave them nothing to watch. Counting the figure up makes the score land.
 *
 * Driven by rAF (never a timer), eased so it decelerates into the final value,
 * and — under `prefers-reduced-motion` — it returns the target immediately, so
 * the information is never withheld from anyone.
 */
import { useEffect, useRef, useState } from 'react';

/** How long every counted figure takes, regardless of magnitude. */
const COUNT_MS = 600;

/**
 * True when we should skip the count and show the final figure at once. Note
 * the default: if the platform can't be asked about its motion preference at
 * all (jsdom under test, or any non-browser render), we do NOT animate — an
 * environment with no compositor has nothing to gain from it, and the value is
 * never withheld from a reader.
 */
function skipMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Decelerating ease — fast at first, settling onto the final digit. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * The displayed value on its way to `target`. Restarts whenever `target`
 * changes; `delayMs` staggers a column of figures so they don't all tick at
 * once. Negative targets count down from zero, so a lost deal reads as a drop.
 *
 * `enabled` lets a caller share a component between a live moment (count) and a
 * static readout (don't) — see DealBreakdownTable, which is used both by the
 * "Jako laskettu" overlay and by the History browser.
 */
export function useCountUp(target: number, delayMs = 0, enabled = true): number {
  const [value, setValue] = useState(() => (!enabled || skipMotion() ? target : 0));
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || skipMotion() || target === 0) {
      setValue(target);
      return;
    }
    setValue(0);
    const start = performance.now() + delayMs;
    const tick = (now: number): void => {
      const t = Math.min(1, Math.max(0, (now - start) / COUNT_MS));
      setValue(Math.round(target * easeOut(t)));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [target, delayMs, enabled]);

  return value;
}
