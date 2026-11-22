import assert from "node:assert/strict";
import { test } from "node:test";
import { createGameData, validateGameData } from "@max-planner/gamedata";
import { parseExport, remainingWork, searchPlan } from "@max-planner/core";
import { demoExport, demoGameData } from "./demo.ts";

const at = 1_795_000_000;

test("the demo game data is valid and marked as made up", () => {
  const result = validateGameData(demoGameData());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.value.synthetic, true);
});

test("the demo village reads cleanly and plans to both halls", () => {
  const gd = createGameData(demoGameData());
  const parsed = parseExport(demoExport(at), gd, { now: at });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.report.warnings, []);
  assert.deepEqual(parsed.report.unknownIds, []);
  assert.equal(parsed.village.townHall, 4);
  assert.equal(parsed.report.totals.upgrading, 4);
  for (const target of [4, 5]) {
    const work = remainingWork(parsed.village, gd, { targetTownHall: target });
    assert.deepEqual(work.notes, []);
    const { plan } = searchPlan(work, parsed.village, gd, { seed: 1, variants: 4 });
    assert.deepEqual(plan.unplaced, []);
    assert.ok(plan.finish - plan.start >= work.lowerBound.seconds);
  }
});

test("the demo village is the same every time", () => {
  assert.equal(demoExport(at), demoExport(at));
});
