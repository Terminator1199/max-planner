import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameData, validateGameData, type GameDataFile } from "@max-planner/gamedata";
import sample from "../../../../fixtures/gamedata/sample.json" with { type: "json" };
import { parseExport } from "../parser/parse.ts";
import { IDS, exportText, readFixture, sampleGameData } from "../test-support.ts";
import type { Village } from "../types.ts";
import { CycleError, remainingWork, stepId, type Step } from "./remaining.ts";

const gd = sampleGameData();
const H = 3600;

function fixtureVillage(): Village {
  const result = parseExport(readFixture("synthetic-th2.json"), gd);
  assert.ok(result.ok);
  return result.village;
}

function byId(steps: Step[]) {
  return new Map(steps.map((s) => [s.id, s]));
}

// The expected numbers below are worked out by hand from fixtures/gamedata/sample.json
// and fixtures/exports/synthetic-th2.json.

test("max of the current hall: running timers, missing levels and new instances", () => {
  const work = remainingWork(fixtureVillage(), gd);
  const ids = work.steps.map((s) => s.id).sort();
  assert.deepEqual(
    ids,
    [
      stepId(IDS.goldStorage, 0, 2), // running, 600 s left
      stepId(IDS.cannon, 0, 3), // running, 3000 s left
      stepId(IDS.archerTower, 0, 2),
      stepId(IDS.bomb, 1, 1), // second bomb, not built yet
      stepId(IDS.armyCamp, 1, 2),
      stepId(IDS.barbarian, 0, 2), // running research, 5000 s left
    ].sort(),
  );
  const steps = byId(work.steps);
  assert.equal(steps.get(stepId(IDS.cannon, 0, 3))?.seconds, 3000);
  assert.equal(steps.get(stepId(IDS.cannon, 0, 3))?.cost, 0, "already paid");
  assert.equal(steps.get(stepId(IDS.cannon, 0, 3))?.inProgress, true);
  assert.deepEqual(work.hallSteps, []);
});

test("max of the current hall: totals and walls", () => {
  const { totals } = remainingWork(fixtureVillage(), gd);
  assert.deepEqual(totals.seconds, { builder: 600 + 3000 + H + 0 + H, lab: 5000, petHouse: 0 });
  assert.deepEqual(totals.cost, { gold: 2000 + 400, elixir: 2000, darkElixir: 0 });
  assert.deepEqual(totals.walls, { upgrades: 8, cost: { gold: 8000, elixir: 0, darkElixir: 0 } });
});

test("max of the current hall: lower bound is builder work over two builders", () => {
  const { lowerBound } = remainingWork(fixtureVillage(), gd);
  assert.equal(lowerBound.builders, 2);
  // The longest chain is the single running research step.
  assert.deepEqual(lowerBound.terms, { builders: 5400, lab: 5000, petHouse: 0, chain: 5000 });
  assert.equal(lowerBound.bottleneck, "builders");
  assert.equal(lowerBound.seconds, 5400);
});

test("target hall 3: hall step waits on its gate", () => {
  const work = remainingWork(fixtureVillage(), gd, { targetTownHall: 3 });
  const hall = stepId(IDS.townHall, 0, 3);
  assert.deepEqual(work.hallSteps, [hall]);
  const steps = byId(work.steps);
  // Gate at hall 2: Laboratory 1 (already built) and Archer Tower 2 (not yet).
  assert.deepEqual(steps.get(hall)?.after, [stepId(IDS.archerTower, 0, 2)]);
  assert.equal(steps.get(hall)?.seconds, 12 * H);
});

test("target hall 3: new instances wait for the hall that allows them", () => {
  const steps = byId(remainingWork(fixtureVillage(), gd, { targetTownHall: 3 }).steps);
  const hall = stepId(IDS.townHall, 0, 3);
  // A second Archer Tower is allowed only at hall 3; its later levels carry that hall too.
  assert.deepEqual(steps.get(stepId(IDS.archerTower, 1, 1))?.after, [hall]);
  assert.equal(steps.get(stepId(IDS.archerTower, 1, 2))?.townHall, 3);
  // The second Bomb is allowed at hall 2 already.
  assert.deepEqual(steps.get(stepId(IDS.bomb, 1, 1))?.after, []);
  // A third builder's hut, a hero and a new spell.
  assert.ok(steps.has(stepId(IDS.builderHut, 2, 1)));
  assert.ok(steps.has(stepId(IDS.king, 0, 3)));
  assert.ok(steps.has(stepId(IDS.lightning, 0, 2)));
});

test("target hall 3: research waits on the Laboratory, and a running step on itself", () => {
  const steps = byId(remainingWork(fixtureVillage(), gd, { targetTownHall: 3 }).steps);
  const barbarian3 = steps.get(stepId(IDS.barbarian, 0, 3));
  assert.deepEqual(
    barbarian3?.after.sort(),
    [stepId(IDS.barbarian, 0, 2), stepId(IDS.townHall, 0, 3), stepId(IDS.laboratory, 0, 2)].sort(),
  );
  assert.equal(steps.get(stepId(IDS.laboratory, 0, 2))?.blocksLane, "lab");
});

