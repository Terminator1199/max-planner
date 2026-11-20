// Magic items: when they arrive, how many can be held, and when they are used.
import type { Lane, MagicItem, SeasonsFile } from "@max-planner/gamedata";
import { nextSeasonStart, seasonStartAt } from "../time/goldpass.ts";

export type ArrivalSource = "stock" | "monthly";

export interface Arrival {
  item: string;
  at: number;
  count: number;
  source: ArrivalSource;
}

/** What the player has and expects, as set in the booster picker. */
export interface BoosterSettings {
  /** Items in hand at the export time. */
  stock: Readonly<Record<string, number>>;
  /** Items expected each month, from every source together. */
  perMonth: Readonly<Record<string, number>>;
}

/** When the scheduler uses items. The LLD's defaults. */
export interface ItemRules {
  /** "off" keeps potions for the player to use by hand. */
  potions: "auto" | "off";
  /** A book is used on a running step with at least this many days left. */
  bookMinDays: number;
  /** Keep books while an event discount runs, since a book then saves less. */
  saveBooksForFullPrice: boolean;
  /** A hammer is used on a waiting step at least this many days long. */
  hammerMinDays: number;
}

export const DEFAULT_ITEM_RULES: Readonly<ItemRules> = Object.freeze({
  potions: "auto",
  bookMinDays: 3,
  saveBooksForFullPrice: true,
  hammerMinDays: 5,
});

/** The monthly counts seasons.json suggests: every source, Gold Pass ones if the player has it. */
export function defaultPerMonth(seasons: SeasonsFile, goldPass: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [item, c] of Object.entries(seasons.perMonth)) {
    const n = c.free + c.clanGames + c.other + (goldPass ? c.goldPass : 0);
    if (n > 0) out[item] = n;
  }
  return out;
}

/**
 * Stock arrives at the export time. Monthly counts are spread evenly over each season,
 * at the middle of equal slices, from the export time to `to`.
 */
export function arrivals(
  settings: BoosterSettings,
  seasonStartDay: number,
  from: number,
  to: number,
  seasonStartHourUtc = 8,
): Arrival[] {
  const out: Arrival[] = [];
  for (const [item, count] of Object.entries(settings.stock)) {
    if (count > 0) out.push({ item, at: from, count, source: "stock" });
  }
  for (const [item, n] of Object.entries(settings.perMonth)) {
    if (n <= 0) continue;
    for (let s = seasonStartAt(from, seasonStartDay, seasonStartHourUtc); s < to; ) {
      const e = nextSeasonStart(s, seasonStartDay, seasonStartHourUtc);
      for (let k = 0; k < n; k++) {
        const at = s + Math.floor(((2 * k + 1) * (e - s)) / (2 * n));
        if (at > from && at <= to) out.push({ item, at, count: 1, source: "monthly" });
      }
      s = e;
    }
  }
  return out.sort((a, b) => a.at - b.at || a.item.localeCompare(b.item));
}

export interface Waste {
  item: string;
  at: number;
  count: number;
}

/**
 * Items in hand over time. Time only moves forward, as in the scheduler. An arrival
 * beyond the holding limit is wasted and recorded, so the page can say "use a potion
 * before the 1st".
 */
export class Inventory {
  private readonly limit = new Map<string, number>();
  private readonly count = new Map<string, number>();
  private readonly queue: Arrival[];
  private next = 0;
  private now = -Infinity;
  private readonly lost: Waste[] = [];

  constructor(items: readonly MagicItem[], incoming: readonly Arrival[]) {
    for (const i of items) this.limit.set(i.id, i.holdLimit);
    this.queue = [...incoming].sort((a, b) => a.at - b.at || a.item.localeCompare(b.item));
  }

  available(item: string, t: number): number {
    this.advance(t);
    return this.count.get(item) ?? 0;
  }

  use(item: string, t: number): void {
    const n = this.available(item, t);
    if (n <= 0) throw new Error(`No ${item} left at ${t}.`);
    this.count.set(item, n - 1);
  }

  wasted(): Waste[] {
    return [...this.lost];
  }

  private advance(t: number) {
    if (t < this.now) throw new Error("The inventory only moves forward in time.");
    this.now = t;
    while (this.next < this.queue.length && this.queue[this.next]!.at <= t) {
      const a = this.queue[this.next++]!;
      const limit = this.limit.get(a.item);
      if (limit === undefined) throw new Error(`Unknown magic item ${a.item}.`);
      const have = this.count.get(a.item) ?? 0;
      const kept = Math.min(limit - have, a.count);
      this.count.set(a.item, have + Math.max(0, kept));
      if (kept < a.count)
        this.lost.push({ item: a.item, at: a.at, count: a.count - Math.max(0, kept) });
    }
  }
}

/** Potions in stock for a lane, in file order. */
export function potionsFor(items: readonly MagicItem[], lane: Lane): MagicItem[] {
  return items.filter((i) => i.kind === "potion" && i.lanes?.includes(lane));
}
