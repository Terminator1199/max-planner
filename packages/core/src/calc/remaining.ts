import type { Category, GameData, Lane, Resource } from "@max-planner/gamedata";
import type { Village } from "../types.ts";

/** One level of one instance: the unit of work the scheduler places. */
export interface Step {
  /** `entityId:instance:toLevel`, for example `9000010:1:4`. */
  id: string;
  entityId: number;
  instance: number;
  toLevel: number;
  /** Base duration. For a step already running at export time, the time left. */
  seconds: number;
  /** Zero for a running step, which was paid for already. */
  cost: number;
  resource: Resource;
  lane: Lane;
  category: Category;
  /** Lowest Town Hall at which this step can start. */
  townHall: number;
  /** Ids of steps that must finish before this one starts. */
  after: string[];
  /** Running at export time; it occupies its worker from the start of the plan. */
  inProgress?: true;
  /** A Town Hall upgrade. */
  hall?: true;
  /** Upgrading this building stops its lane, as with the Laboratory or Pet House. */
  blocksLane?: Lane;
}

export interface Unplannable {
  stepId: string;
  reason: string;
}

export interface Totals {
  seconds: Record<Lane, number>;
  steps: Record<Lane, number>;
  cost: Record<Resource, number>;
  byCategory: Partial<Record<Category, { steps: number; seconds: number }>>;
  /** Grouped by the lowest Town Hall at which each step can start. */
  byHall: Record<number, { steps: number; seconds: number }>;
  walls: { upgrades: number; cost: Record<Resource, number> };
}

export type Bottleneck = "builders" | "lab" | "petHouse" | "chain";

export interface LowerBound {
  seconds: number;
  bottleneck: Bottleneck;
  terms: Record<Bottleneck, number>;
  /** Builders the bound assumes: the most this target hall allows. */
  builders: number;
  /** The longest dependency chain, first step first. */
  chainSteps: string[];
}

export interface RemainingWork {
  currentTownHall: number;
  targetTownHall: number;
  /** Topologically sorted: every step comes after the steps it waits for. */
  steps: Step[];
  /** Step ids that raise the Town Hall, in order (a running one first). */
  hallSteps: string[];
  /** Longest path from the start of a step to the end of all work, including the step. */
  tail: ReadonlyMap<string, number>;
  totals: Totals;
  lowerBound: LowerBound;
  /** The bound to max each hall from the current one up to the target. */
  hallBounds: { townHall: number; lowerBound: LowerBound }[];
  unplannable: Unplannable[];
  notes: string[];
}

export class CycleError extends Error {
  readonly code = "cycle_detected";
  readonly stepIds: string[];

  constructor(stepIds: string[]) {
    super(`Steps wait on each other in a cycle, which means a data bug: ${stepIds.join(", ")}`);
    this.stepIds = stepIds;
  }
}

export function stepId(entityId: number, instance: number, toLevel: number): string {
  return `${entityId}:${instance}:${toLevel}`;
}

interface Slot {
  index: number;
  /** Level the instance stands at now, ignoring a running upgrade. */
  level: number;
  upgrading: boolean;
}

const RESOURCES: readonly Resource[] = ["gold", "elixir", "darkElixir"];

/**
 * Every step from the village as exported to the max of `targetTownHall`
 * (default: the current hall), with the dependency graph, totals and a lower
 * bound on the finish time that no schedule can beat.
 */
