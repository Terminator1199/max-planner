// Gems: the game's price of time, and the player's gem budget for finishing upgrades.

/**
 * The game's price of time, as points of (seconds left, gems): 1 minute, 1 hour, 1 day and
 * 1 week. Between two points the price is a straight line; past a week the last line goes
 * on. The result is rounded to the nearest gem. These are the long-standing rates; the
 * game shows the real price on the upgrade's finish button.
 */
export const GEM_RATES: readonly (readonly [seconds: number, gems: number])[] = [
  [60, 1],
  [3600, 20],
  [86_400, 260],
  [604_800, 1000],
];

/** Gems to finish a timer with `seconds` left. */
export function gemCost(seconds: number): number {
  if (seconds <= 0) return 0;
  const [first] = GEM_RATES;
  if (seconds <= first![0]) return first![1];
  let i = 1;
  while (i < GEM_RATES.length - 1 && seconds > GEM_RATES[i]![0]) i++;
  const [x0, y0] = GEM_RATES[i - 1]!;
  const [x1, y1] = GEM_RATES[i]!;
  return Math.round(y0 + ((y1 - y0) * (seconds - x0)) / (x1 - x0));
}

/** What the player can spend on finishing upgrades, as set on the booster page. */
export interface GemSettings {
  /** Gems in hand at the export time. */
  stock: number;
  /** Gems expected each month, from every source together. Earned evenly over the month. */
  perMonth: number;
  /** Gems never spent, such as savings for a builder. */
  reserve: number;
  /** Only upgrades with at least this many days left are finished with gems. */
  minDays: number;
}

export const DEFAULT_GEMS: Readonly<GemSettings> = Object.freeze({
  stock: 0,
  perMonth: 0,
  reserve: 0,
  minDays: 1,
});

/** An average month, so a year of monthly gems is twelve months' worth. */
export const MONTH_SECONDS = 2_629_800;

/** Gems earned by `t`, counting from `start`: the stock plus the monthly gems so far. */
export function gemsEarned(g: GemSettings, start: number, t: number): number {
  return Math.floor(g.stock + (g.perMonth * Math.max(0, t - start)) / MONTH_SECONDS);
}

/** True when the settings give the plan any gems to spend. */
export function hasGems(g: GemSettings | undefined): boolean {
  return !!g && (g.stock > g.reserve || g.perMonth > 0);
}
