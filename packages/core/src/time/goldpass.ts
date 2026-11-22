// The Gold Pass builder and research boost over a season.
import type { Lane } from "@max-planner/gamedata";
import type { Step } from "../calc/remaining.ts";
import { NO_DISCOUNT, type Discount } from "./rounding.ts";

export interface GoldPassOptions {
  /** Percent unlocked by each day of the season, from seasons.json `goldPassBoostPace`. */
  pace: readonly { day: number; pct: number }[];
  /** Day of the month a season starts, from seasons.json (1 to 28). */
  seasonStartDay: number;
  /** Hour (UTC) a season starts. Seasons have started at 08:00 UTC; confirm in M1. */
  seasonStartHourUtc?: number;
  /**
   * The boost the game shows right now. It holds until the current season ends, then
   * the pace takes over, as ClashClock does when a player types in their percentage.
   */
  currentPct?: number;
  /** Lanes the boost applies to. Builder and research by default; pets: confirm in M1. */
  lanes?: readonly Lane[];
}

const DAY = 86_400;

/** The latest season start at or before `t`. */
export function seasonStartAt(t: number, startDay: number, hourUtc = 8): number {
  checkStart(startDay, hourUtc);
  const d = new Date(t * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let at = Date.UTC(y, m, startDay, hourUtc) / 1000;
  if (at > t) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    at = Date.UTC(y, m, startDay, hourUtc) / 1000;
  }
  return at;
}

/** The first season start after `t`. */
export function nextSeasonStart(t: number, startDay: number, hourUtc = 8): number {
  const start = new Date(seasonStartAt(t, startDay, hourUtc) * 1000);
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, startDay, hourUtc) / 1000;
}

/**
 * The Gold Pass percentage at time `t`. `from` is the export time, which decides how
 * long `currentPct` holds.
 */
export function goldPassPctAt(options: GoldPassOptions, from: number, t: number): number {
  const hour = options.seasonStartHourUtc ?? 8;
  if (options.currentPct !== undefined && t < nextSeasonStart(from, options.seasonStartDay, hour)) {
    return options.currentPct;
  }
  const day = Math.floor((t - seasonStartAt(t, options.seasonStartDay, hour)) / DAY) + 1;
  let pct = 0;
  for (const p of options.pace) if (p.day <= day) pct = Math.max(pct, p.pct);
  return pct;
}

/** A discount source for the scheduler: the same percent off time and cost. */
export function goldPassDiscount(
  options: GoldPassOptions,
  from: number,
): (step: Step, t: number) => Discount {
  const lanes = new Set<Lane>(options.lanes ?? ["builder", "lab"]);
  if (options.currentPct !== undefined) checkPct(options.currentPct);
  for (const p of options.pace) checkPct(p.pct);
  // The percentage only changes at a day boundary within the season, so the scheduler's
  // many lookups reuse the last day's answer.
  const hour = options.seasonStartHourUtc ?? 8;
  let cached = { from: Infinity, to: -Infinity, discount: NO_DISCOUNT as Discount };
  return (step, t) => {
    if (!lanes.has(step.lane)) return NO_DISCOUNT;
    if (t < cached.from || t >= cached.to) {
      const season = seasonStartAt(t, options.seasonStartDay, hour);
      const dayStart = season + Math.floor((t - season) / DAY) * DAY;
      const pct = goldPassPctAt(options, from, t);
      cached = {
        from: dayStart,
        // A typed-in percentage ends with its season, which is also a boundary here.
        to: Math.min(dayStart + DAY, nextSeasonStart(t, options.seasonStartDay, hour)),
        discount: pct === 0 ? NO_DISCOUNT : { timePct: pct, costPct: pct },
      };
    }
    return cached.discount;
  };
}

function checkStart(day: number, hour: number) {
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    throw new RangeError(`Season start day must be from 1 to 28; got ${day}.`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`Season start hour must be from 0 to 23; got ${hour}.`);
  }
}

function checkPct(pct: number) {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`Gold Pass percent must be a whole number from 0 to 100; got ${pct}.`);
  }
}
