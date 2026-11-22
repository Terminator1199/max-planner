/** Seeded random numbers (mulberry32), so every plan can be reproduced from its seed. */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer from `lo` to `hi`, both included. */
  int(lo: number, hi: number): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
}
