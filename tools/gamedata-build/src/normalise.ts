// Turns ClashKing's static data into this project's game data file.
//
// ClashKing's conventions, as read from the files:
// - Buildings and traps: a level's build_cost, build_time and required_townhall are what
//   it takes to reach that level.
// - Troops, spells, heroes and pets: a level's upgrade_cost and upgrade_time are the price
//   of the next level (the last level's are 0), while its required_townhall,
//   required_lab_level, required_hero_tavern_level and required_pet_house_level are what
//   it takes to have that level.
// - The Town Hall's levels list, under `unlocks`, how many of each building and trap
//   that hall adds. Summing them gives the count allowed at each hall.
// - A merged building's level 1 lists `merge_requirement`: the source buildings it
//   consumes. The Town Hall 17 level lists one too (the Eagle Artillery).
import type {
  Category,
  Entity,
  GameDataFile,
  LevelRow,
  MergeSource,
  Requirement,
  Resource,
  Role,
  TownHallEntry,
} from "@max-planner/gamedata";

export interface CkLevel {
  level: number;
  build_cost?: number;
  build_time?: number;
  upgrade_cost?: number;
  upgrade_time?: number;
  required_townhall?: number | null;
  required_lab_level?: number | null;
  required_hero_tavern_level?: number | null;
  required_pet_house_level?: number | null;
  unlocks?: { _id: number; name: string; quantity: number }[];
  merge_requirement?: { _id: number; name: string; level: number; geared_up?: boolean }[];
}

export interface CkItem {
  _id: number;
  name: string;
  type?: string;
  village?: string;
  upgrade_resource?: string;
  production_building?: string | null;
  production_building_level?: number | null;
  levels: CkLevel[];
}

export type CkFiles = Record<
  "buildings" | "traps" | "troops" | "spells" | "heroes" | "pets",
  CkItem[]
>;

export interface NormaliseResult {
  file: GameDataFile;
  /** What was left out and why, for the build log and the data README. */
  skipped: { id: number; name: string; reason: string }[];
}

const RESOURCE: Record<string, Resource> = {
  Gold: "gold",
  Elixir: "elixir",
  "Dark Elixir": "darkElixir",
};

const ROLE_BY_ID: Record<number, Role> = {
  1000001: "townHall",
  1000015: "builderHut",
  1000064: "extraBuilder",
  1000007: "laboratory",
  1000068: "petHouse",
  1000071: "heroHall",
};

/** Buildings not planned: crafted modules are a separate system. */
const LEFT_OUT: Record<number, string> = {
  1000097: "Crafting Station modules are not planned yet.",
};

const PRODUCTION: Record<string, number> = {
  Barracks: 1000006,
  "Dark Barracks": 1000026,
  Workshop: 1000059,
  "Spell Factory": 1000020,
  "Dark Spell Factory": 1000029,
  "Hero Hall": 1000071,
  "Pet House": 1000068,
  "Squad Barracks": 1000106,
};

