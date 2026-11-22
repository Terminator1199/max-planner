// Game events as time windows the scheduler can ask about.
import type { EventEffect, GameEvent } from "@max-planner/gamedata";
import type { Step } from "../calc/remaining.ts";
import { NO_DISCOUNT, type Discount } from "../time/rounding.ts";

const DAY = 86_400;

export interface EventWindow {
  id: string;
  name: string;
  /** Unix seconds; the window is [start, end). */
  start: number;
  end: number;
  status: "confirmed" | "projected";
  effect: EventEffect;
}

/**
 * Every window of the switched-on events that overlaps [from, to). By default confirmed
 * events are on and projected ones off; pass `enabled` to choose exactly which are on.
 * Recurring entries expand month by month. Each effect of an event is its own window.
 */
export function expandEvents(
  events: readonly GameEvent[],
  from: number,
  to: number,
  enabled?: readonly string[],
): EventWindow[] {
  const on = (e: GameEvent) => (enabled ? enabled.includes(e.id) : e.status === "confirmed");
  const out: EventWindow[] = [];
  const push = (e: GameEvent, start: number, end: number) => {
    if (end <= from || start >= to) return;
    for (const effect of e.effects) {
      out.push({ id: e.id, name: e.name, start, end, status: e.status, effect });
    }
  };
  for (const e of events) {
    if (!on(e)) continue;
    if (e.start && e.end) {
      push(e, Date.parse(e.start) / 1000, Date.parse(e.end) / 1000);
    } else if (e.recurrence) {
      const r = e.recurrence;
      // Start a month early so a window already running at `from` is included.
      const first = new Date((from - r.lengthDays * DAY) * 1000);
      for (let m = 0; ; m++) {
        const start =
          Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + m, r.startDay, r.startHourUtc) /
          1000;
        if (start >= to) break;
        push(e, start, start + r.lengthDays * DAY);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

const discounts = (windows: readonly EventWindow[]) =>
  windows.filter(
    (w): w is EventWindow & { effect: Extract<EventEffect, { kind: "discount" }> } =>
      w.effect.kind === "discount" && w.effect.villages.includes("home"),
  );

/**
 * One discount source per event window, for `SimulateOptions.discounts`. A step that
 * starts inside a window keeps the discount after the window ends. Exclusions name
 * things the planner does not plan yet (supercharges, crafted defenses, equipment).
 */
export function eventDiscounts(windows: readonly EventWindow[]) {
  return discounts(windows).map(
    (w) =>
      (_step: Step, t: number): Discount =>
        t >= w.start && t < w.end
          ? { timePct: w.effect.timePct, costPct: w.effect.costPct }
          : NO_DISCOUNT,
  );
}

/** True while any home-village discount window is open. */
export function saleAt(windows: readonly EventWindow[], t: number): boolean {
  return discounts(windows).some((w) => t >= w.start && t < w.end);
}

/** The end of the latest open discount window at `t`, if one is open. */
export function saleEndsAt(windows: readonly EventWindow[], t: number): number | undefined {
  let end: number | undefined;
  for (const w of discounts(windows)) {
    if (t >= w.start && t < w.end) end = Math.max(end ?? 0, w.end);
  }
  return end;
}

/**
 * When a step may start again if an event stops it starting at `t` (heroes during Clan
 * War League, when the player switches that on); undefined if nothing stops it.
 */
export function blockedUntil(
  windows: readonly EventWindow[],
  step: Step,
  t: number,
): number | undefined {
  if (step.category !== "hero") return undefined;
  let until: number | undefined;
  for (const w of windows) {
    if (w.effect.kind === "noHeroUpgrades" && t >= w.start && t < w.end) {
      until = Math.max(until ?? 0, w.end);
    }
  }
  return until;
}
