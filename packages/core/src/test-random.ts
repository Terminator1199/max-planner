// Random game data and villages for the scheduler's property tests. Not exported.
import {
  createGameData,
  validateGameData,
  type Category,
  type Entity,
  type GameData,
  type GameDataFile,
  type LevelRow,
  type Resource,
  type StorageRow,
} from "@max-planner/gamedata";
import { parseExport } from "./parser/parse.ts";
import type { Rng } from "./sched/prng.ts";
import type { Village } from "./types.ts";

const HOUR = 3600;

export const RANDOM_IDS = { townHall: 100, builderHut: 101, laboratory: 102, petHouse: 105 };

/**
 * A valid game data file with 2 to 5 halls, storages, a Laboratory, sometimes a Pet
 * House, builder buildings, research and pets with requirements, walls and hall gates.
 */
export function randomGameData(rng: Rng): GameData {
  const halls = rng.int(2, 5);
  const entities: Entity[] = [];
  const counts: Record<string, number>[] = Array.from({ length: halls }, () => ({}));
  const storage: StorageRow[] = [];
  const capacity = (hall: number) => 2000 * 4 ** (hall - 1);

  const rows = (n: number, hallOf: (x: number) => number, resource: Resource, free1: boolean) => {
    const out: LevelRow[] = [];
    for (let x = 1; x <= n; x++) {
      const hall = hallOf(x);
      const zero = x === 1 && free1;
      out.push({
        level: x,
        cost: zero ? 0 : rng.int(1, 12) * Math.floor(capacity(hall) / 10),
        resource,
        seconds: zero ? 0 : rng.int(1, 6 * 24) * 1800,
        townHall: hall,
      });
    }
    return out;
  };
  /** Instances from `from` on, never falling as the hall rises. */
  const setCounts = (id: number, from: number, most: number) => {
    let n = 0;
    for (let r = from; r <= halls; r++) {
      n = Math.min(most, Math.max(n, rng.int(1, most)));
      counts[r - 1]![String(id)] = n;
    }
  };
  const add = (
    e: Omit<Entity, "village" | "levels"> & { levels: LevelRow[] },
    from: number,
    most: number,
  ) => {
    entities.push({ ...e, village: "home" });
    setCounts(e.id, from, most);
  };

  const byHall = (x: number) => x;
  add(
    {
      id: RANDOM_IDS.townHall,
      name: "Town Hall",
      category: "other",
      lane: "builder",
      role: "townHall",
      levels: rows(halls, byHall, "gold", true),
    },
    1,
    1,
  );
  const hutLevels = rows(2, (x) => (x === 1 ? 1 : halls), "gold", true);
  add(
    {
      id: RANDOM_IDS.builderHut,
      name: "Builder's Hut",
      category: "other",
      lane: "builder",
      role: "builderHut",
      levels: hutLevels,
    },
    1,
    1,
  );
  for (let r = 1; r <= halls; r++)
    counts[r - 1]![String(RANDOM_IDS.builderHut)] = Math.min(5, 1 + r);
  add(
    {
      id: RANDOM_IDS.laboratory,
      name: "Laboratory",
      category: "army",
      lane: "builder",
      role: "laboratory",
      levels: rows(halls, byHall, "elixir", false),
    },
    1,
    1,
  );
  for (const [id, name, pays, holds] of [
    [103, "Gold Storage", "elixir", "gold"],
    [104, "Elixir Storage", "gold", "elixir"],
  ] as const) {
    add(
      { id, name, category: "storage", lane: "builder", levels: rows(halls, byHall, pays, false) },
      1,
      2,
    );
    for (let x = 1; x <= halls; x++) {
      storage.push({ entityId: id, level: x, resource: holds, capacity: capacity(x) });
    }
  }
  const pets = halls >= 3 && rng.next() < 0.6;
  if (pets) {
    add(
      {
        id: RANDOM_IDS.petHouse,
        name: "Pet House",
        category: "army",
        lane: "builder",
        role: "petHouse",
        levels: rows(halls - 1, (x) => x + 1, "elixir", false),
      },
      2,
      1,
    );
  }

  const builderKinds: Category[] = ["defense", "army", "resource", "hero", "trap", "other"];
  const builders: Entity[] = [];
  for (let i = 0; i < rng.int(4, 10); i++) {
    const n = rng.int(1, 2 * halls);
    const category = builderKinds[rng.int(0, builderKinds.length - 1)]!;
    const levels = rows(
      n,
      (x) => Math.ceil((x * halls) / n),
      rng.next() < 0.5 ? "gold" : "elixir",
      rng.next() < 0.3,
    );
    const e = { id: 200 + i, name: `Building ${i}`, category, lane: "builder" as const, levels };
    add(e, levels[0]!.townHall, category === "hero" ? 1 : 3);
    builders.push(entities.at(-1)!);
  }
  const labKinds: Category[] = ["troop", "spell", "siege"];
  for (let i = 0; i < rng.int(2, 6); i++) {
    const n = rng.int(2, 2 * halls);
    const levels = rows(n, (x) => Math.ceil((x * halls) / n), "elixir", true);
    const requires = levels
      .filter((l) => l.level >= 2)
      .map((l) => ({ entityId: RANDOM_IDS.laboratory, level: l.townHall, forLevel: l.level }));
    add(
      {
        id: 300 + i,
        name: `Research ${i}`,
        category: labKinds[i % labKinds.length]!,
        lane: "lab",
        levels,
        requires,
      },
      levels[0]!.townHall,
      1,
    );
  }
  if (pets) {
    for (let i = 0; i < rng.int(1, 3); i++) {
      const n = rng.int(2, 6);
      const levels = rows(n, (x) => 1 + Math.ceil((x * (halls - 1)) / n), "elixir", false);
      const requires = levels.map((l) => ({
        entityId: RANDOM_IDS.petHouse,
        level: l.townHall - 1,
        forLevel: l.level,
      }));
      add(
        { id: 400 + i, name: `Pet ${i}`, category: "pet", lane: "petHouse", levels, requires },
        levels[0]!.townHall,
        1,
      );
    }
  }
  entities.push({
    id: 500,
    name: "Wall",
    category: "wall",
    lane: null,
    village: "home",
    levels: rows(halls, byHall, "gold", false).map((l) => ({ ...l, seconds: 0 })),
  });
  for (let r = 1; r <= halls; r++) counts[r - 1]!["500"] = 10 * r;

  const capAt = (e: Entity, hall: number) => e.levels.filter((l) => l.townHall <= hall).length;
  const file: GameDataFile = {
    version: "random",
    generatedAt: "2026-11-20T00:00:00Z",
    synthetic: true,
    sources: { note: "Random test data." },
    entities,
    townHalls: counts.map((c, i) => {
      const level = i + 1;
      const gate = [];
      if (level < halls) {
        const candidates = builders.filter((b) => capAt(b, level) > 0);
        if (candidates.length > 0 && rng.next() < 0.6) {
          const b = candidates[rng.int(0, candidates.length - 1)]!;
          gate.push({ entityId: b.id, level: capAt(b, level) });
        }
        if (rng.next() < 0.5) gate.push({ entityId: RANDOM_IDS.laboratory, level });
      }
      return gate.length > 0 ? { level, counts: c, gate } : { level, counts: c };
    }),
    storage,
  };
  const result = validateGameData(file);
  if (!result.ok) throw new Error(`Random game data is invalid: ${JSON.stringify(result.errors)}`);
  return createGameData(result.value);
}

