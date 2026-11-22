import type {
  Entity,
  GameDataFile,
  GateItem,
  LevelRow,
  Resource,
  Role,
  StorageRow,
  TownHallEntry,
} from "./types.ts";

/** Read-only lookups over a validated gamedata.json. */
export interface GameData {
  readonly version: string;
  readonly synthetic: boolean;
  /** Highest Town Hall the data describes. */
  readonly maxTownHall: number;
  entities(): readonly Entity[];
  entity(id: number): Entity | undefined;
  byRole(role: Role): Entity | undefined;
  /** The row for reaching `level`, or undefined if the entity has no such level. */
  level(id: number, level: number): LevelRow | undefined;
  maxLevel(id: number): number;
  /** Highest level allowed at this Town Hall; 0 if the entity is not available yet. */
  capAt(id: number, townHall: number): number;
  /** Instances allowed at this Town Hall; 0 if none. */
  countAt(id: number, townHall: number): number;
  /** What must stand before upgrading from this Town Hall to the next. */
  gateAt(townHall: number): readonly GateItem[];
  /** Total capacity for a resource across the given storage instances. */
  storageCapacity(
    resource: Resource,
    instances: readonly { entityId: number; level: number }[],
  ): number;
}

/** Wraps a file that has already passed validateGameData. */
export function createGameData(file: GameDataFile): GameData {
  const byId = new Map<number, Entity>();
  const byRole = new Map<Role, Entity>();
  for (const entity of file.entities) {
    byId.set(entity.id, entity);
    if (entity.role) byRole.set(entity.role, entity);
  }

  const halls = new Map<number, TownHallEntry>();
  for (const hall of file.townHalls) halls.set(hall.level, hall);
  const maxTownHall = file.townHalls.length;

  const capacity = new Map<string, StorageRow>();
  for (const row of file.storage) capacity.set(`${row.entityId}:${row.level}:${row.resource}`, row);

  return {
    version: file.version,
    synthetic: file.synthetic === true,
    maxTownHall,
    entities: () => file.entities,
    entity: (id) => byId.get(id),
    byRole: (role) => byRole.get(role),
    level: (id, level) => byId.get(id)?.levels[level - 1],
    maxLevel: (id) => byId.get(id)?.levels.length ?? 0,
    capAt(id, townHall) {
      const entity = byId.get(id);
      if (!entity) return 0;
      let cap = 0;
      for (const row of entity.levels) {
        if (row.townHall > townHall) break;
        cap = row.level;
      }
      return cap;
    },
    countAt(id, townHall) {
      const hall = halls.get(Math.min(townHall, maxTownHall));
      return hall?.counts[String(id)] ?? 0;
    },
    gateAt: (townHall) => halls.get(townHall)?.gate ?? [],
    storageCapacity(resource, instances) {
      let total = 0;
      for (const { entityId, level } of instances) {
        total += capacity.get(`${entityId}:${level}:${resource}`)?.capacity ?? 0;
      }
      return total;
    },
  };
}
