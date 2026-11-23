// One scheduling run: a forward event simulation over builders, the Laboratory and the
// Pet House. Each time a worker frees up it takes one ready step, picked by slack
// (steps on the critical path first) and then by value for the chosen strategy.
import type { GameData, Lane, MagicItem, Resource } from "@max-planner/gamedata";
import {
  DEFAULT_ITEM_RULES,
  Inventory,
  potionsFor,
  type Arrival,
  type ItemRules,
  type Waste,
} from "../boost/inventory.ts";
import { MONTH_SECONDS, gemCost, gemsEarned, type GemSettings } from "../boost/gems.ts";
import type { RemainingWork, Step } from "../calc/remaining.ts";
import { blockedUntil, eventDiscounts, saleEndsAt, type EventWindow } from "../events/windows.ts";
import type { OnlineCalendar } from "../time/online.ts";
import { discountedCost, discountedSeconds, type Discount } from "../time/rounding.ts";
import type { Village } from "../types.ts";
import { MinHeap } from "./heap.ts";
import { WEIGHTS, type Strategy } from "./weights.ts";

const HOUR = 3600;
const DAY = 86_400;
const LANES: readonly Lane[] = ["builder", "lab", "petHouse"];

/**
 * Why a step was placed when it was.
 * - `running`: it was already running in the export.
 * - `critical`: its slack was within the threshold, so finishing on time needed it.
 * - `value`: it had the best value per hour among the ready steps.
 * - `only-ready`: nothing else could start.
 * - `instant`: it takes no time, so it happened as soon as it could.
 * - `hammer`: a hammer finished it the moment a worker was free for it.
 */
export type Reason = "running" | "critical" | "value" | "only-ready" | "instant" | "hammer";

/** Percent off a step started at time `t`, from one source such as the Gold Pass. */
export type DiscountSource = (step: Step, t: number) => Discount;

export interface Worker {
  lane: Lane;
  /** Position among the workers of its lane, from 0. */
  index: number;
  opensAt: number;
  /** Set for a temporary worker, such as an event builder seen in the export. */
  closesAt?: number;
}

export interface PlacedStep {
  id: string;
  entityId: number;
  instance: number;
  toLevel: number;
  lane: Lane;
  /** Index into `Plan.workers`; null for a step that takes no time. */
  worker: number | null;
  start: number;
  end: number;
  /** Time on its worker, after discounts, potions and any book. */
  seconds: number;
  baseSeconds: number;
  cost: number;
  resource: Resource;
  /** Discounts applied, in source order, as whole percentages off the time. */
  timePcts: number[];
  reason: Reason;
  /** The worker held idle while this runs, as the Laboratory is during its own upgrade. */
  holds?: number;
  /** The book or hammer that finished it. */
  item?: string;
  /** Gems spent finishing it. */
  gems?: number;
  hall?: true;
}

/** Gems spent finishing a running step. */
export interface GemUse {
  at: number;
  stepId: string;
  gems: number;
  /** Time skipped on the step's worker. */
  savedSeconds: number;
}

export interface ItemUse {
  item: string;
  kind: "potion" | "book" | "hammer";
  at: number;
  /** Potions: the lane sped up. */
  lane?: Lane;
  /** Books and hammers: the step finished. */
  stepId?: string;
  /** Worker time saved: the time skipped, or the potion's bonus for each busy worker. */
  savedSeconds: number;
}

export interface HallDates {
  townHall: number;
  /** When this hall is reached; the export time for the current hall. Null if never. */
  reachedAt: number | null;
  /** When every step this hall allows is done. Null if some step could not be placed. */
  maxedAt: number | null;
}

export interface Plan {
  /** The export time; every step starts at or after it. */
  start: number;
  /** When the last step ends. */
  finish: number;
  /** Ordered by start, then worker. */
  steps: PlacedStep[];
  workers: Worker[];
  halls: HallDates[];
  unplaced: { stepId: string; reason: string }[];
  /**
   * Strategy value delivered in the first 30 days, each step's weight scaled by how early
   * it ends (full at the start, nothing at day 30). Breaks ties between plans that
   * finish together, favouring the one that does the strategy's priorities first.
   */
  valueIn30Days: number;
  /** Choices made between two or more ready steps. */
  decisions: number;
  /** The finish the slack was measured against, as seconds after the start. */
  targetFinish: number;
  /** Magic items used, in time order. */
  itemUses: ItemUse[];
  /** Items that arrived beyond their holding limit before the finish. */
  wasted: Waste[];
  /** Upgrades finished with gems, in time order. */
  gemUses: GemUse[];
  gemsSpent: number;
}