export function remainingWork(
  village: Village,
  gd: GameData,
  options: { targetTownHall?: number } = {},
): RemainingWork {
  const current = village.townHall;
  const target = options.targetTownHall ?? current;
  if (!Number.isInteger(target) || target < current || target > gd.maxTownHall) {
    throw new RangeError(
      `Target Town Hall must be from ${current} to ${gd.maxTownHall}; got ${target}.`,
    );
  }

  const hallEntity = gd.byRole("townHall");
  if (!hallEntity) throw new Error("Game data has no Town Hall.");
  const labId = gd.byRole("laboratory")?.id;
  const petHouseId = gd.byRole("petHouse")?.id;

  const steps = new Map<string, Step>();
  const unplannable: Unplannable[] = [];
  const notes: string[] = [];
  const elapsed = (finishesAt: number) => Math.max(0, finishesAt - village.exportedAt);

  // --- Town Hall steps ------------------------------------------------------------------
  const hallStepFor = new Map<number, string>(); // hall level -> step that reaches it
  const hallSteps: string[] = [];
  const hallInst = village.instances.find((i) => i.entityId === hallEntity.id);
  let previousHall: string | undefined;
  if (hallInst?.finishesAt !== undefined) {
    const row = gd.level(hallEntity.id, current + 1);
    if (row) {
      const id = stepId(hallEntity.id, 0, current + 1);
      steps.set(id, {
        id,
        entityId: hallEntity.id,
        instance: 0,
        toLevel: current + 1,
        seconds: elapsed(hallInst.finishesAt),
        cost: 0,
        resource: row.resource,
        lane: "builder",
        category: hallEntity.category,
        townHall: current,
        after: [],
        inProgress: true,
        hall: true,
      });
      hallStepFor.set(current + 1, id);
      hallSteps.push(id);
      previousHall = id;
    }
  }
  const firstPlannedHall = hallInst?.finishesAt !== undefined ? current + 2 : current + 1;
  for (let r = firstPlannedHall; r <= target; r++) {
    const row = gd.level(hallEntity.id, r);
    if (!row) throw new Error(`Game data has no Town Hall level ${r}.`);
    const id = stepId(hallEntity.id, 0, r);
    steps.set(id, {
      id,
      entityId: hallEntity.id,
      instance: 0,
      toLevel: r,
      seconds: row.seconds,
      cost: row.cost,
      resource: row.resource,
      lane: "builder",
      category: hallEntity.category,
      townHall: r - 1,
      after: previousHall ? [previousHall] : [],
      hall: true,
    });
    hallStepFor.set(r, id);
    hallSteps.push(id);
    previousHall = id;
  }
  /** The step that must finish before work needing hall `r` can start, if any. */
  const hallEdge = (r: number): string | undefined =>
    r > current ? hallStepFor.get(r) : undefined;

  // --- Instance steps ---------------------------------------------------------------------
  const slots = new Map<number, Slot[]>(); // entity id -> its instances, existing then new
  const reached = (entityId: number, index: number, level: number): string | undefined => {
    // The step that brings this instance to `level`, or undefined if it is already there.
    const slot = slots.get(entityId)?.find((s) => s.index === index);
    if (!slot || slot.level >= level) return undefined;
    return stepId(entityId, index, level);
  };

  let wallUpgrades = 0;
  const wallCost: Record<Resource, number> = { gold: 0, elixir: 0, darkElixir: 0 };

  for (const entity of gd.entities()) {
    if (entity.id === hallEntity.id || entity.village !== "home") continue;
    const cap = gd.capAt(entity.id, target);
    const wanted = gd.countAt(entity.id, target);

    if (entity.category === "wall") {
      let existing = 0;
      for (const wall of village.walls.filter((w) => w.entityId === entity.id)) {
        existing += wall.count;
        for (let x = wall.level + 1; x <= cap; x++) addWall(entity.id, x, wall.count);
      }
      for (let x = 1; x <= cap; x++) addWall(entity.id, x, Math.max(0, wanted - existing));
      continue;
    }
    if (entity.mergeOf) {
      notes.push(`${entity.name} is a merged building; merges are not planned yet.`);
      continue;
    }
    if (entity.lane === null) continue;
    const lane = entity.lane;

    const own = village.instances.filter((i) => i.entityId === entity.id);
    const list: Slot[] = own.map((i) => ({
      index: i.index,
      level: i.level,
      upgrading: i.finishesAt !== undefined,
    }));
    for (let index = own.length; index < wanted; index++)
      list.push({ index, level: 0, upgrading: false });
    slots.set(entity.id, list);

    for (const slot of list) {
      let from = slot.level + 1;
      const inst = own.find((i) => i.index === slot.index);
      if (inst?.finishesAt !== undefined) {
        const row = gd.level(entity.id, slot.level + 1);
        if (!row) continue; // the parser already warned about a timer past the last level
        const id = stepId(entity.id, slot.index, slot.level + 1);
        steps.set(id, {
          id,
          entityId: entity.id,
          instance: slot.index,
          toLevel: slot.level + 1,
          seconds: elapsed(inst.finishesAt),
          cost: 0,
          resource: row.resource,
          lane,
          category: entity.category,
          townHall: current,
          after: [],
          inProgress: true,
          ...blocks(entity.id),
        });
        from = slot.level + 2;
      }

      // A new instance waits for the first hall that allows that many.
      let allowedFrom = current;
      if (slot.index >= gd.countAt(entity.id, current)) {
        allowedFrom = target;
        for (let r = current + 1; r <= target; r++) {
          if (gd.countAt(entity.id, r) > slot.index) {
            allowedFrom = r;
            break;
          }
        }
      }

      for (let x = from; x <= cap; x++) {
        const row = gd.level(entity.id, x)!;
        // Every level of a new instance carries the hall that allows it, so the
        // per-hall bounds never count work that hall does not need.
        const needHall = Math.max(row.townHall, allowedFrom);
        const after: string[] = [];
        if (x - 1 > slot.level) {
          after.push(stepId(entity.id, slot.index, x - 1));
        }
        const hall = hallEdge(needHall);
        if (hall) after.push(hall);
        const id = stepId(entity.id, slot.index, x);
        steps.set(id, {
          id,
          entityId: entity.id,
          instance: slot.index,
          toLevel: x,
          seconds: row.seconds,
          cost: row.cost,
          resource: row.resource,
          lane,
          category: entity.category,
          townHall: needHall,
          after,
          ...blocks(entity.id),
        });
      }
    }
  }

  function addWall(entityId: number, level: number, count: number) {
    if (count <= 0) return;
    const row = gd.level(entityId, level);
    if (!row) return;
    wallUpgrades += count;
    wallCost[row.resource] += row.cost * count;
  }

  function blocks(entityId: number): { blocksLane?: Lane } {
    if (entityId === labId) return { blocksLane: "lab" };
    if (entityId === petHouseId) return { blocksLane: "petHouse" };
    return {};
  }

  // --- Requirement edges --------------------------------------------------------------------
  /** Edges to the steps that bring the best `count` instances of an entity to `level`. */
  const edgesToReach = (entityId: number, level: number, count: number): string[] | undefined => {
    const list = [...(slots.get(entityId) ?? [])].sort(
      (a, b) =>
        b.level + Number(b.upgrading) - (a.level + Number(a.upgrading)) || a.index - b.index,
    );
    if (list.length < count) return undefined;
    const edges: string[] = [];
    for (const slot of list.slice(0, count)) {
      const id = reached(entityId, slot.index, level);
      if (id === undefined) continue;
      if (!steps.has(id)) return undefined;
      edges.push(id);
    }
    return edges;
  };

  for (const step of steps.values()) {
    if (step.inProgress) continue;
    const entity = gd.entity(step.entityId)!;
    if (step.hall) {
      for (const item of gd.gateAt(step.toLevel - 1)) {
        const count = item.count ?? gd.countAt(item.entityId, step.toLevel - 1);
        const edges = edgesToReach(item.entityId, item.level, count);
        if (edges === undefined) {
          unplannable.push({
            stepId: step.id,
            reason: `Needs ${count} of ${gd.entity(item.entityId)?.name} at level ${item.level}, which the plan cannot reach.`,
          });
        } else step.after.push(...edges);
      }
      continue;
    }
    for (const req of entity.requires ?? []) {
      if (req.forLevel !== step.toLevel) continue;
      const edges = edgesToReach(req.entityId, req.level, 1);
      if (edges === undefined) {
        unplannable.push({
          stepId: step.id,
          reason: `Needs ${gd.entity(req.entityId)?.name} at level ${req.level}, which the plan cannot reach.`,
        });
      } else step.after.push(...edges);
    }
  }

  // --- Storage edges -------------------------------------------------------------------------
  // A step costing more than the storages can hold waits for storage upgrades, taken
  // in round-robin level order, until the capacity covers it.
  const anyStorage = new Set(
    gd
      .entities()
      .filter((e) => e.category === "storage")
      .map((e) => e.id),
  );
  for (const resource of RESOURCES) {
    const storageIds = new Set(
      gd
        .entities()
        .filter((e) => e.category === "storage")
        .filter(
          (e) => gd.storageCapacity(resource, [{ entityId: e.id, level: gd.maxLevel(e.id) }]) > 0,
        )
        .map((e) => e.id),
    );
    if (storageIds.size === 0) continue;
    const levels = new Map<string, { entityId: number; level: number }>();
    for (const [entityId, list] of slots) {
      if (!storageIds.has(entityId)) continue;
      for (const slot of list)
        levels.set(`${entityId}:${slot.index}`, { entityId, level: slot.level });
    }
    const capacity = gd.storageCapacity(resource, [...levels.values()]);
    const storageSteps = [...steps.values()]
      .filter((s) => storageIds.has(s.entityId))
      .sort((a, b) => a.toLevel - b.toLevel || a.entityId - b.entityId || a.instance - b.instance);
    // `hall` is the highest Town Hall any storage step in the prefix needs.
    const ladder: { capacity: number; prefix: string[]; hall: number }[] = [];
    const prefix: string[] = [];
    let hall = current;
    for (const s of storageSteps) {
      levels.set(`${s.entityId}:${s.instance}`, { entityId: s.entityId, level: s.toLevel });
      prefix.push(s.id);
      hall = Math.max(hall, s.townHall);
      ladder.push({
        capacity: gd.storageCapacity(resource, [...levels.values()]),
        prefix: [...prefix],
        hall,
      });
    }
    let short = 0;
    for (const step of steps.values()) {
      if (step.inProgress || step.resource !== resource || step.cost <= capacity) continue;
      // Storages never wait on storages, so they cannot form a cycle between resources.
      if (anyStorage.has(step.entityId)) continue;
      const rung = ladder.find((l) => l.capacity >= step.cost);
      // A step may only wait on storage levels its own hall allows: a storage needing a
      // higher hall waits on that hall's upgrade, which may be this very step. A cost no
      // allowed storage can hold is a data problem, reported in the notes.
      if (rung && rung.hall <= step.townHall) {
        step.after.push(...rung.prefix.filter((id) => id !== step.id));
      } else short++;
    }
    if (short > 0) {
      notes.push(
        `${short} step${short === 1 ? "" : "s"} cost more ${resource} than the storages allowed at ${short === 1 ? "its" : "their"} Town Hall can hold; no storage edge was added.`,
      );
    }
  }

  // Drop unplannable steps and everything that waits on them.
  if (unplannable.length > 0) {
    const dropped = new Set(unplannable.map((u) => u.stepId));
    let grew = true;
    while (grew) {
      grew = false;
      for (const step of steps.values()) {
        if (!dropped.has(step.id) && step.after.some((id) => dropped.has(id))) {
          dropped.add(step.id);
          unplannable.push({ stepId: step.id, reason: "Waits on a step that cannot be planned." });
          grew = true;
        }
      }
    }
    for (const id of dropped) steps.delete(id);
  }

  for (const step of steps.values()) step.after = [...new Set(step.after)];
  const sorted = topoSort(steps);
  const tail = tails(sorted);

  const totals = sumTotals(sorted, wallUpgrades, wallCost);
  const bound = (subset: Step[], hall: number): LowerBound => {
    const builders = Math.max(
      village.builders,
      gd.countAt(gd.byRole("builderHut")?.id ?? -1, hall),
      1,
    );
    return lowerBound(subset, builders);
  };
  const hallBounds: RemainingWork["hallBounds"] = [];
  for (let r = current; r <= target; r++) {
    const subset = sorted.filter((s) => (s.hall ? s.toLevel : s.townHall) <= r);
    hallBounds.push({ townHall: r, lowerBound: bound(subset, r) });
  }

  return {
    currentTownHall: current,
    targetTownHall: target,
    steps: sorted,
    hallSteps: hallSteps.filter((id) => steps.has(id)),
    tail,
    totals,
    lowerBound: hallBounds.at(-1)!.lowerBound,
    hallBounds,
    unplannable,
    notes,
  };
}

