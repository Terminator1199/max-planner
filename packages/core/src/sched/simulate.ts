// One scheduling run: a forward event simulation over builders, the Laboratory and the
// Pet House. Each time a worker frees up it takes one ready step, picked by slack
// (steps on the critical path first) and then by value for the chosen strategy.
import type { GameData, Lane, Resource } from "@max-planner/gamedata";
import type { RemainingWork, Step } from "../calc/remaining.ts";
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
 */
export type Reason = "running" | "critical" | "value" | "only-ready" | "instant";

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
  /** Time it took, after discounts. */
  seconds: number;
  baseSeconds: number;
  cost: number;
  resource: Resource;
  /** Discounts applied, in source order, as whole percentages off the time. */
  timePcts: number[];
  reason: Reason;
  /** The worker held idle while this runs, as the Laboratory is during its own upgrade. */
  holds?: number;
  hall?: true;
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
  /** Strategy value of the steps that end within 30 days; breaks ties between plans. */
  valueIn30Days: number;
  /** Choices made between two or more ready steps. */
  decisions: number;
  /** The finish the slack was measured against, as seconds after the start. */
  targetFinish: number;
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
  const sources = options.discounts ?? [];
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
  const ready: Record<Lane, Set<string>> = {
    builder: new Set(),
    lab: new Set(),
    petHouse: new Set(),
  };
  const instant = new Set<string>();
  const placed = new Map<string, PlacedStep>();
  const workerOf = new Map<string, WorkerState>();
  const heldOf = new Map<string, WorkerState>();
  const events = new MinHeap<Event>(
    (a, b) =>
      a.at < b.at || (a.at === b.at && (a.kind < b.kind || (a.kind === b.kind && a.seq < b.seq))),
  );
  let seq = 0;
  const wakes = new Set<number>();
  let decisions = 0;

  const enqueue = (s: Step) => {
    if (s.inProgress) return;
    if (s.seconds === 0) instant.add(s.id);
    else ready[s.lane].add(s.id);
  };

  const discountsAt = (s: Step, t: number): Discount[] =>
    s.inProgress ? [] : sources.map((f) => f(s, t));
  const durationAt = (s: Step, t: number) =>
    discountedSeconds(
      s.seconds,
      discountsAt(s, t).map((d) => d.timePct),
    );

  const place = (s: Step, w: WorkerState | null, t: number, reason: Reason) => {
    const ds = discountsAt(s, t);
    const seconds = discountedSeconds(
      s.seconds,
      ds.map((d) => d.timePct),
    );
    const cost = discountedCost(
      s.cost,
      ds.map((d) => d.costPct),
    );
    const p: PlacedStep = {
      id: s.id,
      entityId: s.entityId,
      instance: s.instance,
      toLevel: s.toLevel,
      lane: s.lane,
      worker: w ? workers.indexOf(w) : null,
      start: t,
      end: t + seconds,
      seconds,
      baseSeconds: s.seconds,
      cost,
      resource: s.resource,
      timePcts: ds.map((d) => d.timePct).filter((x) => x > 0),
      reason,
      ...(s.hall ? { hall: true as const } : {}),
    };
    placed.set(s.id, p);
    ready[s.lane].delete(s.id);
    instant.delete(s.id);
    if (w) {
      w.running = s.id;
      w.busyUntil = p.end;
      workerOf.set(s.id, w);
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
  const ranked = (list: Iterable<Step>, t: number) =>
    [...list].map((s) => score(s, t)).sort(better);
  /** Picks from a ranked list, honouring swaps, and names the reason. */
  const choose = (list: Scored[]): { pick: Scored; reason: Reason } => {
    if (list.length === 1) return { pick: list[0]!, reason: "only-ready" };
    const n = decisions++;
    const pick = options.swaps?.has(n) ? list[1]! : list[0]!;
    return { pick, reason: pick.critical ? "critical" : "value" };
  };

  /** A blocking step can start once the worker it holds is free, or reserved for it. */
  const canHold = (s: Step, t: number) => {
    if (!s.blocksLane) return true;
    const held = laneWorker(s.blocksLane, t);
    if (!held) return true;
    return isFree(held, t) && (held.reservedFor === undefined || held.reservedFor === s.id);
  };

  // --- Decisions -----------------------------------------------------------------------------
  const assignBuilder = (w: WorkerState, t: number) => {
    const startable = [...ready.builder].map((id) => steps.get(id)!).filter((s) => canHold(s, t));
    if (startable.length === 0) return;
    // A Laboratory or Pet House already waiting for this upgrade gets the builder first.
    const reserved = startable.find(
      (s) => s.blocksLane && laneWorker(s.blocksLane, t)?.reservedFor === s.id,
    );
    if (reserved) {
      place(reserved, w, t, score(reserved, t).critical ? "critical" : "value");
      return;
    }
    const { pick, reason } = choose(ranked(startable, t));
    place(pick.step, w, t, reason);
  };

  const assignSingle = (w: WorkerState, t: number) => {
    if (w.reservedFor) {
      backfill(w, t);
      return;
    }
    // Upgrading this building stops the lane, so its upgrade competes with the lane's
    // own work: if it wins, the worker waits for a builder instead of starting research.
    const blocking = [...ready.builder]
      .map((id) => steps.get(id)!)
      .filter((s) => s.blocksLane === w.lane);
    const own = [...ready[w.lane]].map((id) => steps.get(id)!);
    if (own.length + blocking.length === 0) return;
    const { pick, reason } = choose(ranked([...own, ...blocking], t));
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
    if (freeBuilder && canHold(s, t)) {
      place(s, freeBuilder, t, score(s, t).critical ? "critical" : "value");
      return;
    }
    let soonest = Infinity;
    for (const b of workers) {
      if (b.lane === "builder" && b.closesAt === undefined && b.running) {
        soonest = Math.min(soonest, b.busyUntil);
      }
    }
    const fits = [...ready[w.lane]]
      .map((id) => steps.get(id)!)
      .filter((r) => t + durationAt(r, t) <= soonest);
    if (fits.length === 0) return;
    const { pick, reason } = choose(ranked(fits, t));
    place(pick.step, w, t, reason);
  };

  const decide = (t: number) => {
    if (calendar && !calendar.isOnline(t)) {
      const back = calendar.nextOnline(calendar.nextOnline(t) + wiggle);
      if (!wakes.has(back)) {
        wakes.add(back);
        events.push({ at: back, kind: 1, seq: seq++ });
      }
      return;
    }
    while (instant.size > 0) {
      const ids = [...instant].sort((a, b) => compareIds(steps.get(a)!, steps.get(b)!));
      for (const id of ids) {
        place(steps.get(id)!, null, t, "instant");
        complete(id, t);
      }
    }
    for (const lane of LANES) {
      for (const w of workers) {
        if (w.lane !== lane || !isFree(w, t)) continue;
        if (lane === "builder") assignBuilder(w, t);
        else assignSingle(w, t);
      }
    }
  };

  // --- Run -------------------------------------------------------------------------------------
  // Steps running in the export occupy their workers from the start. Any beyond the
  // workers the village has, such as an event builder's, get a temporary worker.
  const running = work.steps.filter((s) => s.inProgress);
  running.sort((a, b) => Number(!!a.blocksLane) - Number(!!b.blocksLane) || compareIds(a, b));
  for (const s of running) {
    const w =
      workers.find((x) => x.lane === s.lane && isFree(x, start)) ?? addWorker(s.lane, start, true);
    place(s, w, start, "running");
  }
  for (const s of work.steps) if (!s.inProgress && waiting.get(s.id) === 0) enqueue(s);

  decide(start);
  while (events.size > 0) {
    // Every finish at `t` lands before anyone picks, so all newly ready steps compete.
    const t = events.peek()!.at;
    while (events.size > 0 && events.peek()!.at === t) {
      const e = events.pop()!;
      if (e.kind === 1) wakes.delete(t);
      else complete(e.id!, t);
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
    if (p.reason !== "running" && p.end <= start + 30 * DAY) {
      valueIn30Days += weights[steps.get(p.id)!.category];
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

  return {
    start,
    finish,
    steps: list,
    workers: workers.map(({ lane, index, opensAt, closesAt }) =>
      closesAt === undefined ? { lane, index, opensAt } : { lane, index, opensAt, closesAt },
    ),
    halls,
    unplaced,
    valueIn30Days: Math.round(valueIn30Days * 1000) / 1000,
    decisions,
    targetFinish,
  };
}

/** Orders steps by entity, then instance, then level, for stable tie-breaks. */
export function compareIds(a: Step, b: Step): number {
  return a.entityId - b.entityId || a.instance - b.instance || a.toLevel - b.toLevel;
}
