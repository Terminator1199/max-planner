// Weekly offline windows in the player's time zone, turned into UTC intervals.

/** One offline window a week: `from` on each listed day until `to`, the next day if earlier. */
export interface OfflineRule {
  /** Days the window starts on: 0 is Sunday, 6 is Saturday. */
  days: readonly number[];
  /** Local start time, "HH:MM". */
  from: string;
  /** Local end time, "HH:MM". At or before `from` means the next day. */
  to: string;
}

export interface OnlineOptions {
  /** IANA time zone, for example "Asia/Kolkata". */
  timeZone: string;
  offline: readonly OfflineRule[];
}

const DAY = 86_400;

/**
 * Answers "is the player online at t" and "when are they next online". Intervals are
 * generated a few days at a time and merged, so lookups are a binary search.
 */
export class OnlineCalendar {
  readonly timeZone: string;
  private readonly rules: { days: Set<number>; from: number; to: number }[];
  private readonly format: Intl.DateTimeFormat;
  /** Merged offline intervals [start, end) in Unix seconds, sorted. */
  private readonly intervals: [number, number][] = [];
  /** Next local day (days since 1970-01-01 in local time) to generate. */
  private nextDay: number;

  constructor(options: OnlineOptions, from: number) {
    this.timeZone = options.timeZone;
    // Throws a RangeError for an unknown zone.
    this.format = new Intl.DateTimeFormat("en-US", {
      timeZone: options.timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    let weekly = 0;
    this.rules = options.offline.map((rule, i) => {
      const fromMin = minutes(rule.from, `offline[${i}].from`);
      const toMin = minutes(rule.to, `offline[${i}].to`);
      if (fromMin === toMin)
        throw new RangeError(`offline[${i}] starts and ends at the same time.`);
      for (const d of rule.days) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          throw new RangeError(`offline[${i}].days holds ${d}; days run from 0 (Sunday) to 6.`);
        }
      }
      const days = new Set(rule.days);
      weekly += days.size * ((toMin - fromMin + 1440) % 1440);
      return { days, from: fromMin, to: toMin };
    });
    if (weekly >= 7 * 1440) throw new RangeError("Offline windows cover the whole week.");
    this.nextDay = this.localDay(from) - 1;
  }

  isOnline(t: number): boolean {
    this.ensure(t);
    const i = this.containing(t);
    return i < 0;
  }

  /** The first online instant at or after `t`. */
  nextOnline(t: number): number {
    for (let guard = 0; guard < 1000; guard++) {
      this.ensure(t);
      const i = this.containing(t);
      if (i < 0) return t;
      t = this.intervals[i]![1];
    }
    throw new Error("Could not find an online time; check the offline windows.");
  }

  /** Offline intervals overlapping [from, to), clipped to it, for the timeline. */
  windows(from: number, to: number): [number, number][] {
    this.ensure(to);
    const out: [number, number][] = [];
    for (const [a, b] of this.intervals) {
      if (b <= from || a >= to) continue;
      out.push([Math.max(a, from), Math.min(b, to)]);
    }
    return out;
  }

  private containing(t: number): number {
    let lo = 0;
    let hi = this.intervals.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.intervals[mid]![0] <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found >= 0 && t < this.intervals[found]![1]) return found;
    return -1;
  }

  /** Generates windows until every interval that could contain `t` exists. */
  private ensure(t: number) {
    // A window starts on its own local day and lasts under a day, so once day D is
    // generated, every window touching a time before the start of day D + 1 is known.
    while (this.toUtc(this.nextDay, 0) <= t + 2 * DAY) {
      const day = this.nextDay++;
      const weekday = new Date(day * DAY * 1000).getUTCDay();
      const today: [number, number][] = [];
      for (const rule of this.rules) {
        if (!rule.days.has(weekday)) continue;
        const endDay = rule.to <= rule.from ? day + 1 : day;
        today.push([this.toUtc(day, rule.from), this.toUtc(endDay, rule.to)]);
      }
      today.sort((a, b) => a[0] - b[0]);
      for (const iv of today) {
        const last = this.intervals.at(-1);
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else this.intervals.push(iv);
      }
    }
  }

  /** Seconds the local clock is ahead of UTC at instant `t`. */
  private offset(t: number): number {
    const parts: Record<string, number> = {};
    for (const p of this.format.formatToParts(new Date(t * 1000))) {
      if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
    const local =
      Date.UTC(
        parts.year!,
        parts.month! - 1,
        parts.day!,
        parts.hour!,
        parts.minute!,
        parts.second!,
      ) / 1000;
    return local - t;
  }

  private localDay(t: number): number {
    return Math.floor((t + this.offset(t)) / DAY);
  }

  /** UTC instant of a local wall time; in a DST gap the later reading wins. */
  private toUtc(day: number, minute: number): number {
    const wall = day * DAY + minute * 60;
    const first = wall - this.offset(wall);
    return wall - this.offset(first);
  }
}

function minutes(text: string, path: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  const h = Number(m?.[1]);
  const min = Number(m?.[2]);
  if (!m || h > 23 || min > 59) throw new RangeError(`${path} must be "HH:MM"; got "${text}".`);
  return h * 60 + min;
}