/** Kahn's algorithm, keeping generation order among ready steps so output is stable. */
function topoSort(steps: Map<string, Step>): Step[] {
  const waiting = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const step of steps.values()) {
    waiting.set(step.id, step.after.length);
    for (const p of step.after) {
      if (!steps.has(p)) throw new Error(`Step ${step.id} waits on unknown step ${p}.`);
      const list = next.get(p);
      if (list) list.push(step.id);
      else next.set(p, [step.id]);
    }
  }
  const order = [...steps.keys()];
  const ready = order.filter((id) => waiting.get(id) === 0);
  const out: Step[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!;
    out.push(steps.get(id)!);
    for (const q of next.get(id) ?? []) {
      const left = waiting.get(q)! - 1;
      waiting.set(q, left);
      if (left === 0) ready.push(q);
    }
  }
  if (out.length !== steps.size) {
    throw new CycleError(order.filter((id) => waiting.get(id)! > 0));
  }
  return out;
}

function tails(sorted: Step[]): Map<string, number> {
  const tail = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const s of sorted) for (const p of s.after) next.set(p, [...(next.get(p) ?? []), s.id]);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]!;
    let after = 0;
    for (const q of next.get(s.id) ?? []) after = Math.max(after, tail.get(q)!);
    tail.set(s.id, s.seconds + after);
  }
  return tail;
}

