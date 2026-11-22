// A made-up demo village for the preview, big enough to show a timeline of months,
// boosters and events. The names are Clash's, but every number is invented: the real
// game data is not built yet (LLD tasks 1.5 and 1.6).
import type { Category, Entity, GameDataFile, LevelRow, Resource } from "@max-planner/gamedata";
import { mulberry32 } from "@max-planner/core";

const HALLS = 5;
const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Capacity of one storage at each level, and storages allowed at each hall. */
const CAPACITY = [5_000, 25_000, 100_000, 400_000, 1_000_000];
const STORAGES = [1, 2, 2, 3, 3];
/** What a hall's storages hold when all are at that hall's top level. */
const held = (hall: number) => CAPACITY[hall - 1]! * STORAGES[hall - 1]!;

/** Seconds rounded the way game timers read: minutes, then hours, then whole days. */
function nice(seconds: number): number {
  if (seconds < HOUR) return Math.max(MIN, Math.round(seconds / MIN) * MIN);
  if (seconds < DAY) return Math.round(seconds / HOUR) * HOUR;
  return Math.round(seconds / (DAY / 2)) * (DAY / 2);
}

interface Spec {
  id: number;
  name: string;
  category: Category;
  lane: Entity["lane"];
  role?: Entity["role"];
  levels: number;
  /** First hall the entity appears at. */
  from: number;
  /** Time for level 2 and for the last level; levels between grow evenly in log scale. */
  first: number;
  last: number;
  resource: Resource;
  /** Instances allowed at halls 1 to 5. */
  counts: number[];
  /** Level 1 is free and instant (research unlocks, first traps). */
  freeFirst?: boolean;
}

