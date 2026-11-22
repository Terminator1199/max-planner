import { Checker, type Result } from "./check.ts";
import {
  CATEGORIES,
  ROLES,
  type EventsFile,
  type GameDataFile,
  type GameEvent,
  type MagicItem,
  type MagicItemsFile,
  type SeasonsFile,
} from "./types.ts";

const LANES = ["builder", "lab", "petHouse"] as const;
const RESOURCES = ["gold", "elixir", "darkElixir"] as const;
const VILLAGES = ["home", "builder"] as const;
const ITEM_KINDS = ["potion", "snack", "book", "hammer"] as const;

// ---------------------------------------------------------------------------
// gamedata.json
// ---------------------------------------------------------------------------

export function validateGameData(json: unknown): Result<GameDataFile> {
  const c = new Checker();
  if (!c.isObject(json, "$")) return c.result(json as GameDataFile);

  c.isString(json.version, "$.version");
  c.isString(json.generatedAt, "$.generatedAt");
  if (json.synthetic !== undefined) c.isBoolean(json.synthetic, "$.synthetic");
  if (c.isObject(json.sources, "$.sources")) {
    for (const [key, value] of Object.entries(json.sources)) c.isString(value, `$.sources.${key}`);
  }

  const ids = new Set<number>();
  const maxLevelById = new Map<number, number>();
  const categoryById = new Map<number, string>();
  const roles = new Map<string, number>();

  if (c.isArray(json.entities, "$.entities")) {
    json.entities.forEach((raw, i) => {
      const p = `$.entities[${i}]`;
      if (!c.isObject(raw, p)) return;
      if (c.isInt(raw.id, `${p}.id`, 1)) {
        if (ids.has(raw.id)) c.error(`${p}.id`, `duplicate entity id ${raw.id}`);
        ids.add(raw.id);
      }
      c.isString(raw.name, `${p}.name`);
      const categoryOk = c.isOneOf(raw.category, `${p}.category`, CATEGORIES);
      if (raw.lane !== null) c.isOneOf(raw.lane, `${p}.lane`, LANES);
      if (categoryOk && raw.category === "wall" && raw.lane !== null) {
        c.error(`${p}.lane`, "walls take no worker time, so lane must be null");
      }
      if (categoryOk && raw.category !== "wall" && raw.lane === null) {
        c.error(`${p}.lane`, "only walls may have a null lane");
      }
      c.isOneOf(raw.village, `${p}.village`, VILLAGES);
      if (raw.role !== undefined && c.isOneOf(raw.role, `${p}.role`, ROLES)) {
        if (roles.has(raw.role)) c.error(`${p}.role`, `role ${raw.role} is already taken`);
        if (typeof raw.id === "number") roles.set(raw.role, raw.id);
      }
      if (typeof raw.id === "number" && typeof raw.category === "string") {
        categoryById.set(raw.id, raw.category);
      }

      if (c.isArray(raw.levels, `${p}.levels`)) {
        if (raw.levels.length === 0) c.error(`${p}.levels`, "expected at least one level");
        let previousTownHall = 0;
        raw.levels.forEach((row, j) => {
          const q = `${p}.levels[${j}]`;
          if (!c.isObject(row, q)) return;
          if (c.isInt(row.level, `${q}.level`, 1) && row.level !== j + 1) {
            c.error(`${q}.level`, `levels must run 1, 2, 3 ... without gaps; expected ${j + 1}`);
          }
          c.isInt(row.cost, `${q}.cost`);
          c.isOneOf(row.resource, `${q}.resource`, RESOURCES);
          c.isInt(row.seconds, `${q}.seconds`);
          if (c.isInt(row.townHall, `${q}.townHall`, 1)) {
            if (row.townHall < previousTownHall) {
              c.error(`${q}.townHall`, "Town Hall requirement must not fall as levels rise");
            }
            previousTownHall = row.townHall;
          }
        });
        if (typeof raw.id === "number") maxLevelById.set(raw.id, raw.levels.length);
      }
    });

    // Cross-references need every id, so they run after the first pass.
    json.entities.forEach((raw, i) => {
      if (typeof raw !== "object" || raw === null) return;
      const entity = raw as Record<string, unknown>;
      const p = `$.entities[${i}]`;
      const own = typeof entity.id === "number" ? maxLevelById.get(entity.id) : undefined;
      if (entity.requires !== undefined && c.isArray(entity.requires, `${p}.requires`)) {
        entity.requires.forEach((req, j) => {
          const q = `${p}.requires[${j}]`;
          if (!c.isObject(req, q)) return;
          checkEntityLevel(c, q, req.entityId, req.level, ids, maxLevelById);
          if (
            c.isInt(req.forLevel, `${q}.forLevel`, 1) &&
            own !== undefined &&
            req.forLevel > own
          ) {
            c.error(`${q}.forLevel`, `entity has only ${own} levels`);
          }
        });
      }
      if (entity.mergeOf !== undefined && c.isArray(entity.mergeOf, `${p}.mergeOf`)) {
        entity.mergeOf.forEach((src, j) => {
          const q = `${p}.mergeOf[${j}]`;
          if (!c.isObject(src, q)) return;
          checkEntityLevel(c, q, src.entityId, src.level, ids, maxLevelById);
          c.isInt(src.count, `${q}.count`, 1);
        });
      }
    });
  }

  if (!roles.has("townHall")) c.error("$.entities", "no entity has role townHall");
  if (!roles.has("builderHut")) c.error("$.entities", "no entity has role builderHut");

  if (c.isArray(json.townHalls, "$.townHalls")) {
    const previousCounts = new Map<string, number>();
    json.townHalls.forEach((raw, i) => {
      const p = `$.townHalls[${i}]`;
      if (!c.isObject(raw, p)) return;
      if (c.isInt(raw.level, `${p}.level`, 1) && raw.level !== i + 1) {
        c.error(`${p}.level`, `Town Hall entries must run 1, 2, 3 ... ; expected ${i + 1}`);
      }
      if (c.isObject(raw.counts, `${p}.counts`)) {
        for (const [key, count] of Object.entries(raw.counts)) {
          if (!ids.has(Number(key))) c.error(`${p}.counts.${key}`, "unknown entity id");
          if (c.isInt(count, `${p}.counts.${key}`)) {
            const before = previousCounts.get(key) ?? 0;
            // Merges can lower a count, so a fall is suspicious but not fatal.
            if (count < before)
              c.warn(`${p}.counts.${key}`, `count falls from ${before} to ${count}`);
            previousCounts.set(key, count);
          }
        }
      }
      if (raw.gate !== undefined && c.isArray(raw.gate, `${p}.gate`)) {
        raw.gate.forEach((item, j) => {
          const q = `${p}.gate[${j}]`;
          if (!c.isObject(item, q)) return;
          checkEntityLevel(c, q, item.entityId, item.level, ids, maxLevelById);
          if (item.count !== undefined) c.isInt(item.count, `${q}.count`, 1);
        });
      }
    });
  }

  if (c.isArray(json.storage, "$.storage")) {
    json.storage.forEach((raw, i) => {
      const p = `$.storage[${i}]`;
      if (!c.isObject(raw, p)) return;
      checkEntityLevel(c, p, raw.entityId, raw.level, ids, maxLevelById);
      if (typeof raw.entityId === "number" && categoryById.get(raw.entityId) !== "storage") {
        c.warn(`${p}.entityId`, "entity is not in the storage category");
      }
      c.isOneOf(raw.resource, `${p}.resource`, RESOURCES);
      c.isInt(raw.capacity, `${p}.capacity`);
    });
  }

  return c.result(json as unknown as GameDataFile);
}