export function normalise(
  ck: CkFiles,
  meta: { version: string; generatedAt: string; sources: Record<string, string> },
): NormaliseResult {
  const skipped: NormaliseResult["skipped"] = [];
  const home = (i: CkItem) => (i.village ?? "home") === "home";
  const buildings = ck.buildings.filter(home);
  const byId = new Map(buildings.map((b) => [b._id, b]));
  const hall = byId.get(1000001);
  if (!hall) throw new Error("ClashKing data has no Town Hall (1000001).");
  const halls = hall.levels.length;

  const resource = (item: CkItem): { resource: Resource; free: boolean } => {
    const r = RESOURCE[item.upgrade_resource ?? ""];
    // Gems (Builder's Hut, Helper Hut) are not a resource the planner tracks.
    return r ? { resource: r, free: false } : { resource: "gold", free: true };
  };
  /** The hall at which a building reaches `level`, from its level rows. */
  const hallFor = (id: number, level: number): number => {
    const b = byId.get(id);
    const row = b?.levels.find((l) => l.level === level);
    return Math.max(1, row?.required_townhall ?? 1);
  };

  const entities: Entity[] = [];
  const counts: Map<number, number>[] = Array.from({ length: halls }, () => new Map());

  // --- Buildings and traps ---------------------------------------------------------------
  const structures = [
    ...buildings.map((b) => ({ item: b, trap: false })),
    ...ck.traps.filter(home).map((t) => ({ item: t, trap: true })),
  ];
  for (const { item, trap } of structures) {
    if (LEFT_OUT[item._id]) {
      skipped.push({ id: item._id, name: item.name, reason: LEFT_OUT[item._id]! });
      continue;
    }
    const { resource: res, free } = resource(item);
    const role = ROLE_BY_ID[item._id];
    let floor = 1;
    const levels: LevelRow[] = item.levels.map((l) => {
      // The Town Hall's own levels are reached at that hall.
      const th = role === "townHall" ? l.level : Math.max(floor, l.required_townhall ?? 1);
      floor = th;
      return {
        level: l.level,
        cost: free ? 0 : (l.build_cost ?? 0),
        resource: res,
        seconds: l.build_time ?? 0,
        townHall: th,
      };
    });
    const merge = item.levels[0]?.merge_requirement;
    const entity: Entity = {
      id: item._id,
      name: item.name,
      category: trap ? "trap" : category(item),
      lane: item.type === "Wall" ? null : "builder",
      village: "home",
      ...(role ? { role } : {}),
      levels,
      ...(merge && role !== "townHall" ? { mergeOf: mergeSources(merge) } : {}),
    };
    entities.push(entity);
  }

  // --- Counts per hall, from the Town Hall's unlock lists ----------------------------------
  const known = new Set(entities.map((e) => e.id));
  let running = new Map<number, number>();
  hall.levels.forEach((l, i) => {
    running = new Map(running);
    for (const u of l.unlocks ?? []) {
      if (!known.has(u._id)) continue;
      running.set(u._id, (running.get(u._id) ?? 0) + u.quantity);
    }
    for (const [id, n] of running) counts[i]!.set(id, n);
  });
  // B.O.B's Hut is earned in the Builder Base; the home village never builds it.
  for (const c of counts) c.delete(1000064);
  // Merged buildings consume their sources, so those counts fall.
  for (const e of entities) {
    for (const src of e.mergeOf ?? []) {
      counts.forEach((c) => {
        const merged = c.get(e.id) ?? 0;
        if (merged > 0)
          c.set(src.entityId, Math.max(0, (c.get(src.entityId) ?? 0) - merged * src.count));
      });
    }
  }
  // A hall upgrade that consumes a building (Town Hall 17 and the Eagle Artillery).
  const gates = new Map<number, { entityId: number; level: number }[]>();
  for (const l of hall.levels) {
    for (const m of l.merge_requirement ?? []) {
      if (!known.has(m._id)) continue;
      gates.set(l.level - 1, [
        ...(gates.get(l.level - 1) ?? []),
        { entityId: m._id, level: m.level },
      ]);
      for (let r = l.level; r <= halls; r++) counts[r - 1]!.set(m._id, 0);
    }
  }

  // --- Research, heroes and pets ------------------------------------------------------------
  const lanes: [CkItem[], "lab" | "petHouse" | "builder", (i: CkItem) => Category][] = [
    [ck.troops, "lab", (i) => (i.production_building === "Workshop" ? "siege" : "troop")],
    [ck.spells, "lab", () => "spell"],
    [ck.heroes, "builder", () => "hero"],
    [ck.pets, "petHouse", () => "pet"],
  ];
  for (const [items, lane, cat] of lanes) {
    for (const item of items) {
      if (!home(item)) continue;
      const paid = item.levels.some((l) => (l.upgrade_cost ?? 0) > 0 || (l.upgrade_time ?? 0) > 0);
      const producer = PRODUCTION[item.production_building ?? ""];
      // Squads are researched like troops once unlocked in the Squad Barracks; exports
      // list the ones a player has (seen on a Town Hall 16 export, November 2026).
      if (!paid || (lane !== "builder" && lane !== "petHouse" && !item.production_building_level)) {
        skipped.push({
          id: item._id,
          name: item.name,
          reason: "Not upgraded in the Laboratory (super, event or seasonal troop or spell).",
        });
        continue;
      }
      const { resource: res } = resource(item);
      const sorted = [...item.levels].sort((a, b) => a.level - b.level);
      const requires: Requirement[] = [];
      let floor = 1;
      const levels: LevelRow[] = sorted.map((l, k) => {
        const prev = k > 0 ? sorted[k - 1]! : undefined;
        const th = Math.max(floor, l.required_townhall ?? 1);
        floor = th;
        const house =
          lane === "lab"
            ? { id: 1000007, level: l.required_lab_level }
            : lane === "petHouse"
              ? { id: 1000068, level: l.required_pet_house_level }
              : { id: 1000071, level: l.required_hero_tavern_level };
        if (house.level && house.level > 0) {
          requires.push({ entityId: house.id, level: house.level, forLevel: l.level });
        }
        return {
          level: l.level,
          cost: prev?.upgrade_cost ?? 0,
          resource: res,
          seconds: prev?.upgrade_time ?? 0,
          townHall: th,
        };
      });
      // Unlocking needs the barracks, factory or workshop at its level.
      if (lane === "lab" && producer && item.production_building_level) {
        requires.push({ entityId: producer, level: item.production_building_level, forLevel: 1 });
        const unlockHall = hallFor(producer, item.production_building_level);
        if (unlockHall > levels[0]!.townHall) {
          for (const row of levels) row.townHall = Math.max(row.townHall, unlockHall);
        }
      }
      // A requirement may name a level the house's data lacks; keep only reachable ones.
      const houses = new Map(entities.map((e) => [e.id, e.levels.length]));
      const reachable = requires.filter((r) => r.level <= (houses.get(r.entityId) ?? 0));
      entities.push({
        id: item._id,
        name: item.name,
        category: cat(item),
        lane,
        village: "home",
        levels,
        ...(reachable.length ? { requires: reachable } : {}),
      });
      const from = levels[0]!.townHall;
      for (let r = from; r <= halls; r++) counts[r - 1]!.set(item._id, 1);
    }
  }

  const townHalls: TownHallEntry[] = counts.map((c, i) => {
    const gate = gates.get(i + 1);
    const entry: TownHallEntry = {
      level: i + 1,
      counts: Object.fromEntries(
        [...c].sort((a, b) => a[0] - b[0]).map(([id, n]) => [String(id), n]),
      ),
    };
    return gate ? { ...entry, gate } : entry;
  });

  return {
    file: {
      version: meta.version,
      generatedAt: meta.generatedAt,
      sources: meta.sources,
      entities: entities.sort((a, b) => a.id - b.id),
      townHalls,
      storage: [],
    },
    skipped,
  };
}

function category(b: CkItem): Category {
  switch (b.type) {
    case "Defense":
      return "defense";
    case "Army":
      return "army";
    case "Resource":
      return /Storage/.test(b.name) ? "storage" : "resource";
    case "Wall":
      return "wall";
    default:
      return "other";
  }
}

/** Two Archer Towers at level 21 become one source with count 2. */
function mergeSources(req: NonNullable<CkLevel["merge_requirement"]>): MergeSource[] {
  const out = new Map<string, MergeSource>();
  for (const r of req) {
    const key = `${r._id}:${r.level}`;
    const m = out.get(key);
    if (m) m.count++;
    else out.set(key, { entityId: r._id, level: r.level, count: 1 });
  }
  return [...out.values()];
}