export interface SimulateOptions {
  strategy?: Strategy;
  /** Seconds after the start that slack is measured against. Default: the lower bound. */
  targetFinish?: number;
  /** A step is critical when its slack is at most this. Default 12 hours. */
  criticalSlackSeconds?: number;
  /** Offline windows. No step starts while the player is offline. */
  calendar?: OnlineCalendar;
  /** Delay after an offline window before the first start. Default 10 minutes. */
  wiggleSeconds?: number;
  /** Applied in order; their percentages multiply. */
  discounts?: readonly DiscountSource[];
  /** Entity ids for the Laboratory and Pet House, most wanted first. */
  labPriority?: readonly number[];
  /** Decision numbers at which the second-best step is taken instead of the best. */
  swaps?: ReadonlySet<number>;
  /** Switched-on event windows (see `expandEvents`): discounts and start blocks. */
  events?: readonly EventWindow[];
  /** Repeating helper hours, such as the Lab Assistant's (see `helperBoosts`). */
  helpers?: readonly HelperBoost[];
  /** Magic items to use, with when they arrive (see `arrivals`). */
  boosters?: {
    items: readonly MagicItem[];
    arrivals: readonly Arrival[];
    rules?: Partial<ItemRules>;
  };
  /**
   * Gems to finish upgrades with. They go to running steps with at least `minDays` left
   * that sit on what sets the finish: the lane whose work would end last, or the longest
   * chain. Books are used before gems.
   */
  gems?: GemSettings;
}

/** A helper's boost: `bonus` extra work per second for `length` seconds every `period`. */
export interface HelperBoost {
  lane: Lane;
  bonus: number;
  /** When the first boost starts. */
  first: number;
  period: number;
  length: number;
}

interface WorkerState extends Worker {
  temporary: boolean;
  running?: string;
  busyUntil: number;
  /** The blocking step on another lane that holds this worker idle. */
  heldBy?: string;
  /** A blocking step this worker is waiting for a builder to start. */
  reservedFor?: string;
}

interface Scored {
  step: Step;
  seconds: number;
  critical: boolean;
  slack: number;
  rank: number;
  value: number;
}

interface Event {
  at: number;
  /** 0 = a step finishes, 1 = the player comes back online. Finishes go first. */
  kind: 0 | 1;
  seq: number;
  id?: string;
}

