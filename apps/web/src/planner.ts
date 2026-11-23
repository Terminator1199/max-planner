// One planning request: the export text and the settings in, everything the pages show
// out. Runs in the worker, or on the page if a worker cannot start. Output is plain data.
import {
  OnlineCalendar,
  arrivals,
  expandEvents,
  goldPassDiscount,
  helperBoosts,
  parseExport,
  progress,
  remainingWork,
  searchWithItems,
  type EventWindow,
  type ImportReport,
  type ItemRules,
  type LowerBound,
  type Plan,
  type Progress,
  type Strategy,
  type Totals,
  type Village,
} from "@max-planner/core";
import type { Context } from "./context.ts";

export interface PlanSettings {
  /** Target hall; null means the village's own. */
  target: number | null;
  strategy: Strategy;
  goldPass: boolean;
  /** The Gold Pass boost the game shows now, if the player typed it in. */
  goldPassPct: number | null;
  offline: { on: boolean; from: string; to: string };
  timeZone: string;
  helpers: boolean;
  stock: Record<string, number>;
  perMonth: Record<string, number>;
  /** Switched-on events; null means the defaults (confirmed on, estimates off). */
  enabled: string[] | null;
  rules: ItemRules;
}

export interface PlanInput {
  text: string;
  settings: PlanSettings;
  /** Now, in Unix seconds, for the stale-export warning; left out for the demo. */
  now?: number;
}

export type PlanOutput =
  | {
      ok: true;
      village: Village;
      report: ImportReport;
      target: number;
      totals: Totals;
      lowerBound: LowerBound;
      notes: string[];
      unplannable: number;
      progress: Progress;
      plan: Plan;
      /** When the target hall is maxed without any items. */
      withoutItemsMaxedAt: number;
      savedSeconds: number;
      /** False when items are set but no plan with them beat the plan without them. */
      itemsHelp: boolean;
      /** True when any item is in stock or expected. */
      hasItems: boolean;
      hash: string;
      runs: number;
      stoppedEarly: boolean;
      ms: number;
      windows: EventWindow[];
      offline: [number, number][];
    }
  | { ok: false; message: string };

const YEARS = 6 * 365 * 86_400;

export function planVillage(ctx: Context, input: PlanInput): PlanOutput {
  const started = performance.now();
  const { gd, items, events, seasons } = ctx;
  const s = input.settings;
  const parsed = parseExport(input.text, gd, input.now === undefined ? {} : { now: input.now });
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  const { village, report } = parsed;
  const target = Math.min(gd.maxTownHall, Math.max(village.townHall, s.target ?? village.townHall));
  const work = remainingWork(village, gd, { targetTownHall: target });
  const from = village.exportedAt;
  let calendar: OnlineCalendar | undefined;
  if (s.offline.on) {
    try {
      calendar = new OnlineCalendar(
        {
          timeZone: s.timeZone,
          offline: [{ days: [0, 1, 2, 3, 4, 5, 6], from: s.offline.from, to: s.offline.to }],
        },
        from,
      );
    } catch (e) {
      return { ok: false, message: `Offline hours: ${(e as Error).message}` };
    }
  }
  const hasItems = [...Object.values(s.stock), ...Object.values(s.perMonth)].some((n) => n > 0);
  const windows = expandEvents(events, from, from + YEARS, s.enabled ?? undefined);
  const result = searchWithItems(work, village, gd, {
    strategy: s.strategy,
    seed: seedOf(input.text),
    variants: 24,
    clock: () => performance.now(),
    budgetMs: 900,
    ...(calendar ? { calendar } : {}),
    ...(s.helpers ? { helpers: helperBoosts(village) } : {}),
    discounts: s.goldPass
      ? [
          goldPassDiscount(
            {
              pace: seasons.goldPassBoostPace,
              seasonStartDay: seasons.seasonStartDay,
              ...(s.goldPassPct === null ? {} : { currentPct: s.goldPassPct }),
            },
            from,
          ),
        ]
      : [],
    events: windows,
    boosters: {
      items,
      arrivals: arrivals(
        { stock: s.stock, perMonth: s.perMonth },
        seasons.seasonStartDay,
        from,
        from + YEARS,
      ),
      rules: s.rules,
    },
  });
  const plan = result.withItems.plan;
  const maxed = (p: Plan) => p.halls.at(-1)?.maxedAt ?? p.finish;
  return {
    ok: true,
    village,
    report,
    target,
    totals: work.totals,
    lowerBound: work.lowerBound,
    notes: work.notes,
    unplannable: work.unplannable.length,
    progress: progress(village, gd, work),
    plan,
    withoutItemsMaxedAt: maxed(result.withoutItems.plan),
    savedSeconds: Math.max(0, maxed(result.withoutItems.plan) - maxed(plan)),
    itemsHelp: result.itemsHelp,
    hasItems,
    hash: result.withItems.hash,
    runs:
      result.withItems.runs +
      (result.withoutItems === result.withItems ? 0 : result.withoutItems.runs),
    stoppedEarly: result.withItems.stoppedEarly,
    ms: Math.round(performance.now() - started),
    windows,
    offline: calendar
      ? calendar.windows(plan.start, Math.max(plan.finish, plan.start + 86_400))
      : [],
  };
}

/** The same export always plans the same way. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