const SPECS: Spec[] = [
  {
    id: 1,
    name: "Town Hall",
    category: "other",
    lane: "builder",
    role: "townHall",
    levels: 5,
    from: 1,
    first: 1 * DAY,
    last: 6 * DAY,
    resource: "gold",
    counts: [1, 1, 1, 1, 1],
  },
  {
    id: 2,
    name: "Builder's Hut",
    category: "other",
    lane: "builder",
    role: "builderHut",
    levels: 1,
    from: 1,
    first: 0,
    last: 0,
    resource: "gold",
    counts: [3, 4, 5, 5, 5],
    freeFirst: true,
  },
  {
    id: 3,
    name: "Laboratory",
    category: "army",
    lane: "builder",
    role: "laboratory",
    levels: 5,
    from: 1,
    first: 12 * HOUR,
    last: 3 * DAY,
    resource: "elixir",
    counts: [1, 1, 1, 1, 1],
  },
  {
    id: 4,
    name: "Pet House",
    category: "army",
    lane: "builder",
    role: "petHouse",
    levels: 3,
    from: 4,
    first: 2 * DAY,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 0, 0, 1, 1],
  },
  {
    id: 5,
    name: "Gold Storage",
    category: "storage",
    lane: "builder",
    levels: 5,
    from: 1,
    first: 2 * HOUR,
    last: 2 * DAY,
    resource: "elixir",
    counts: STORAGES,
  },
  {
    id: 6,
    name: "Elixir Storage",
    category: "storage",
    lane: "builder",
    levels: 5,
    from: 1,
    first: 2 * HOUR,
    last: 2 * DAY,
    resource: "gold",
    counts: STORAGES,
  },
  {
    id: 7,
    name: "Gold Mine",
    category: "resource",
    lane: "builder",
    levels: 8,
    from: 1,
    first: 30 * MIN,
    last: 1.5 * DAY,
    resource: "elixir",
    counts: [2, 3, 4, 5, 6],
  },
  {
    id: 8,
    name: "Elixir Collector",
    category: "resource",
    lane: "builder",
    levels: 8,
    from: 1,
    first: 30 * MIN,
    last: 1.5 * DAY,
    resource: "gold",
    counts: [2, 3, 4, 5, 6],
  },
  {
    id: 9,
    name: "Army Camp",
    category: "army",
    lane: "builder",
    levels: 6,
    from: 1,
    first: 4 * HOUR,
    last: 3 * DAY,
    resource: "elixir",
    counts: [1, 2, 2, 3, 4],
  },
  {
    id: 10,
    name: "Barracks",
    category: "army",
    lane: "builder",
    levels: 7,
    from: 1,
    first: 1 * HOUR,
    last: 2.5 * DAY,
    resource: "elixir",
    counts: [1, 1, 1, 1, 1],
  },
  {
    id: 11,
    name: "Cannon",
    category: "defense",
    lane: "builder",
    levels: 10,
    from: 1,
    first: 15 * MIN,
    last: 3 * DAY,
    resource: "gold",
    counts: [2, 2, 3, 4, 5],
  },
  {
    id: 12,
    name: "Archer Tower",
    category: "defense",
    lane: "builder",
    levels: 10,
    from: 2,
    first: 30 * MIN,
    last: 3.5 * DAY,
    resource: "gold",
    counts: [0, 1, 2, 3, 4],
  },
  {
    id: 13,
    name: "Mortar",
    category: "defense",
    lane: "builder",
    levels: 6,
    from: 3,
    first: 8 * HOUR,
    last: 4 * DAY,
    resource: "gold",
    counts: [0, 0, 1, 2, 3],
  },
  {
    id: 14,
    name: "Air Defense",
    category: "defense",
    lane: "builder",
    levels: 6,
    from: 3,
    first: 8 * HOUR,
    last: 4 * DAY,
    resource: "gold",
    counts: [0, 0, 1, 2, 3],
  },
  {
    id: 15,
    name: "Wizard Tower",
    category: "defense",
    lane: "builder",
    levels: 5,
    from: 4,
    first: 1 * DAY,
    last: 5 * DAY,
    resource: "gold",
    counts: [0, 0, 0, 2, 3],
  },
  {
    id: 16,
    name: "X-Bow",
    category: "defense",
    lane: "builder",
    levels: 3,
    from: 5,
    first: 3 * DAY,
    last: 7 * DAY,
    resource: "gold",
    counts: [0, 0, 0, 0, 2],
  },
  {
    id: 17,
    name: "Bomb",
    category: "trap",
    lane: "builder",
    levels: 5,
    from: 1,
    first: 10 * MIN,
    last: 1 * DAY,
    resource: "gold",
    counts: [2, 4, 4, 6, 6],
    freeFirst: true,
  },
  {
    id: 18,
    name: "Spring Trap",
    category: "trap",
    lane: "builder",
    levels: 4,
    from: 2,
    first: 1 * HOUR,
    last: 1 * DAY,
    resource: "gold",
    counts: [0, 2, 2, 4, 4],
    freeFirst: true,
  },
  {
    id: 19,
    name: "Barbarian King",
    category: "hero",
    lane: "builder",
    levels: 20,
    from: 3,
    first: 12 * HOUR,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 0, 1, 1, 1],
  },
  {
    id: 20,
    name: "Archer Queen",
    category: "hero",
    lane: "builder",
    levels: 10,
    from: 5,
    first: 1 * DAY,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 0, 0, 0, 1],
  },
  {
    id: 31,
    name: "Barbarian",
    category: "troop",
    lane: "lab",
    levels: 6,
    from: 1,
    first: 8 * HOUR,
    last: 4 * DAY,
    resource: "elixir",
    counts: [1, 1, 1, 1, 1],
    freeFirst: true,
  },
  {
    id: 32,
    name: "Archer",
    category: "troop",
    lane: "lab",
    levels: 6,
    from: 1,
    first: 8 * HOUR,
    last: 4 * DAY,
    resource: "elixir",
    counts: [1, 1, 1, 1, 1],
    freeFirst: true,
  },
  {
    id: 33,
    name: "Giant",
    category: "troop",
    lane: "lab",
    levels: 6,
    from: 2,
    first: 12 * HOUR,
    last: 5 * DAY,
    resource: "elixir",
    counts: [0, 1, 1, 1, 1],
    freeFirst: true,
  },
  {
    id: 34,
    name: "Wizard",
    category: "troop",
    lane: "lab",
    levels: 5,
    from: 3,
    first: 1 * DAY,
    last: 5 * DAY,
    resource: "elixir",
    counts: [0, 0, 1, 1, 1],
    freeFirst: true,
  },
  {
    id: 35,
    name: "Lightning Spell",
    category: "spell",
    lane: "lab",
    levels: 5,
    from: 2,
    first: 12 * HOUR,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 1, 1, 1, 1],
    freeFirst: true,
  },
  {
    id: 36,
    name: "Healing Spell",
    category: "spell",
    lane: "lab",
    levels: 4,
    from: 3,
    first: 1 * DAY,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 0, 1, 1, 1],
    freeFirst: true,
  },
  {
    id: 37,
    name: "Wall Wrecker",
    category: "siege",
    lane: "lab",
    levels: 3,
    from: 5,
    first: 3 * DAY,
    last: 5 * DAY,
    resource: "elixir",
    counts: [0, 0, 0, 0, 1],
    freeFirst: true,
  },
  {
    id: 41,
    name: "L.A.S.S.I",
    category: "pet",
    lane: "petHouse",
    levels: 6,
    from: 4,
    first: 1 * DAY,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 0, 0, 1, 1],
    freeFirst: true,
  },
  {
    id: 42,
    name: "Electro Owl",
    category: "pet",
    lane: "petHouse",
    levels: 4,
    from: 5,
    first: 2 * DAY,
    last: 4 * DAY,
    resource: "elixir",
    counts: [0, 0, 0, 0, 1],
    freeFirst: true,
  },
];
const WALL = 50;
const HOUSE = { laboratory: 3, petHouse: 4 };