function checkEntityLevel(
  c: Checker,
  path: string,
  entityId: unknown,
  level: unknown,
  ids: Set<number>,
  maxLevelById: Map<number, number>,
): void {
  if (c.isInt(entityId, `${path}.entityId`, 1) && !ids.has(entityId)) {
    c.error(`${path}.entityId`, `unknown entity id ${entityId}`);
  }
  if (c.isInt(level, `${path}.level`, 1) && typeof entityId === "number") {
    const max = maxLevelById.get(entityId);
    if (max !== undefined && level > max) c.error(`${path}.level`, `entity has only ${max} levels`);
  }
}

// ---------------------------------------------------------------------------
// magic-items.json
// ---------------------------------------------------------------------------

export function validateMagicItems(json: unknown): Result<MagicItemsFile> {
  const c = new Checker();
  if (!c.isObject(json, "$")) return c.result(json as MagicItemsFile);
  c.isString(json.version, "$.version");
  const seen = new Set<string>();
  if (c.isArray(json.items, "$.items")) {
    json.items.forEach((raw, i) => {
      const p = `$.items[${i}]`;
      if (!c.isObject(raw, p)) return;
      if (c.isString(raw.id, `${p}.id`)) {
        if (seen.has(raw.id)) c.error(`${p}.id`, `duplicate item id ${raw.id}`);
        seen.add(raw.id);
      }
      c.isString(raw.name, `${p}.name`);
      c.isString(raw.source, `${p}.source`);
      c.isInt(raw.holdLimit, `${p}.holdLimit`, 1);
      if (!c.isOneOf(raw.kind, `${p}.kind`, ITEM_KINDS)) return;
      const item = raw as unknown as MagicItem;
      if (item.kind === "potion" || item.kind === "snack") {
        if (c.isArray(raw.lanes, `${p}.lanes`)) {
          raw.lanes.forEach((lane, j) => c.isOneOf(lane, `${p}.lanes[${j}]`, LANES));
        }
        c.isInt(raw.rateBonus, `${p}.rateBonus`, 1);
        c.isInt(raw.seconds, `${p}.seconds`, 1);
        if (raw.categories !== undefined)
          c.error(`${p}.categories`, "potions act on lanes, not categories");
      } else {
        if (c.isArray(raw.categories, `${p}.categories`)) {
          raw.categories.forEach((cat, j) => c.isOneOf(cat, `${p}.categories[${j}]`, CATEGORIES));
        }
        if (raw.lanes !== undefined || raw.rateBonus !== undefined || raw.seconds !== undefined) {
          c.error(p, "books and hammers take categories, not lanes, rateBonus or seconds");
        }
        if (raw.fallbackOnly !== undefined) c.isBoolean(raw.fallbackOnly, `${p}.fallbackOnly`);
      }
    });
  }
  return c.result(json as unknown as MagicItemsFile);
}

