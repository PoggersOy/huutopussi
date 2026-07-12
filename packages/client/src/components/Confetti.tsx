/**
 * Pure-CSS confetti burst — no assets, no library (works under the PWA's strict
 * CSP). Pieces are deterministic per index (no Math.random churn on re-render);
 * the animation is defined in table.css and disabled under
 * `prefers-reduced-motion`. Purely decorative → aria-hidden.
 */
import { type CSSProperties, type ReactElement, useMemo } from 'react';

const COLORS = ['#d4af37', '#f4d879', '#c8102e', '#1667c8', '#147a3c', '#f6f1e3'];

export function Confetti({ count = 70 }: { count?: number }): ReactElement {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: (i * 61) % 100, // spread across the width without RNG
        delay: (i % 12) * 70,
        duration: 1700 + (i % 7) * 240,
        color: COLORS[i % COLORS.length],
        drift: ((i % 5) - 2) * 14,
        rotate: (i % 6) * 60,
      })),
    [count],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti__pc"
          style={
            {
              left: `${p.left}%`,
              background: p.color,
              animationDelay: `${p.delay}ms`,
              animationDuration: `${p.duration}ms`,
              '--drift': `${p.drift}px`,
              '--rot': `${p.rotate}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