function lowerBound(subset: Step[], builders: number): LowerBound {
  const inSubset = new Set(subset.map((s) => s.id));
  const work: Record<Lane, number> = { builder: 0, lab: 0, petHouse: 0 };
  for (const s of subset) {
    work[s.lane] += s.seconds;
    // While the Laboratory or Pet House upgrades, its own lane cannot work.
    if (s.blocksLane) work[s.blocksLane] += s.seconds;
  }
  // Longest chain within the subset; edges to steps outside it are ignored, which can
  // only shorten the chain, so the bound stays valid.
  const lp = new Map<string, number>();
  const prev = new Map<string, string | undefined>();
  let endId: string | undefined;
  let chain = 0;
  for (const s of subset) {
    let best = 0;
    let from: string | undefined;
    for (const p of s.after) {
      if (!inSubset.has(p)) continue;
      const v = lp.get(p)!;
      if (v > best) {
        best = v;
        from = p;
      }
    }
    lp.set(s.id, best + s.seconds);
    prev.set(s.id, from);
    if (best + s.seconds > chain) {
      chain = best + s.seconds;
      endId = s.id;
    }
  }
  const chainSteps: string[] = [];
  for (let id = endId; id !== undefined; id = prev.get(id)) chainSteps.unshift(id);

  const terms: Record<Bottleneck, number> = {
    builders: Math.ceil(work.builder / builders),
    lab: work.lab,
    petHouse: work.petHouse,
    chain,
  };
  let bottleneck: Bottleneck = "builders";
  for (const key of ["chain", "lab", "petHouse"] as const) {
    if (terms[key] > terms[bottleneck]) bottleneck = key;
  }
  return { seconds: terms[bottleneck], bottleneck, terms, builders, chainSteps };
}

function sumTotals(
  sorted: Step[],
  wallUpgrades: number,
  wallCost: Record<Resource, number>,
): Totals {
  const totals: Totals = {
    seconds: { builder: 0, lab: 0, petHouse: 0 },
    steps: { builder: 0, lab: 0, petHouse: 0 },
    cost: { gold: 0, elixir: 0, darkElixir: 0 },
    byCategory: {},
    byHall: {},
    walls: { upgrades: wallUpgrades, cost: wallCost },
  };
  for (const s of sorted) {
    totals.seconds[s.lane] += s.seconds;
    totals.steps[s.lane] += 1;
    totals.cost[s.resource] += s.cost;
    const cat = (totals.byCategory[s.category] ??= { steps: 0, seconds: 0 });
    cat.steps += 1;
    cat.seconds += s.seconds;
    const band = s.hall ? s.toLevel : s.townHall;
    const hall = (totals.byHall[band] ??= { steps: 0, seconds: 0 });
    hall.steps += 1;
    hall.seconds += s.seconds;
  }
  return totals;
}
