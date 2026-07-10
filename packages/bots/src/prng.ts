/**
 * Deterministic PRNG for bots and the sim harness. All randomness in the
 * fuzz pipeline flows through a seeded mulberry32 stream so every game is
 * exactly reproducible from (seed, game index).
 */

/** Returns floats uniformly in [0, 1). */
export type Prng = () => number;

/** mulberry32: fast, well-mixed 32-bit seeded PRNG (deterministic everywhere). */
export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). */
export function pickIndex(rng: Prng, n: number): number {
  return Math.floor(rng() * n);
}

/** Uniform pick from a non-empty array. */
export function pick<T>(rng: Prng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from an empty array');
  return items[pickIndex(rng, items.length)] as T;
}

/** k distinct items via partial Fisher-Yates (k clamped to items.length). */
export function sample<T>(rng: Prng, items: readonly T[], k: number): T[] {
  const pool = [...items];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + pickIndex(rng, pool.length - i);
    const tmp = pool[i] as T;
    pool[i] = pool[j] as T;
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/** Full Fisher-Yates shuffle (returns a new array). */
export function shuffle<T>(rng: Prng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pickIndex(rng, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