export function simulate(
  work: RemainingWork,
  village: Village,
  gd: GameData,
  options: SimulateOptions = {},
): Plan {
  const strategy = options.strategy ?? "balanced";
  const weights = WEIGHTS[strategy];
  const start = village.exportedAt;
  const targetFinish = options.targetFinish ?? work.lowerBound.seconds;
  const targetAt = start + targetFinish;
  const delta = options.criticalSlackSeconds ?? 12 * HOUR;
  const calendar = options.calendar;
  const wiggle = options.wiggleSeconds ?? 600;
  const windows = options.events ?? [];
  const sources = [...(options.discounts ?? []), ...eventDiscounts(windows)];
  const items = options.boosters?.items ?? [];
  const inventory = options.boosters ? new Inventory(items, options.boosters.arrivals) : undefined;
  const rules: ItemRules = { ...DEFAULT_ITEM_RULES, ...options.boosters?.rules };
  const priority = new Map((options.labPriority ?? []).map((id, i) => [id, i]));

  const steps = new Map(work.steps.map((s) => [s.id, s]));
  const next = new Map<string, string[]>();
  const waiting = new Map<string, number>();
  for (const s of work.steps) {
    waiting.set(s.id, s.after.length);
    for (const p of s.after) {
      const list = next.get(p);
      if (list) list.push(s.id);
      else next.set(p, [s.id]);
    }
  }

  // --- Workers -----------------------------------------------------------------------------
  const hutId = gd.byRole("builderHut")?.id;
  const labId = gd.byRole("laboratory")?.id;
  const petId = gd.byRole("petHouse")?.id;
  const workers: WorkerState[] = [];
  const addWorker = (lane: Lane, at: number, temporary = false): WorkerState => {
    const w: WorkerState = {
      lane,
      index: workers.filter((x) => x.lane === lane).length,
      opensAt: at,
      busyUntil: at,
      temporary,
    };
    workers.push(w);
    return w;
  };
  const built = (id: number | undefined) =>
    id !== undefined && village.instances.some((i) => i.entityId === id && i.level >= 1);
  const needsLane = (lane: Lane) => work.steps.some((s) => s.lane === lane);
  for (let i = 0; i < Math.max(village.builders, 1); i++) addWorker("builder", start);
  // Without the role in the data there is no build step to open the lane, so assume one.
  if (built(labId) || (labId === undefined && needsLane("lab"))) addWorker("lab", start);
  if (built(petId) || (petId === undefined && needsLane("petHouse"))) addWorker("petHouse", start);
  /** The lane a step's completion opens: a new Builder's Hut, Laboratory or Pet House. */
  const opens = (s: Step): Lane | undefined => {
    if (s.toLevel !== 1) return undefined;
    if (s.entityId === hutId) return "builder";
    if (s.entityId === labId) return "lab";
    if (s.entityId === petId) return "petHouse";
    return undefined;
  };
  const isFree = (w: WorkerState, t: number) =>
    w.opensAt <= t && w.closesAt === undefined && !w.running && !w.heldBy;
  /** The permanent worker of a single-worker lane, if it is open at `t`. */
  const laneWorker = (lane: Lane, t: number) =>
    workers.find((w) => w.lane === lane && !w.temporary && w.opensAt <= t);

  // --- Bookkeeping ----------------------------------------------------------------------------
  const ready: Record<Lane, Set<Step>> = {
    builder: new Set(),
    lab: new Set(),
    petHouse: new Set(),
  };
  const instant = new Set<Step>();
  const placed = new Map<string, PlacedStep>();
  const workerOf = new Map<string, WorkerState>();
  const heldOf = new Map<string, WorkerState>();
  const events = new MinHeap<Event>(
    (a, b) =>
      a.at < b.at || (a.at === b.at && (a.kind < b.kind || (a.kind === b.kind && a.seq < b.seq))),
  );
  let seq = 0;
  const wakes = new Set<number>();
  /** Wakes every worker at `at`, once however many ask. */
  const wakeAt = (at: number) => {
    if (wakes.has(at)) return;
    wakes.add(at);
    events.push({ at, kind: 1, seq: seq++ });
  };
  let decisions = 0;
  const done = new Set<string>();
  const running = new Set<string>();
  /** Work left in each placed step, in seconds at the normal rate, after discounts. */
  const workOf = new Map<string, number>();
  const itemUses: ItemUse[] = [];
  /** Base seconds of steps not yet placed, per lane: what each lane still has to do. */
  const unplacedLoad: Record<Lane, number> = { builder: 0, lab: 0, petHouse: 0 };
  for (const st of work.steps) unplacedLoad[st.lane] += st.seconds;

  // --- Work rates ------------------------------------------------------------------------------
  // A potion speeds up every worker of its lane for a while; potions never overlap on a
  // lane, since one is not used while another runs. Helpers add their own repeating
  // hours on top. A lane's rate at any moment is 1 plus every bonus active then.
  const boosts: Record<Lane, { from: number; to: number; bonus: number }[]> = {
    builder: [],
    lab: [],
    petHouse: [],
  };
  const helpers: Record<Lane, HelperBoost[]> = { builder: [], lab: [], petHouse: [] };
  for (const h of options.helpers ?? []) helpers[h.lane].push(h);
  const bonusAt = (lane: Lane, t: number): number => {
    let bonus = 0;
    for (const b of boosts[lane]) if (b.from <= t && t < b.to) bonus += b.bonus;
    for (const h of helpers[lane]) {
      if (t < h.first) continue;
      if ((t - h.first) % h.period < h.length) bonus += h.bonus;
    }
    return bonus;
  };
  /** The next moment after `t` at which a lane's rate can change. */
  const nextChange = (lane: Lane, t: number): number => {
    let next = Infinity;
    for (const b of boosts[lane]) {
      if (b.from > t) next = Math.min(next, b.from);
      else if (b.to > t) next = Math.min(next, b.to);
    }
    for (const h of helpers[lane]) {
      if (t < h.first) next = Math.min(next, h.first);
      else {
        const start = t - ((t - h.first) % h.period);
        next = Math.min(next, t < start + h.length ? start + h.length : start + h.period);
      }
    }
    return next;
  };
  /** When `amount` seconds of work started at `begin` are done, at the lane's rates. */
  const endFor = (begin: number, amount: number, lane: Lane): number => {
    let t = begin;
    let left = amount;
    for (;;) {
      const rate = 1 + bonusAt(lane, t);
      const next = nextChange(lane, t);
      if (next === Infinity || left <= (next - t) * rate) return t + Math.ceil(left / rate);
      left -= (next - t) * rate;
      t = next;
    }
  };
  /** Work done between `begin` and `t` on a lane. */
  const doneBy = (begin: number, t: number, lane: Lane): number => {
    let total = 0;
    for (let at = begin; at < t; ) {
      const next = Math.min(t, nextChange(lane, at));
      total += (next - at) * (1 + bonusAt(lane, at));
      at = next;
    }
    return total;
  };
  const boostedAt = (lane: Lane, t: number) => boosts[lane].some((b) => b.from <= t && t < b.to);

  const enqueue = (s: Step) => {
    if (s.inProgress) return;
    if (s.seconds === 0) instant.add(s);
    else ready[s.lane].add(s);
  };

  const discountsAt = (s: Step, t: number): Discount[] =>
    s.inProgress ? [] : sources.map((f) => f(s, t));
  const durationAt = (s: Step, t: number) =>
    sources.length === 0 || s.inProgress
      ? s.seconds
      : discountedSeconds(
          s.seconds,
          discountsAt(s, t).map((d) => d.timePct),
        );

  const place = (s: Step, w: WorkerState | null, t: number, reason: Reason, item?: string) => {
    const ds = discountsAt(s, t);
    const amount = discountedSeconds(
      s.seconds,
      ds.map((d) => d.timePct),
    );
    // A hammer finishes the step now, at no cost.
    const cost =
      reason === "hammer"
        ? 0
        : discountedCost(
            s.cost,
            ds.map((d) => d.costPct),
          );
    const end = w ? endFor(t, amount, s.lane) : t;
    const seconds = end - t;
    const p: PlacedStep = {
      id: s.id,
      entityId: s.entityId,
      instance: s.instance,
      toLevel: s.toLevel,
      lane: s.lane,
      worker: w ? workers.indexOf(w) : null,
      start: t,
      end,
      seconds,
      baseSeconds: s.seconds,
      cost,
      resource: s.resource,
      timePcts: ds.map((d) => d.timePct).filter((x) => x > 0),
      reason,
      ...(item ? { item } : {}),
      ...(s.hall ? { hall: true as const } : {}),
    };
    placed.set(s.id, p);
    workOf.set(s.id, amount);
    unplacedLoad[s.lane] -= s.seconds;
    ready[s.lane].delete(s);
    instant.delete(s);
    if (w) {
      w.running = s.id;
      w.busyUntil = p.end;
      workerOf.set(s.id, w);
      running.add(s.id);
    }
    if (s.blocksLane) {
      const held = laneWorker(s.blocksLane, t);
      if (held && !held.running && !held.heldBy) {
        held.heldBy = s.id;
        held.reservedFor = undefined;
        held.busyUntil = p.end;
        heldOf.set(s.id, held);
        p.holds = workers.indexOf(held);
      }
    }
    // A step without a worker takes no time; its caller completes it on the spot.
    if (w) events.push({ at: p.end, kind: 0, seq: seq++, id: s.id });
    return p;
  };

  const complete = (id: string, t: number) => {
    if (done.has(id)) return;
    done.add(id);
    running.delete(id);
    const s = steps.get(id)!;
    const w = workerOf.get(id);
    if (w) {
      w.running = undefined;
      if (w.temporary) w.closesAt = t;
    }
    const held = heldOf.get(id);
    if (held) held.heldBy = undefined;
    const lane = opens(s);
    if (lane && (lane === "builder" || !workers.some((x) => x.lane === lane && !x.temporary))) {
      addWorker(lane, t);
    }
    for (const q of next.get(id) ?? []) {
      const left = waiting.get(q)! - 1;
      waiting.set(q, left);
      if (left === 0) enqueue(steps.get(q)!);
    }
  };

  // --- Scoring -------------------------------------------------------------------------------
  const score = (s: Step, t: number): Scored => {
    const seconds = durationAt(s, t);
    const slack = targetAt - t - (work.tail.get(s.id) ?? s.seconds);
    let value = weights[s.category] / Math.max(seconds / HOUR, 1 / 60);
    if (calendar) {
      // A step that ends while the player is offline leaves its worker idle until they
      // are back, which costs as much as the wait.
      const end = t + seconds;
      const idle = calendar.nextOnline(end) - end;
      value *= seconds / (seconds + idle);
    }
    const rank = s.lane !== "builder" ? (priority.get(s.entityId) ?? Infinity) : Infinity;
    return { step: s, seconds, critical: slack <= delta, slack, rank, value };
  };
  const better = (a: Scored, b: Scored): number => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (a.critical) {
      if (a.slack !== b.slack) return a.slack - b.slack;
    } else {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.value !== b.value) return b.value - a.value;
    }
    if (a.seconds !== b.seconds) return b.seconds - a.seconds;
    return compareIds(a.step, b.step);
  };
  /**
   * The best and second-best candidates, in one pass: a decision needs no more, and
   * sorting every ready step at every decision was most of a run's time.
   */
  const top2 = (lists: Iterable<Step>[], t: number, keep?: (s: Step) => boolean): Scored[] => {
    let first: Scored | undefined;
    let second: Scored | undefined;
    for (const list of lists) {
      for (const s of list) {
        if (keep && !keep(s)) continue;
        const c = score(s, t);
        if (!first || better(c, first) < 0) {
          second = first;
          first = c;
        } else if (!second || better(c, second) < 0) second = c;
      }
    }
    return first ? (second ? [first, second] : [first]) : [];
  };
  /** Picks from the top two, honouring swaps, and names the reason. */
  const choose = (top: Scored[]): { pick: Scored; reason: Reason } => {
    if (top.length === 1) return { pick: top[0]!, reason: "only-ready" };
    const n = decisions++;
    const pick = options.swaps?.has(n) ? top[1]! : top[0]!;
    return { pick, reason: pick.critical ? "critical" : "value" };
  };

  /** A blocking step can start once the worker it holds is free, or reserved for it. */
  const canHold = (s: Step, t: number) => {
    if (!s.blocksLane) return true;
    const held = laneWorker(s.blocksLane, t);
    if (!held) return true;
    return isFree(held, t) && (held.reservedFor === undefined || held.reservedFor === s.id);
  };

  /** An event stops this step starting now; the workers look again when it ends. */
  const blocked = (s: Step, t: number) => {
    const until = blockedUntil(windows, s, t);
    if (until === undefined) return false;
    wakeAt(until);
    return true;
  };

  // --- Magic items -----------------------------------------------------------------------------
  const hammers = items.filter((i) => i.kind === "hammer");
  const books = items.filter((i) => i.kind === "book");

  /**
   * While a worker is free, each hammer in stock finishes the best waiting step of its
   * categories that is at least `hammerMinDays` long; the worker then picks again.
   */
  const useHammers = (lane: Lane, t: number) => {
    if (!inventory) return;
    for (const hammer of hammers) {
      while (inventory.available(hammer.id, t) > 0) {
        const [best] = top2(
          [ready[lane]],
          t,
          (s) =>
            hammer.categories!.includes(s.category) &&
            durationAt(s, t) >= rules.hammerMinDays * DAY &&
            canHold(s, t) &&
            !blocked(s, t),
        );
        if (!best) break;
        inventory.use(hammer.id, t);
        itemUses.push({
          item: hammer.id,
          kind: "hammer",
          at: t,
          stepId: best.step.id,
          savedSeconds: best.seconds,
        });
        place(best.step, null, t, "hammer", hammer.id);
        complete(best.step.id, t);
      }
    }
  };

  /**
   * Books finish running steps with at least `bookMinDays` left, longest first. Book of
   * Everything is used only when no other book in stock fits the step.
   */
  const useBooks = (t: number): boolean => {
    if (!inventory || books.length === 0) return false;
    if (rules.saveBooksForFullPrice) {
      const saleEnd = saleEndsAt(windows, t);
      if (saleEnd !== undefined) {
        wakeAt(saleEnd);
        return false;
      }
    }
    let used = false;
    for (;;) {
      const candidates = [...running]
        .map((id) => placed.get(id)!)
        .filter((p) => p.end - t >= rules.bookMinDays * DAY)
        .sort((a, b) => b.end - a.end || compareIds(steps.get(a.id)!, steps.get(b.id)!));
      let usedNow = false;
      for (const p of candidates) {
        const category = steps.get(p.id)!.category;
        const fits = books.filter(
          (b) => b.categories!.includes(category) && inventory.available(b.id, t) > 0,
        );
        const book = fits.find((b) => !b.fallbackOnly) ?? fits[0];
        if (!book) continue;
        inventory.use(book.id, t);
        itemUses.push({
          item: book.id,
          kind: "book",
          at: t,
          stepId: p.id,
          savedSeconds: p.end - t,
        });
        p.end = t;
        p.seconds = t - p.start;
        p.item = book.id;
        complete(p.id, t);
        usedNow = used = true;
        break;
      }
      if (!usedNow) return used;
    }
  };

  /**
   * A potion is used when every worker of its lane is busy with at least as much work
   * left as the potion can do: 10 hours for builders, 24 for the Laboratory or Pet House.
   */
  const usePotions = (t: number) => {
    if (!inventory || rules.potions === "off") return;
    for (const lane of LANES) {
      if (boostedAt(lane, t)) continue;
      const ws = workers.filter(
        (w) => w.lane === lane && w.opensAt <= t && w.closesAt === undefined,
      );
      if (ws.length === 0) continue;
      for (const potion of potionsFor(items, lane)) {
        if (inventory.available(potion.id, t) === 0) continue;
        const bonus = potion.rateBonus!;
        const length = potion.seconds!;
        const allBusy = ws.every((w) => {
          if (!w.running) return false;
          const p = placed.get(w.running)!;
          return workOf.get(p.id)! - doneBy(p.start, t, lane) >= (1 + bonus) * length;
        });
        if (!allBusy) continue;
        inventory.use(potion.id, t);
        boosts[lane].push({ from: t, to: t + length, bonus });
        itemUses.push({
          item: potion.id,
          kind: "potion",
          at: t,
          lane,
          savedSeconds: bonus * length * ws.length,
        });
        for (const w of ws) {
          const p = placed.get(w.running!)!;
          p.end = endFor(p.start, workOf.get(p.id)!, lane);
          p.seconds = p.end - p.start;
          w.busyUntil = p.end;
          const held = heldOf.get(p.id);
          if (held) held.busyUntil = p.end;
          events.push({ at: p.end, kind: 0, seq: seq++, id: p.id });
        }
        break;
      }
    }
  };

  // --- Gems ----------------------------------------------------------------------------------
  const gems = options.gems;
  const gemUses: GemUse[] = [];
  let gemsSpent = 0;
  const gemsLeft = (t: number) =>
    gems ? gemsEarned(gems, start, t) - gemsSpent - Math.max(0, gems.reserve) : 0;
  /** Each lane's average work rate per worker, counting its helpers' daily hours. */
  const avgRate: Record<Lane, number> = { builder: 1, lab: 1, petHouse: 1 };
  for (const h of options.helpers ?? []) avgRate[h.lane] += (h.bonus * h.length) / h.period;
  /** When each lane would finish all its work, if its workers never idled. */
  const laneEnds = (t: number): Record<Lane, number> => {
    const load: Record<Lane, number> = { ...unplacedLoad };
    for (const id of running) {
      const p = placed.get(id)!;
      load[p.lane] += Math.max(0, workOf.get(id)! - doneBy(p.start, t, p.lane));
    }
    const ends = { builder: t, lab: t, petHouse: t };
    for (const lane of LANES) {
      const n = workers.filter(
        (w) => w.lane === lane && w.opensAt <= t && w.closesAt === undefined,
      ).length;
      if (n > 0) ends[lane] = t + load[lane] / (n * avgRate[lane]);
    }
    return ends;
  };

  /**
   * Finishes one running step with gems if it is on what sets the finish now: its lane's
   * work would end last, or its chain of upgrades would. Among those, the one pressing
   * hardest, then the longest, since a gem buys more time on a long timer.
   */
  const useGems = (t: number): boolean => {
    if (!gems) return false;
    const budget = gemsLeft(t);
    if (budget <= 0 && gems.perMonth <= 0) return false;
    const ends = laneEnds(t);
    const chainEnd = (p: PlacedStep) => {
      const s = steps.get(p.id)!;
      return p.end + (work.tail.get(p.id) ?? s.seconds) - s.seconds;
    };
    let finish = Math.max(ends.builder, ends.lab, ends.petHouse);
    for (const id of running) finish = Math.max(finish, chainEnd(placed.get(id)!));
    for (const lane of LANES) {
      for (const s of ready[lane])
        finish = Math.max(finish, t + (work.tail.get(s.id) ?? s.seconds));
    }
    let best: { p: PlacedStep; left: number; pressure: number; cost: number } | undefined;
    /** When the monthly gems first cover a step that is too dear now. */
    let affordableAt = Infinity;
    for (const id of running) {
      const p = placed.get(id)!;
      // Time left at the normal rate: what the game's timer shows and prices.
      const left = Math.ceil(workOf.get(id)! - doneBy(p.start, t, p.lane));
      if (left < gems.minDays * DAY) continue;
      const pressure = Math.max(ends[p.lane], chainEnd(p));
      if (pressure < finish - delta) continue;
      const cost = gemCost(left);
      if (cost > budget) {
        // The price only falls as the timer runs, so by then it is affordable.
        if (gems.perMonth > 0) {
          const need = cost - Math.max(0, budget);
          const at = t + Math.ceil((need * MONTH_SECONDS) / gems.perMonth);
          if (at < p.end) affordableAt = Math.min(affordableAt, at);
        }
        continue;
      }
      if (
        !best ||
        pressure > best.pressure ||
        (pressure === best.pressure &&
          (left > best.left ||
            (left === best.left && compareIds(steps.get(id)!, steps.get(best.p.id)!) < 0)))
      ) {
        best = { p, left, pressure, cost };
      }
    }
    if (!best) {
      if (affordableAt < Infinity) wakeAt(affordableAt);
      return false;
    }
    const { p, cost } = best;
    gemsSpent += cost;
    gemUses.push({ at: t, stepId: p.id, gems: cost, savedSeconds: p.end - t });
    p.end = t;
    p.seconds = t - p.start;
    p.gems = cost;
    complete(p.id, t);
    return true;
  };

  // --- Decisions -----------------------------------------------------------------------------
  const assignBuilder = (w: WorkerState, t: number) => {
    // A Laboratory or Pet House already waiting for this upgrade gets the builder first.
    for (const s of ready.builder) {
      if (
        s.blocksLane &&
        laneWorker(s.blocksLane, t)?.reservedFor === s.id &&
        canHold(s, t) &&
        !blocked(s, t)
      ) {
        place(s, w, t, score(s, t).critical ? "critical" : "value");
        return;
      }
    }
    useHammers("builder", t);
    const top = top2([ready.builder], t, (s) => canHold(s, t) && !blocked(s, t));
    if (top.length === 0) return;
    const { pick, reason } = choose(top);
    place(pick.step, w, t, reason);
  };

  const assignSingle = (w: WorkerState, t: number) => {
    if (w.reservedFor) {
      backfill(w, t);
      return;
    }
    // Upgrading this building stops the lane, so its upgrade competes with the lane's
    // own work: if it wins, the worker waits for a builder instead of starting research.
    useHammers(w.lane, t);
    const top = top2(
      [ready[w.lane], ready.builder],
      t,
      (s) => (s.lane === w.lane || s.blocksLane === w.lane) && !blocked(s, t),
    );
    if (top.length === 0) return;
    const { pick, reason } = choose(top);
    if (pick.step.lane === w.lane) {
      place(pick.step, w, t, reason);
      return;
    }
    w.reservedFor = pick.step.id;
    backfill(w, t);
  };

  /** While reserved, take only work that ends before a builder can be free. */
  const backfill = (w: WorkerState, t: number) => {
    const s = steps.get(w.reservedFor!)!;
    const freeBuilder = workers.find((b) => b.lane === "builder" && isFree(b, t));
    if (freeBuilder && canHold(s, t) && !blocked(s, t)) {
      place(s, freeBuilder, t, score(s, t).critical ? "critical" : "value");
      return;
    }
    let soonest = Infinity;
    for (const b of workers) {
      if (b.lane === "builder" && b.closesAt === undefined && b.running) {
        soonest = Math.min(soonest, b.busyUntil);
      }
    }
    const top = top2([ready[w.lane]], t, (r) => t + durationAt(r, t) <= soonest && !blocked(r, t));
    if (top.length === 0) return;
    const { pick, reason } = choose(top);
    place(pick.step, w, t, reason);
  };

  const decide = (t: number) => {
    // Nothing starts and no item is used while the player is offline.
    if (calendar && !calendar.isOnline(t)) {
      wakeAt(calendar.nextOnline(calendar.nextOnline(t) + wiggle));
      return;
    }
    // A book or gems free a worker, so the workers pick again until neither is used.
    do {
      while (instant.size > 0) {
        for (const s of [...instant].sort(compareIds)) {
          place(s, null, t, "instant");
          complete(s.id, t);
        }
      }
      for (const lane of LANES) {
        for (const w of workers) {
          if (w.lane !== lane || !isFree(w, t)) continue;
          if (lane === "builder") assignBuilder(w, t);
          else assignSingle(w, t);
        }
      }
    } while (useBooks(t) || useGems(t));
    // Potions last, once every worker that can be busy is.
    usePotions(t);
  };

  // --- Run -------------------------------------------------------------------------------------
  // Steps running in the export occupy their workers from the start. Any beyond the
  // workers the village has, such as an event builder's, get a temporary worker.
  const pinned = work.steps.filter((s) => s.inProgress);
  pinned.sort((a, b) => Number(!!a.blocksLane) - Number(!!b.blocksLane) || compareIds(a, b));
  for (const s of pinned) {
    const w =
      workers.find((x) => x.lane === s.lane && isFree(x, start)) ?? addWorker(s.lane, start, true);
    place(s, w, start, "running");
  }
  for (const s of work.steps) if (!s.inProgress && waiting.get(s.id) === 0) enqueue(s);

  let lastDecision = start;
  decide(start);
  while (events.size > 0) {
    // Every finish at `t` lands before anyone picks, so all newly ready steps compete.
    const t = events.peek()!.at;
    lastDecision = t;
    while (events.size > 0 && events.peek()!.at === t) {
      const e = events.pop()!;
      if (e.kind === 1) wakes.delete(t);
      // A potion or book may have moved the end; only the current end counts.
      else if (placed.get(e.id!)!.end === t) complete(e.id!, t);
    }
    decide(t);
  }

  // --- Result ----------------------------------------------------------------------------------
  const unplaced: Plan["unplaced"] = [];
  for (const s of work.steps) {
    if (placed.has(s.id)) continue;
    const lane = s.lane;
    unplaced.push({
      stepId: s.id,
      reason: workers.some((w) => w.lane === lane)
        ? "Waits on a step that could not be placed."
        : `No ${lane === "petHouse" ? "Pet House" : lane === "lab" ? "Laboratory" : "builder"} to do it.`,
    });
  }

  const list = [...placed.values()].sort(
    (a, b) =>
      a.start - b.start ||
      (a.worker ?? -1) - (b.worker ?? -1) ||
      compareIds(steps.get(a.id)!, steps.get(b.id)!),
  );
  let finish = start;
  let valueIn30Days = 0;
  for (const p of list) {
    finish = Math.max(finish, p.end);
    const elapsed = p.end - start;
    if (p.reason !== "running" && elapsed < 30 * DAY) {
      valueIn30Days += weights[steps.get(p.id)!.category] * (1 - elapsed / (30 * DAY));
    }
  }

  const halls: HallDates[] = [];
  for (let r = work.currentTownHall; r <= work.targetTownHall; r++) {
    const hallStep = work.steps.find((s) => s.hall && s.toLevel === r);
    const reachedAt =
      r === work.currentTownHall ? start : hallStep ? (placed.get(hallStep.id)?.end ?? null) : null;
    let maxedAt: number | null = start;
    for (const s of work.steps) {
      if ((s.hall ? s.toLevel : s.townHall) > r) continue;
      const p = placed.get(s.id);
      if (!p) {
        maxedAt = null;
        break;
      }
      maxedAt = Math.max(maxedAt, p.end);
    }
    halls.push({ townHall: r, reachedAt, maxedAt });
  }

  // Count arrivals up to the finish, so items wasted before it are reported.
  if (inventory && items[0]) inventory.available(items[0].id, Math.max(finish, lastDecision));

  return {
    start,
    finish,
    steps: list,
    workers: workers.map(({ lane, index, opensAt, closesAt }) =>
      closesAt === undefined ? { lane, index, opensAt } : { lane, index, opensAt, closesAt },
    ),
    halls,
    unplaced,
    valueIn30Days: Math.round(valueIn30Days * 1e6) / 1e6,
    decisions,
    targetFinish,
    itemUses,
    wasted: inventory?.wasted() ?? [],
    gemUses,
    gemsSpent,
  };
}

/** Orders steps by entity, then instance, then level, for stable tie-breaks. */
export function compareIds(a: Step, b: Step): number {
  return a.entityId - b.entityId || a.instance - b.instance || a.toLevel - b.toLevel;
}
