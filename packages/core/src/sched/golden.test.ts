// Golden plans: the plan hash for each fixture, strategy and target hall. A change here
// means the planner now gives players a different plan, so it must be deliberate:
//
//   UPDATE_GOLDEN=1 GOLDEN_NOTE="why the plans changed" pnpm test
//
// rewrites fixtures/plans/golden.json, recording the note beside each changed hash.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import seasons from "@max-planner/gamedata/files/seasons.json" with { type: "json" };
import { arrivals } from "../boost/inventory.ts";
import { remainingWork } from "../calc/remaining.ts";
import { expandEvents } from "../events/windows.ts";
import { parseExport } from "../parser/parse.ts";
import { T0, gameEvents, magicItems, readFixture, sampleGameData } from "../test-support.ts";
import { goldPassDiscount } from "../time/goldpass.ts";
import { OnlineCalendar } from "../time/online.ts";
import { searchPlan, type SearchOptions } from "./search.ts";
import { STRATEGIES } from "./weights.ts";

interface Golden {
  hash: string;
  finishSeconds: number;
  note: string;
}

const FILE = new URL("../../../../fixtures/plans/golden.json", import.meta.url);
const gd = sampleGameData();

function cases(): [string, () => ReturnType<typeof searchPlan>][] {
  const parsed = parseExport(readFixture("synthetic-th2.json"), gd, { now: T0 });
  assert.ok(parsed.ok);
  const village = parsed.village;
  const out: [string, () => ReturnType<typeof searchPlan>][] = [];
  for (const strategy of STRATEGIES) {
    for (const target of [2, 3]) {
      const work = remainingWork(village, gd, { targetTownHall: target });
      out.push([
        `synthetic-th2/${strategy}/th${target}`,
        () => searchPlan(work, village, gd, { strategy, seed: 1 }),
      ]);
    }
  }
  const work = remainingWork(village, gd, { targetTownHall: 3 });
  const options: SearchOptions = {
    seed: 1,
    calendar: new OnlineCalendar(
      {
        timeZone: "Asia/Kolkata",
        offline: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "23:00", to: "07:00" }],
      },
      village.exportedAt,
    ),
    discounts: [
      goldPassDiscount(
        { pace: seasons.goldPassBoostPace, seasonStartDay: seasons.seasonStartDay },
        village.exportedAt,
      ),
    ],
  };
  out.push([
    "synthetic-th2/balanced/th3/offline-goldpass",
    () => searchPlan(work, village, gd, options),
  ]);

  // Items and events: a half-price day starting 12 h in, the league switched on, potions,
  // a book and a hammer in hand, with low thresholds so they act on this short plan.
  const from = village.exportedAt;
  const sale = {
    id: "golden-sale",
    name: "Golden sale",
    status: "confirmed" as const,
    start: new Date((from + 12 * 3600) * 1000).toISOString(),
    end: new Date((from + 36 * 3600) * 1000).toISOString(),
    effects: [{ kind: "discount" as const, timePct: 50, costPct: 50, villages: ["home" as const] }],
    source: "test",
  };
  const items: SearchOptions = {
    seed: 1,
    events: expandEvents([...gameEvents(), sale], from, from + 60 * 86_400, [
      "golden-sale",
      "clan-war-league",
    ]),
    boosters: {
      items: magicItems(),
      arrivals: arrivals(
        {
          stock: {
            "builder-potion": 2,
            "research-potion": 1,
            "book-of-building": 1,
            "hammer-of-heroes": 1,
          },
          perMonth: { "builder-potion": 2 },
        },
        1,
        from,
        from + 60 * 86_400,
      ),
      rules: { bookMinDays: 0.25, hammerMinDays: 0.25 },
    },
  };
  out.push(["synthetic-th2/balanced/th3/items-events", () => searchPlan(work, village, gd, items)]);
  return out;
}

test("golden plans are unchanged", () => {
  const stored: Record<string, Golden> = JSON.parse(readFileSync(FILE, "utf8"));
  const update = process.env.UPDATE_GOLDEN === "1";
  const next: Record<string, Golden> = {};
  const changed: string[] = [];
  for (const [key, plan] of cases()) {
    const result = plan();
    const finishSeconds = result.plan.finish - result.plan.start;
    const old = stored[key];
    if (old?.hash === result.hash) {
      next[key] = old;
      continue;
    }
    changed.push(key);
    next[key] = { hash: result.hash, finishSeconds, note: process.env.GOLDEN_NOTE ?? "" };
  }
  const removed = Object.keys(stored).filter((k) => !(k in next));
  if (update) {
    assert.ok(process.env.GOLDEN_NOTE, "Set GOLDEN_NOTE to say why the plans changed.");
    writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n");
    return;
  }
  assert.deepEqual(
    { changed, removed },
    { changed: [], removed: [] },
    "Plans changed. If that is intended, rerun with UPDATE_GOLDEN=1 and GOLDEN_NOTE.",
  );
});
