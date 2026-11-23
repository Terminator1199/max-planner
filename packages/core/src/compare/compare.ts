// Two exports side by side: the same village at two times, or two villages.
import type { Category, GameData } from "@max-planner/gamedata";
import type { Village } from "../types.ts";

export interface EntityChange {
  entityId: number;
  name: string;
  category: Category;
  /** Levels of every copy, highest first, with the running upgrade counted as done. */
  a: number[];
  b: number[];
  /** Levels in b minus levels in a, over all copies. */
  levelsGained: number;
}

export interface Comparison {
  townHall: { a: number; b: number };
  exportedAt: { a: number; b: number };
  /** Entities whose levels differ, largest gain first. */
  changes: EntityChange[];
  levelsGained: number;
  walls: { a: number; b: number; levelsGained: number };
}

export function compareVillages(a: Village, b: Village, gd: GameData): Comparison {
  const levels = (v: Village, id: number) =>
    v.instances
      .filter((i) => i.entityId === id)
      .map((i) => i.level + (i.finishesAt !== undefined ? 1 : 0))
      .sort((x, y) => y - x);
  const ids = new Set([...a.instances, ...b.instances].map((i) => i.entityId));
  const changes: EntityChange[] = [];
  for (const id of ids) {
    const e = gd.entity(id);
    if (!e) continue;
    const la = levels(a, id);
    const lb = levels(b, id);
    const gained = lb.reduce((n, x) => n + x, 0) - la.reduce((n, x) => n + x, 0);
    if (gained === 0 && la.join() === lb.join()) continue;
    changes.push({
      entityId: id,
      name: e.name,
      category: e.category,
      a: la,
      b: lb,
      levelsGained: gained,
    });
  }
  changes.sort((x, y) => y.levelsGained - x.levelsGained || x.name.localeCompare(y.name));
  const wallLevels = (v: Village) => v.walls.reduce((n, w) => n + w.level * w.count, 0);
  const wallCount = (v: Village) => v.walls.reduce((n, w) => n + w.count, 0);
  return {
    townHall: { a: a.townHall, b: b.townHall },
    exportedAt: { a: a.exportedAt, b: b.exportedAt },
    changes,
    levelsGained: changes.reduce((n, c) => n + c.levelsGained, 0),
    walls: { a: wallCount(a), b: wallCount(b), levelsGained: wallLevels(b) - wallLevels(a) },
  };
}