// ---------------------------------------------------------------------------
// events.json
// ---------------------------------------------------------------------------

export function validateEvents(json: unknown): Result<EventsFile> {
  const c = new Checker();
  if (!c.isObject(json, "$")) return c.result(json as EventsFile);
  c.isString(json.version, "$.version");
  const seen = new Set<string>();
  if (c.isArray(json.events, "$.events")) {
    json.events.forEach((raw, i) => {
      const p = `$.events[${i}]`;
      if (!c.isObject(raw, p)) return;
      if (c.isString(raw.id, `${p}.id`)) {
        if (seen.has(raw.id)) c.error(`${p}.id`, `duplicate event id ${raw.id}`);
        seen.add(raw.id);
      }
      c.isString(raw.name, `${p}.name`);
      c.isString(raw.source, `${p}.source`);
      c.isOneOf(raw.status, `${p}.status`, ["confirmed", "projected"] as const);
      const event = raw as unknown as GameEvent;

      const dated = raw.start !== undefined || raw.end !== undefined;
      if (dated === (raw.recurrence !== undefined)) {
        c.error(p, "an event needs either start and end dates or a recurrence, not both");
      }
      if (dated && c.isIsoDate(raw.start, `${p}.start`) && c.isIsoDate(raw.end, `${p}.end`)) {
        if (Date.parse(event.end!) <= Date.parse(event.start!))
          c.error(`${p}.end`, "end must be after start");
      }
      if (raw.recurrence !== undefined && c.isObject(raw.recurrence, `${p}.recurrence`)) {
        const r = raw.recurrence;
        c.isOneOf(r.every, `${p}.recurrence.every`, ["month"] as const);
        c.isInt(r.startDay, `${p}.recurrence.startDay`, 1, 28);
        c.isInt(r.startHourUtc, `${p}.recurrence.startHourUtc`, 0, 23);
        c.isInt(r.lengthDays, `${p}.recurrence.lengthDays`, 1, 27);
      }
      if (event.status === "confirmed" && raw.recurrence !== undefined) {
        c.error(`${p}.status`, "a recurring event is an estimate, so its status must be projected");
      }

      if (c.isArray(raw.effects, `${p}.effects`)) {
        if (raw.effects.length === 0) c.error(`${p}.effects`, "expected at least one effect");
        raw.effects.forEach((effect, j) => {
          const q = `${p}.effects[${j}]`;
          if (!c.isObject(effect, q)) return;
          if (!c.isOneOf(effect.kind, `${q}.kind`, ["discount", "noHeroUpgrades"] as const)) return;
          if (effect.kind === "discount") {
            c.isInt(effect.timePct, `${q}.timePct`, 0, 100);
            c.isInt(effect.costPct, `${q}.costPct`, 0, 100);
            if (c.isArray(effect.villages, `${q}.villages`)) {
              effect.villages.forEach((v, k) => c.isOneOf(v, `${q}.villages[${k}]`, VILLAGES));
            }
            if (effect.exclude !== undefined && c.isArray(effect.exclude, `${q}.exclude`)) {
              effect.exclude.forEach((tag, k) => c.isString(tag, `${q}.exclude[${k}]`));
            }
          }
        });
      }
    });
  }
  return c.result(json as unknown as EventsFile);
}