/**
 * A village that could exist: at most one running upgrade per builder, at most one
 * research and one pet upgrade, none while their building upgrades, every level
 * within the hall's caps.
 */
export function randomVillage(rng: Rng, gd: GameData, townHall: number, at: number): Village {
  const rows: Record<string, number>[] = [];
  const hall = gd.byRole("townHall")!;
  const hut = gd.byRole("builderHut")!;
  const lab = gd.byRole("laboratory");
  const pet = gd.byRole("petHouse");
  const timer = (id: number, level: number) => {
    const next = gd.level(id, level + 1);
    return next && next.seconds > 0 ? rng.int(1, next.seconds) : undefined;
  };

  const huts = rng.int(1, gd.countAt(hut.id, townHall));
  let builderBudget = huts;
  const lanes = { lab: 0, petHouse: 0 };

  const hallTimer =
    townHall < gd.maxTownHall && rng.next() < 0.2 ? timer(hall.id, townHall) : undefined;
  rows.push(
    hallTimer
      ? { data: hall.id, lvl: townHall, timer: hallTimer }
      : { data: hall.id, lvl: townHall },
  );
  if (hallTimer) builderBudget--;

  const order = [...gd.entities()].sort((a, b) => {
    const rank = (e: Entity) => (e.role ? 0 : e.lane === "builder" ? 1 : 2);
    return rank(a) - rank(b) || a.id - b.id;
  });
  for (const e of order) {
    if (e.id === hall.id) continue;
    const cap = gd.capAt(e.id, townHall);
    const most = gd.countAt(e.id, townHall);
    if (cap === 0 || most === 0) continue;
    if (e.category === "wall") {
      let left = rng.int(0, most);
      while (left > 0) {
        const n = rng.int(1, left);
        rows.push({ data: e.id, lvl: rng.int(1, cap), cnt: n });
        left -= n;
      }
      continue;
    }
    const n = e.id === hut.id ? huts : rng.next() < 0.5 ? most : rng.int(0, most);
    for (let i = 0; i < n; i++) {
      const level = rng.int(1, cap);
      let t: number | undefined;
      if (level < cap && rng.next() < 0.3) {
        if (e.lane === "builder" && builderBudget > 0) {
          t = timer(e.id, level);
          if (t) {
            builderBudget--;
            // The Laboratory and Pet House cannot research while they upgrade.
            if (e.id === lab?.id) lanes.lab = -1;
            if (e.id === pet?.id) lanes.petHouse = -1;
          }
        } else if ((e.lane === "lab" || e.lane === "petHouse") && lanes[e.lane] === 0) {
          const built = rows.some((r) => r.data === (e.lane === "lab" ? lab?.id : pet?.id));
          if (built) {
            t = timer(e.id, level);
            if (t) lanes[e.lane] = 1;
          }
        }
      }
      rows.push(t ? { data: e.id, lvl: level, timer: t } : { data: e.id, lvl: level });
    }
  }

  const parsed = parseExport(
    JSON.stringify({ tag: "#RANDOM", timestamp: at, buildings: rows }),
    gd,
    {
      now: at,
    },
  );
  if (!parsed.ok) throw new Error(`Random village did not parse: ${JSON.stringify(parsed.error)}`);
  return parsed.village;
}

export { HOUR };
