// Types for the four static data files. Every number a planner uses comes from
// one of these files or from the player's export; nothing is hard-coded in code.

export type Lane = "builder" | "lab" | "petHouse";
export type Resource = "gold" | "elixir" | "darkElixir";
export type VillageKind = "home" | "builder";

export const CATEGORIES = [
  "defense",
  "army",
  "resource",
  "storage",
  "hero",
  "troop",
  "spell",
  "siege",
  "pet",
  "trap",
  "wall",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories built and upgraded by builders, as opposed to researched. */
export const BUILDING_CATEGORIES: readonly Category[] = [
  "defense",
  "army",
  "resource",
  "storage",
  "trap",
  "other",
];

/** Buildings the planner must recognise by role rather than by id. */
export const ROLES = ["townHall", "builderHut", "laboratory", "petHouse", "heroHall"] as const;
export type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// gamedata.json
// ---------------------------------------------------------------------------

/**
 * One level of an entity. The row always describes *reaching* this level:
 * the cost and time of the upgrade from `level - 1`, and the lowest Town Hall
 * at which it is allowed. Level 1 of a building is its construction.
 */
export interface LevelRow {
  level: number;
  cost: number;
  resource: Resource;
  seconds: number;
  townHall: number;
}

/** To reach `forLevel` of the owning entity, `entityId` must stand at `level` or higher. */
export interface Requirement {
  entityId: number;
  level: number;
  forLevel: number;
}

/** A merged building consumes `count` instances of `entityId` at `level`. */
export interface MergeSource {
  entityId: number;
  level: number;
  count: number;
}

export interface Entity {
  /** The id the in-game export uses in its `data` field. */
  id: number;
  name: string;
  category: Category;
  /** Which worker does the upgrades. Null for walls, which take no worker time. */
  lane: Lane | null;
  village: VillageKind;
  role?: Role;
  levels: LevelRow[];
  requires?: Requirement[];
  mergeOf?: MergeSource[];
}

/** Something that must stand before the Town Hall can go up to the next level. */
export interface GateItem {
  entityId: number;
  level: number;
  /** Instances needed at that level. Defaults to every instance the hall allows. */
  count?: number;
}

export interface TownHallEntry {
  level: number;
  /** Entity id (as a string key) to the number of instances this hall allows. */
  counts: Record<string, number>;
  /** Required before upgrading from this hall to the next one. */
  gate?: GateItem[];
}

export interface StorageRow {
  entityId: number;
  level: number;
  resource: Resource;
  capacity: number;
}

export interface GameDataFile {
  version: string;
  generatedAt: string;
  /** True for hand-made test data. The app refuses to plan with synthetic data. */
  synthetic?: boolean;
  sources: Record<string, string>;
  entities: Entity[];
  townHalls: TownHallEntry[];
  storage: StorageRow[];
}

// ---------------------------------------------------------------------------
// magic-items.json
// ---------------------------------------------------------------------------

export type ItemKind = "potion" | "snack" | "book" | "hammer";

export interface MagicItem {
  id: string;
  name: string;
  kind: ItemKind;
  /** Potions and snacks: the workers they speed up. */
  lanes?: Lane[];
  /** Potions and snacks: added to the base work rate of 1 (a 10x potion has 9). */
  rateBonus?: number;
  /** Potions and snacks: how long one use lasts. */
  seconds?: number;
  /** Books and hammers: the categories of step they act on. */
  categories?: Category[];
  /** Book of Everything: usable only when no other book fits. */
  fallbackOnly?: boolean;
  holdLimit: number;
  source: string;
}

export interface MagicItemsFile {
  version: string;
  items: MagicItem[];
}

// ---------------------------------------------------------------------------
// events.json
// ---------------------------------------------------------------------------

export type EventEffect =
  | {
      kind: "discount";
      timePct: number;
      costPct: number;
      villages: VillageKind[];
      /** Free-text tags for what the event excludes, such as "supercharge". */
      exclude?: string[];
    }
  | { kind: "noHeroUpgrades" };

export interface Recurrence {
  every: "month";
  /** Day of the month the event starts, 1 to 28. */
  startDay: number;
  startHourUtc: number;
  lengthDays: number;
}

export interface GameEvent {
  id: string;
  name: string;
  /** Confirmed events have a published date. Projected ones are estimates and start switched off. */
  status: "confirmed" | "projected";
  /** ISO 8601 with a zone, for dated events. */
  start?: string;
  end?: string;
  recurrence?: Recurrence;
  effects: EventEffect[];
  source: string;
  note?: string;
}

export interface EventsFile {
  version: string;
  events: GameEvent[];
}

// ---------------------------------------------------------------------------
// seasons.json
// ---------------------------------------------------------------------------

export interface MonthlyCounts {
  free: number;
  goldPass: number;
  clanGames: number;
  other: number;
}

export interface BoostPacePoint {
  /** Day of the season, 1-based. */
  day: number;
  pct: number;
}

export interface SeasonsFile {
  version: string;
  /** "set" once real counts are filled in from season posts. */
  status: "set" | "unset";
  seasonStartDay: number;
  perMonth: Record<string, MonthlyCounts>;
  goldPassBoostPace: BoostPacePoint[];
  source: string;
  note?: string;
}