/** The demo game data: five halls, every number made up. */
export function demoGameData(): GameDataFile {
  const entities: Entity[] = SPECS.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    lane: s.lane,
    village: "home",
    ...(s.role ? { role: s.role } : {}),
    levels: levels(s),
    ...requirements(s),
  }));
  entities.push({
    id: WALL,
    name: "Wall",
    category: "wall",
    lane: null,
    village: "home",
    levels: Array.from({ length: HALLS }, (_, i) => ({
      level: i + 1,
      cost: Math.round(held(i + 1) * 0.02),
      resource: "gold",
      seconds: 0,
      townHall: i + 1,
    })),
  });
  return {
    version: "demo",
    generatedAt: "2026-11-23T00:00:00Z",
    synthetic: true,
    sources: { note: "Made-up demo data for the preview. Not the real game." },
    entities,
    townHalls: Array.from({ length: HALLS }, (_, i) => ({
      level: i + 1,
      counts: Object.fromEntries([
        ...SPECS.map((s) => [String(s.id), s.counts[i]!]),
        [String(WALL), 25 * (i + 1)],
      ]),
    })),
    storage: [5, 6].flatMap((id) =>
      CAPACITY.map((capacity, i) => ({
        entityId: id,
        level: i + 1,
        resource: (id === 5 ? "gold" : "elixir") as Resource,
        capacity,
      })),
    ),
  };
}

/** Levels spread over the halls from `from` to 5, with times growing level by level. */
function levels(s: Spec): LevelRow[] {
  const rows: LevelRow[] = [];
  const span = HALLS - s.from + 1;
  for (let x = 1; x <= s.levels; x++) {
    const hall =
      s.role === "townHall" || s.role === "laboratory"
        ? x
        : s.role === "petHouse"
          ? [4, 4, 5][x - 1]!
          : s.from + Math.floor(((x - 1) * span) / s.levels);
    const free = x === 1 && (s.freeFirst || s.role === "townHall");
    const share = s.levels <= 2 ? 1 : (x - 2) / (s.levels - 2);
    const seconds =
      free || s.first === 0
        ? 0
        : x === 1
          ? nice(s.first / 2)
          : nice(s.first * (s.last / s.first) ** Math.max(0, share));
    // The hall upgrade must fit in the storages of the hall before it.
    const cost = free
      ? 0
      : s.role === "townHall"
        ? Math.round(held(hall - 1) * 0.9)
        : Math.round(held(hall) * (0.1 + 0.5 * Math.max(0, share)) ** 1.2);
    rows.push({
      level: x,
      cost: Math.min(cost, held(hall)),
      resource: s.resource,
      seconds,
      townHall: hall,
    });
  }
  return rows;
}

/** Research needs the Laboratory, and pets the Pet House, at the level their hall allows. */
function requirements(s: Spec): Pick<Entity, "requires"> {
  if (s.lane === "builder") return {};
  const house = s.lane === "lab" ? HOUSE.laboratory : HOUSE.petHouse;
  const rows = levels(s).filter((l) => l.level >= 2);
  return {
    requires: rows.map((l) => ({
      entityId: house,
      level: s.lane === "lab" ? l.townHall : l.townHall === 4 ? 1 : 3,
      forLevel: l.level,
    })),
  };
}

/**
 * A Town Hall 4 village part way through, as the game's export would show it: most
 * buildings a few levels short, and the Laboratory, a Cannon, an Archer Tower, the King
 * and L.A.S.S.I upgrading.
 */
export function demoExport(at: number, seed = 4): string {
  const rng = mulberry32(seed);
  const file = demoGameData();
  const hall = 4;
  const capAt = (e: Entity) => e.levels.filter((l) => l.townHall <= hall).length;
  const buildings: Record<string, number>[] = [];
  const running = new Map<number, number>([
    [3, 1],
    [11, 1],
    [12, 1],
    [19, 1],
    [41, 1],
  ]);
  for (const e of file.entities) {
    const count = file.townHalls[hall - 1]!.counts[String(e.id)] ?? 0;
    const cap = capAt(e);
    if (count === 0 || cap === 0) continue;
    if (e.category === "wall") {
      buildings.push({ data: e.id, lvl: 3, cnt: 60 }, { data: e.id, lvl: 4, cnt: 40 });
      continue;
    }
    if (e.role === "townHall") {
      buildings.push({ data: e.id, lvl: hall });
      continue;
    }
    for (let i = 0; i < count; i++) {
      const short = e.role ? 1 : rng.int(0, e.category === "hero" ? 3 : 2);
      const level = Math.max(1, cap - short);
      const next = e.levels[level];
      if ((running.get(e.id) ?? 0) > 0 && next && next.seconds > 0 && level < cap) {
        running.set(e.id, running.get(e.id)! - 1);
        buildings.push({ data: e.id, lvl: level, timer: Math.round(next.seconds * 0.6) });
      } else {
        buildings.push({ data: e.id, lvl: level });
      }
    }
  }
  return JSON.stringify({ tag: "#DEMO0001", timestamp: at, buildings });
}