// ---------------------------------------------------------------------------
// seasons.json
// ---------------------------------------------------------------------------

export function validateSeasons(json: unknown, itemIds?: ReadonlySet<string>): Result<SeasonsFile> {
  const c = new Checker();
  if (!c.isObject(json, "$")) return c.result(json as SeasonsFile);
  c.isString(json.version, "$.version");
  c.isString(json.source, "$.source");
  c.isOneOf(json.status, "$.status", ["set", "unset"] as const);
  c.isInt(json.seasonStartDay, "$.seasonStartDay", 1, 28);
  if (json.status === "unset") {
    c.warn("$.status", "monthly item counts are not set yet; plans assume no items arrive");
  }
  if (c.isObject(json.perMonth, "$.perMonth")) {
    for (const [item, counts] of Object.entries(json.perMonth)) {
      const p = `$.perMonth.${item}`;
      if (itemIds && !itemIds.has(item)) c.error(p, `unknown magic item ${item}`);
      if (!c.isObject(counts, p)) continue;
      for (const key of ["free", "goldPass", "clanGames", "other"])
        c.isInt(counts[key], `${p}.${key}`);
    }
  }
  if (c.isArray(json.goldPassBoostPace, "$.goldPassBoostPace")) {
    let lastDay = 0;
    let lastPct = 0;
    json.goldPassBoostPace.forEach((raw, i) => {
      const p = `$.goldPassBoostPace[${i}]`;
      if (!c.isObject(raw, p)) return;
      if (c.isInt(raw.day, `${p}.day`, 1, 31)) {
        if (raw.day <= lastDay) c.error(`${p}.day`, "days must increase");
        lastDay = raw.day;
      }
      if (c.isInt(raw.pct, `${p}.pct`, 0, 100)) {
        if (raw.pct < lastPct) c.error(`${p}.pct`, "the boost never falls during a season");
        lastPct = raw.pct;
      }
    });
  }
  return c.result(json as unknown as SeasonsFile);
}
