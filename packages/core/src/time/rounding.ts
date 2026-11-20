// Discounted durations and costs, rounded the way the game rounds them.
// Source: https://clashclock.com/guides/how-it-works ("How it works", rounding section).

const HALF_HOUR = 1800;
const DAY = 86_400;

/** Percent off a step's time and cost. Whole numbers from 0 to 100. */
export interface Discount {
  timePct: number;
  costPct: number;
}

export const NO_DISCOUNT: Readonly<Discount> = Object.freeze({ timePct: 0, costPct: 0 });

/**
 * Applies every percentage in turn, so 50% and 20% leave 40% of the time, then rounds:
 * under 30 minutes up to the second, up to a day down to 10 minutes, beyond a day down
 * to the hour. With no discount the base duration comes back unchanged.
 */
export function discountedSeconds(base: number, pcts: readonly number[]): number {
  const { num, den } = factor(base, pcts);
  if (den === 1) return base;
  // Integer arithmetic keeps 10 h x 0.8 at exactly 8 h.
  if (num < HALF_HOUR * den) return Math.ceil(num / den);
  if (num <= DAY * den) return Math.floor(num / (600 * den)) * 600;
  return Math.floor(num / (3600 * den)) * 3600;
}

/** Costs round up. */
export function discountedCost(base: number, pcts: readonly number[]): number {
  const { num, den } = factor(base, pcts);
  return den === 1 ? base : Math.ceil(num / den);
}

/** Total percent off once all discounts are combined, for display. */
export function combinedPct(pcts: readonly number[]): number {
  let left = 1;
  for (const p of pcts) left *= (100 - p) / 100;
  return Math.round((1 - left) * 1000) / 10;
}

function factor(base: number, pcts: readonly number[]): { num: number; den: number } {
  let num = base;
  let den = 1;
  for (const p of pcts) {
    if (!Number.isInteger(p) || p < 0 || p > 100) {
      throw new RangeError(`Discounts are whole percentages from 0 to 100; got ${p}.`);
    }
    if (p === 0) continue;
    num *= 100 - p;
    den *= 100;
  }
  return { num, den };
}
