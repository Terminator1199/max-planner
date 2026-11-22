import type { GameData } from "@max-planner/gamedata";
import type { HelperState, Instance, Village, WallCount } from "../types.ts";
import { KNOWN_ROW_FIELDS, META_KEYS, ROW_FIELDS, SECTIONS, type SectionUse } from "./sections.ts";

export type WarningCode =
  | "bad_row"
  | "level_zero"
  | "count_with_timer"
  | "timer_past_max"
  | "timer_exceeds_level"
  | "gear_up_ignored"
  | "supercharge_excluded"
  | "above_cap"
  | "multiple_town_halls"
  | "stale_export";

export interface ImportWarning {
  code: WarningCode;
  section?: string;
  entityId?: number;
  message: string;
}

export interface ImportReport {
  gameDataVersion: string;
  exportedAt: number;
  /** Set when the caller passes `now`. */
  exportAgeSeconds?: number;
  sections: { key: string; rows: number; use: SectionUse | "unknown"; confirmed: boolean }[];
  unknownIds: { section: string; id: number; rows: number }[];
  unknownFields: { section: string; field: string; rows: number }[];
  warnings: ImportWarning[];
  totals: { instances: number; upgrading: number; walls: number; supercharges: number };
}

export type ParseErrorCode = "empty" | "not_json" | "not_object" | "missing_field" | "no_town_hall";

export interface ParseError {
  code: ParseErrorCode;
  message: string;
}

export type ParseResult =
  | { ok: true; village: Village; report: ImportReport }
  | { ok: false; error: ParseError };

export interface ParseOptions {
  /** Current time in Unix seconds. Core code never reads the clock itself. */
  now?: number;
  /** Exports older than this get a stale_export warning. Default 7 days. */
  staleAfterSeconds?: number;
}

const DEFAULT_STALE_AFTER = 7 * 24 * 60 * 60;

/**
 * Turns pasted export text into a Village. It never throws on content: anything it
 * cannot use is listed in the report, so the player can see what was left out.
 */