test("target hall 3: a cost above storage capacity waits on storage upgrades", () => {
  const steps = byId(remainingWork(fixtureVillage(), gd, { targetTownHall: 3 }).steps);
  // Lightning 2 costs 15000 elixir; two level 2 Elixir Storages hold 12000.
  const lightning2 = steps.get(stepId(IDS.lightning, 0, 2));
  assert.ok(lightning2?.after.includes(stepId(IDS.elixirStorage, 0, 3)));
  // Barbarian 3 costs 10000, which fits, so it has no storage edge.
  const barbarian3 = steps.get(stepId(IDS.barbarian, 0, 3));
  assert.ok(!barbarian3?.after.some((id) => id.startsWith(`${IDS.elixirStorage}:`)));
});

test("target hall 3: the hero chain after the hall is the bottleneck", () => {
  const { lowerBound } = remainingWork(fixtureVillage(), gd, { targetTownHall: 3 });
  assert.equal(lowerBound.builders, 3, "hall 3 allows a third builder");
  assert.deepEqual(lowerBound.terms, {
    builders: 197100 / 3,
    lab: 5000 + 14400 + 0 + 21600 + 7200, // research plus the Laboratory's own upgrade
    petHouse: 0,
    chain: H + 12 * H + 0 + 4 * H + 8 * H,
  });
  assert.equal(lowerBound.bottleneck, "chain");
  assert.deepEqual(lowerBound.chainSteps, [
    stepId(IDS.archerTower, 0, 2),
    stepId(IDS.townHall, 0, 3),
    stepId(IDS.king, 0, 1),
    stepId(IDS.king, 0, 2),
    stepId(IDS.king, 0, 3),
  ]);
});

test("hall bounds: the bound for hall 2 matches planning hall 2 alone", () => {
  const village = fixtureVillage();
  const up = remainingWork(village, gd, { targetTownHall: 3 });
  const only = remainingWork(village, gd);
  assert.deepEqual(
    up.hallBounds.map((h) => h.townHall),
    [2, 3],
  );
  assert.deepEqual(up.hallBounds[0]?.lowerBound, only.lowerBound);
  assert.equal(up.totals.byHall[2]?.steps, only.steps.length);
});

test("steps come in dependency order and tails are consistent", () => {
  const work = remainingWork(fixtureVillage(), gd, { targetTownHall: 3 });
  const seen = new Set<string>();
  for (const step of work.steps) {
    for (const p of step.after) assert.ok(seen.has(p), `${step.id} before ${p}`);
    seen.add(step.id);
  }
  const longestTail = Math.max(...work.tail.values());
  assert.equal(longestTail, work.lowerBound.terms.chain);
});

test("a Town Hall already upgrading becomes the running hall step", () => {
  const text = exportText([
    { data: IDS.townHall, lvl: 2, timer: 10 * H },
    { data: IDS.builderHut, lvl: 1, cnt: 2 },
  ]);
  const result = parseExport(text, gd);
  assert.ok(result.ok);
  const work = remainingWork(result.village, gd, { targetTownHall: 3 });
  const hall = stepId(IDS.townHall, 0, 3);
  assert.deepEqual(work.hallSteps, [hall]);
  const steps = byId(work.steps);
  assert.equal(steps.get(hall)?.inProgress, true);
  assert.equal(steps.get(hall)?.seconds, 10 * H);
  assert.ok(steps.get(stepId(IDS.king, 0, 1))?.after.includes(hall));
});

test("rejects a target below the current hall or above the data", () => {
  const village = fixtureVillage();
  assert.throws(() => remainingWork(village, gd, { targetTownHall: 1 }), RangeError);
  assert.throws(() => remainingWork(village, gd, { targetTownHall: 4 }), RangeError);
});

// --- data problems ---------------------------------------------------------------------------

function withData(change: (file: GameDataFile) => void) {
  const copy = structuredClone(sample) as unknown as GameDataFile;
  change(copy);
  const result = validateGameData(copy);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.errors));
  return createGameData(result.value);
}

test("a gate the plan cannot meet makes the hall and its dependents unplannable", () => {
  const data = withData((f) => {
    f.townHalls[1]!.gate = [{ entityId: IDS.archerTower, level: 2, count: 5 }];
  });
  const work = remainingWork(fixtureVillage(), data, { targetTownHall: 3 });
  assert.deepEqual(work.hallSteps, []);
  assert.equal(work.unplannable[0]?.stepId, stepId(IDS.townHall, 0, 3));
  assert.ok(work.unplannable.some((u) => u.stepId === stepId(IDS.king, 0, 1)));
  assert.ok(!work.steps.some((s) => s.townHall === 3));
});

test("a gate that needs the next hall's own work is reported as a cycle", () => {
  const data = withData((f) => {
    f.townHalls[1]!.gate = [{ entityId: IDS.archerTower, level: 3 }];
  });
  assert.throws(
    () => remainingWork(fixtureVillage(), data, { targetTownHall: 3 }),
    (e: unknown) => e instanceof CycleError && e.stepIds.includes(stepId(IDS.townHall, 0, 3)),
  );
});
