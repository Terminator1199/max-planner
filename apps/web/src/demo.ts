// A made-up demo village on the real game numbers: Town Hall 14, part way through, with
// builders and the Laboratory busy and helpers at mid levels. No real player's base.
import type { GameData } from "@max-planner/gamedata";
import { mulberry32 } from "@max-planner/core";

export const DEMO_TAG = "#DEMO";

export function demoExport(gd: GameData, at: number, townHall = 14, seed = 14): string {
  const rng = mulberry32(seed);
  const rows: Record<string, number>[] = [];
  const busy = { builder: 5, lab: 1, petHouse: 1 };
  const hutRole = gd.byRole("builderHut")?.id;
  const hallId = gd.byRole("townHall")!.id;
  rows.push({ data: hallId, lvl: townHall });
  for (const e of gd.entities()) {
    if (e.id === hallId || e.role === "extraBuilder") continue;
    const count = gd.countAt(e.id, townHall);
    const cap = gd.capAt(e.id, townHall);
    if (count === 0 || cap === 0) continue;
    if (e.category === "wall") {
      const top = Math.max(1, cap - 1);
      rows.push(
        { data: e.id, lvl: top, cnt: Math.round(count * 0.6) },
        { data: e.id, lvl: top - 1, cnt: count - Math.round(count * 0.6) },
      );
      continue;
    }
    for (let i = 0; i < count; i++) {
      const behind = e.id === hutRole ? 0 : e.category === "hero" ? rng.int(2, 8) : rng.int(0, 2);
      const level = Math.max(1, cap - behind);
      const lane = e.lane ?? "builder";
      const next = gd.level(e.id, level + 1);
      if (level < cap && next && next.seconds > 0 && busy[lane] > 0 && rng.next() < 0.25) {
        busy[lane]--;
        rows.push({
          data: e.id,
          lvl: level,
          timer: Math.round(next.seconds * (0.2 + 0.6 * rng.next())),
        });
      } else rows.push({ data: e.id, lvl: level });
    }
  }
  return JSON.stringify({
    tag: DEMO_TAG,
    timestamp: at,
    helpers: [
      { data: 93000000, lvl: 4, helper_cooldown: 3 * 3600 },
      { data: 93000001, lvl: 6, helper_cooldown: 3 * 3600 },
    ],
    buildings: rows,
  });
}