export function parseExport(text: string, gd: GameData, options: ParseOptions = {}): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return fail("empty", "Nothing was pasted.");

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return fail("not_json", `This is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("not_object", "Expected the export's JSON object, starting with {.");
  }
  const root = json as Record<string, unknown>;
  if (typeof root.tag !== "string" || root.tag === "") {
    return fail("missing_field", "The export has no player tag.");
  }
  if (typeof root.timestamp !== "number" || !Number.isInteger(root.timestamp)) {
    return fail("missing_field", "The export has no timestamp.");
  }
  const exportedAt = root.timestamp;

  const report: ImportReport = {
    gameDataVersion: gd.version,
    exportedAt,
    sections: [],
    unknownIds: [],
    unknownFields: [],
    warnings: [],
    totals: { instances: 0, upgrading: 0, walls: 0, supercharges: 0 },
  };
  const unknownIds = new Tally<{ section: string; id: number }>((k) => `${k.section}:${k.id}`);
  const unknownFields = new Tally<{ section: string; field: string }>(
    (k) => `${k.section}:${k.field}`,
  );
  const warnedOnce = new Set<string>();
  const warnOnce = (key: string, warning: ImportWarning) => {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    report.warnings.push(warning);
  };

  const raw: Omit<Instance, "index">[] = [];
  const walls = new Map<string, WallCount>();
  const helpers: HelperState[] = [];

  for (const [key, value] of Object.entries(root)) {
    if (META_KEYS.has(key)) continue;
    const info = SECTIONS[key];
    const rows = Array.isArray(value) ? value : [];
    report.sections.push({
      key,
      rows: rows.length,
      use: info?.use ?? "unknown",
      confirmed: info?.confirmed ?? false,
    });
    if (!info || info.use === "ignore" || !Array.isArray(value)) continue;

    rows.forEach((row, i) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        report.warnings.push({
          code: "bad_row",
          section: key,
          message: `Row ${i} is not an object.`,
        });
        return;
      }
      const r = row as Record<string, unknown>;
      for (const field of Object.keys(r)) {
        if (!KNOWN_ROW_FIELDS.has(field)) unknownFields.add({ section: key, field });
      }
      const id = r[ROW_FIELDS.id];
      const level = r[ROW_FIELDS.level];
      if (!isInt(id, 1) || !isInt(level, 0)) {
        report.warnings.push({
          code: "bad_row",
          section: key,
          message: `Row ${i} has no usable id or level.`,
        });
        return;
      }

      if (info.use === "helpers") {
        const cooldown = r[ROW_FIELDS.helperCooldown];
        helpers.push(
          isInt(cooldown, 0)
            ? { dataId: id, level, cooldownSeconds: cooldown }
            : { dataId: id, level },
        );
        return;
      }

      const entity = gd.entity(id);
      if (!entity || entity.village !== "home") {
        unknownIds.add({ section: key, id });
        return;
      }
      const count = r[ROW_FIELDS.count];
      const timer = r[ROW_FIELDS.timer];
      const copies = isInt(count, 1) ? count : 1;

      if (entity.category === "wall") {
        const wallKey = `${id}:${level}`;
        const existing = walls.get(wallKey);
        if (existing) existing.count += copies;
        else walls.set(wallKey, { entityId: id, level, count: copies });
        return;
      }

      const idle = (n: number) => {
        for (let k = 0; k < n; k++) raw.push({ entityId: id, level });
      };

      if (r[ROW_FIELDS.supercharge] !== undefined) {
        // Supercharge progress lives in its own counter; a timer on this row belongs
        // to the next supercharge tier, not to a level. v1 leaves supercharges out of max.
        if (isInt(timer, 1)) report.totals.supercharges++;
        warnOnce(`supercharge:${id}`, {
          code: "supercharge_excluded",
          section: key,
          entityId: id,
          message: `${entity.name}: supercharges are shown separately and not planned.`,
        });
        idle(copies);
        return;
      }
      if (r[ROW_FIELDS.gearUp] !== undefined && isInt(timer, 1)) {
        warnOnce(`gearup:${id}`, {
          code: "gear_up_ignored",
          section: key,
          entityId: id,
          message: `${entity.name}: a gear-up timer is Master Builder work and is not planned.`,
        });
        idle(copies);
        return;
      }
      if (isInt(count, 1) && isInt(timer, 1)) {
        report.warnings.push({
          code: "count_with_timer",
          section: key,
          entityId: id,
          message: `${entity.name}: a row has both a count and a timer; the timer was ignored.`,
        });
        idle(copies);
        return;
      }
      if (isInt(timer, 1)) {
        const next = gd.level(id, level + 1);
        if (!next) {
          report.warnings.push({
            code: "timer_past_max",
            section: key,
            entityId: id,
            message: `${entity.name} is upgrading past its last known level ${level}; the game data may be out of date.`,
          });
          idle(1);
          return;
        }
        if (timer > next.seconds) {
          report.warnings.push({
            code: "timer_exceeds_level",
            section: key,
            entityId: id,
            message: `${entity.name}: ${formatDuration(timer)} left is more than the ${formatDuration(next.seconds)} that level ${level + 1} takes.`,
          });
        }
        raw.push({ entityId: id, level, finishesAt: exportedAt + timer });
        return;
      }
      if (level === 0) {
        report.warnings.push({
          code: "level_zero",
          section: key,
          entityId: id,
          message: `${entity.name}: a level 0 row with no timer; treated as not built yet.`,
        });
      }
      idle(copies);
    });
  }

  // Town Hall and builders.
  const hallEntity = gd.byRole("townHall");
  const halls = hallEntity ? raw.filter((i) => i.entityId === hallEntity.id) : [];
  if (halls.length === 0) {
    return fail("no_town_hall", "The export has no Town Hall, so the village cannot be planned.");
  }
  if (halls.length > 1) {
    report.warnings.push({
      code: "multiple_town_halls",
      entityId: hallEntity!.id,
      message: "The export lists more than one Town Hall; the highest level is used.",
    });
  }
  const townHall = Math.max(...halls.map((h) => h.level));
  const hutEntity = gd.byRole("builderHut");
  const builders = hutEntity
    ? raw.filter((i) => i.entityId === hutEntity.id && i.level >= 1).length
    : 0;

  // Levels the current Town Hall should not allow usually mean stale game data.
  for (const inst of raw) {
    const reached = inst.level + (inst.finishesAt === undefined ? 0 : 1);
    if (inst.entityId !== hallEntity!.id && reached > gd.capAt(inst.entityId, townHall)) {
      warnOnce(`cap:${inst.entityId}`, {
        code: "above_cap",
        entityId: inst.entityId,
        message: `${gd.entity(inst.entityId)?.name ?? inst.entityId} is above the Town Hall ${townHall} cap in the game data, which may be out of date.`,
      });
    }
  }
  for (const wall of walls.values()) {
    if (wall.level > gd.capAt(wall.entityId, townHall)) {
      warnOnce(`cap:${wall.entityId}`, {
        code: "above_cap",
        entityId: wall.entityId,
        message: `Walls are above the Town Hall ${townHall} cap in the game data, which may be out of date.`,
      });
    }
  }

  if (options.now !== undefined) {
    report.exportAgeSeconds = options.now - exportedAt;
    const staleAfter = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER;
    if (report.exportAgeSeconds > staleAfter) {
      report.warnings.push({
        code: "stale_export",
        message: `The export is ${formatDuration(report.exportAgeSeconds)} old; timers that have finished since are still shown as running.`,
      });
    }
  }

  const instances = assignIndexes(raw);
  const wallList = [...walls.values()].sort((a, b) => a.entityId - b.entityId || b.level - a.level);
  report.unknownIds = unknownIds.entries().map(([k, rows]) => ({ ...k, rows }));
  report.unknownFields = unknownFields.entries().map(([k, rows]) => ({ ...k, rows }));
  report.totals.instances = instances.length;
  report.totals.upgrading = instances.filter((i) => i.finishesAt !== undefined).length;
  report.totals.walls = wallList.reduce((sum, w) => sum + w.count, 0);

  return {
    ok: true,
    village: {
      tag: root.tag,
      exportedAt,
      townHall,
      builders,
      instances,
      walls: wallList,
      helpers,
    },
    report,
  };
}

/** Upgrading instances first (soonest finish first), then by level from highest to lowest. */
function assignIndexes(raw: Omit<Instance, "index">[]): Instance[] {
  const byEntity = new Map<number, Omit<Instance, "index">[]>();
  for (const inst of raw) {
    const list = byEntity.get(inst.entityId);
    if (list) list.push(inst);
    else byEntity.set(inst.entityId, [inst]);
  }
  const out: Instance[] = [];
  for (const id of [...byEntity.keys()].sort((a, b) => a - b)) {
    const list = byEntity.get(id)!;
    list.sort((a, b) => {
      const au = a.finishesAt !== undefined;
      const bu = b.finishesAt !== undefined;
      if (au !== bu) return au ? -1 : 1;
      if (au && bu) return a.finishesAt! - b.finishesAt! || b.level - a.level;
      return b.level - a.level;
    });
    list.forEach((inst, index) => out.push({ ...inst, index }));
  }
  return out;
}

class Tally<K> {
  readonly #keyOf: (k: K) => string;
  readonly #counts = new Map<string, { key: K; rows: number }>();

  constructor(keyOf: (k: K) => string) {
    this.#keyOf = keyOf;
  }

  add(key: K): void {
    const id = this.#keyOf(key);
    const entry = this.#counts.get(id);
    if (entry) entry.rows++;
    else this.#counts.set(id, { key, rows: 1 });
  }

  entries(): [K, number][] {
    return [...this.#counts.values()].map((e) => [e.key, e.rows]);
  }
}

function isInt(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

function fail(code: ParseErrorCode, message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
