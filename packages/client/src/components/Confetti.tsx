/**
 * Pure-CSS confetti burst — no assets, no library (works under the PWA's strict
 * CSP). Pieces are deterministic per index (no Math.random churn on re-render);
 * the animation is defined in table.css and disabled under
 * `prefers-reduced-motion`. Purely decorative → aria-hidden.
 */
import { type CSSProperties, type ReactElement, useMemo } from 'react';

const COLORS = ['#d4af37', '#f4d879', '#c8102e', '#1667c8', '#147a3c', '#f6f1e3'];

/**
 * The burst is a CANNON: pieces launch upward from the bottom edge, fan out and
 * then fall. It used to be a uniform top-down drizzle of identical rectangles,
 * which reads as weather rather than as celebration. Size, shape, launch height
 * and sideways drift all vary per piece — still deterministically, so a
 * re-render never reshuffles the burst mid-flight.
 */
export function Confetti({ count = 70 }: { count?: number }): ReactElement {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        // Launch points cluster toward the middle, thinning at the edges.
        left: 8 + ((i * 61) % 84),
        delay: (i % 9) * 45,
        duration: 1500 + (i % 7) * 260,
        color: COLORS[i % COLORS.length],
        // The further from centre, the harder sideways — a real burst's spread.
        drift: (8 + ((i * 61) % 84) - 50) * (1.4 + (i % 3) * 0.5),
        rise: 42 + (i % 6) * 11, // vh thrown before gravity wins
        rotate: (i % 6) * 60,
        w: 6 + (i % 4) * 2,
        h: 9 + (i % 5) * 3,
        // Every third piece is a disc rather than a ribbon.
        radius: i % 3 === 0 ? '50%' : '1px',
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
              '--rise': `${p.rise}vh`,
              '--rot': `${p.rotate}deg`,
              '--w': `${p.w}px`,
              '--h': `${p.h}px`,
              '--pcr': p.radius,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
