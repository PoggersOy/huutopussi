/**
 * Dismissal for an informational modal: Escape closes it, and so does a click
 * on the dimmed backdrop (but never a click inside the panel). Spread the
 * returned props onto the `.overlay` element; `onClose` should be stable-ish
 * (re-subscribing on change is harmless).
 *
 * Not for overlays that demand a choice or advance on their own (deal results,
 * match end, redeal countdown) — those must not vanish on a stray tap.
 */
import { type MouseEvent, useEffect } from 'react';

export function useDismiss(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, enabled]);

  return {
    onClick: (e: MouseEvent<HTMLElement>): void => {
      if (enabled && e.target === e.currentTarget) onClose();
    },
  };
}
