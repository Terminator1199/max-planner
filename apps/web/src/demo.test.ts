import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExport, remainingWork, searchPlan } from "@max-planner/core";
import { makeContext } from "./context.ts";
import { demoExport } from "./demo.ts";
import { planVillage } from "./planner.ts";
import gamedata from "@max-planner/gamedata/files/gamedata.json" with { type: "json" };
import items from "@max-planner/gamedata/files/magic-items.json" with { type: "json" };
import events from "@max-planner/gamedata/files/events.json" with { type: "json" };
import seasons from "@max-planner/gamedata/files/seasons.json" with { type: "json" };
import { DEFAULT_GEMS, DEFAULT_ITEM_RULES } from "@max-planner/core";

const ctx = makeContext({ gamedata, items, events, seasons });
const at = 1_795_000_000;

test("the demo village reads cleanly on the real data and plans every step", () => {
  const parsed = parseExport(demoExport(ctx.gd, at), ctx.gd, { now: at });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.report.warnings, []);
  assert.deepEqual(parsed.report.unknownIds, []);
  assert.equal(parsed.village.townHall, 14);
  assert.ok(parsed.report.totals.upgrading >= 4);
  const work = remainingWork(parsed.village, ctx.gd, { targetTownHall: 15 });
  assert.deepEqual(work.unplannable, []);
  const { plan } = searchPlan(work, parsed.village, ctx.gd, { seed: 1, variants: 2 });
  assert.deepEqual(plan.unplaced, []);
});

const settings = {
  target: null,
  strategy: "balanced",
  goldPass: true,
  goldPassPct: 15,
  offline: { on: true, from: "23:00", to: "07:00" },
  timeZone: "Asia/Kolkata",
  helpers: true,
  stock: { "builder-potion": 2 },
  perMonth: {},
  enabled: null,
  rules: { ...DEFAULT_ITEM_RULES },
  gems: { ...DEFAULT_GEMS },
} as const;

test("one planning request returns plain data the page can show", () => {
  const out = planVillage(ctx, {
    text: demoExport(ctx.gd, at),
    settings: {
      ...settings,
      stock: { ...settings.stock },
      perMonth: {},
      offline: { ...settings.offline },
      rules: { ...settings.rules },
      gems: { ...settings.gems },
    },
  });
  assert.ok(out.ok);
  assert.equal(out.hasGems, false);
  assert.deepEqual(out.plan.gemUses, []);
  assert.equal(out.target, 14);
  assert.ok(out.progress.fraction > 0.5 && out.progress.fraction < 1);
  assert.ok(out.offline.length > 0);
  assert.ok(out.plan.steps.length > 50);
  // Survives a structured clone, as it must to leave the worker.
  assert.deepEqual(structuredClone(out), out);
  const bad = planVillage(ctx, {
    text: "{}",
    settings: { ...(out.ok ? {} : {}), target: null } as never,
  });
  assert.equal(bad.ok, false);
});

test("gems bring the demo's max date forward and are only spent when they do", () => {
  const plan = (gems: typeof DEFAULT_GEMS) =>
    planVillage(ctx, {
      text: demoExport(ctx.gd, at),
      settings: {
        ...settings,
        stock: {},
        perMonth: {},
        offline: { ...settings.offline },
        rules: { ...settings.rules },
        gems,
      },
    });
  const none = plan({ ...DEFAULT_GEMS });
  const some = plan({ ...DEFAULT_GEMS, stock: 5000 });
  assert.ok(none.ok && some.ok);
  assert.ok(some.hasGems);
  assert.ok(some.gemsSaved > 7 * 86_400, `gems saved only ${some.gemsSaved}s`);
  assert.ok(some.plan.gemsSpent > 0 && some.plan.gemsSpent <= 5000);
  const maxed = (o: typeof some) => (o.ok ? o.plan.halls.at(-1)!.maxedAt! : 0);
  assert.equal(maxed(none) - maxed(some), some.gemsSaved);
  assert.equal(some.gemsToFinishAll, none.gemsToFinishAll);
  assert.ok(some.gemsToFinishAll > 10_000);
  // A reserve above the stock leaves nothing to spend.
  const kept = plan({ ...DEFAULT_GEMS, stock: 5000, reserve: 5000 });
  assert.ok(kept.ok && !kept.hasGems);
  assert.deepEqual(kept.plan.gemUses, []);
});
