import assert from "node:assert/strict";
import { test } from "node:test";
import { remainingWork } from "../calc/remaining.ts";
import { parseExport } from "../parser/parse.ts";
import { IDS, T0, fakeVillage, fakeWork, readFixture, sampleGameData } from "../test-support.ts";
import { OnlineCalendar } from "../time/online.ts";
import { simulate, type Plan } from "./simulate.ts";

const H = 3600;
const gd = sampleGameData();

/** Step id -> [start, end] in hours after the export, plus the reason. */
function timeline(plan: Plan) {
  return Object.fromEntries(
    plan.steps.map((p) => [p.id, [(p.start - plan.start) / H, (p.end - plan.start) / H, p.reason]]),
  );
}

test("critical steps go first, least slack first", () => {
  // Two builders, 10 h + 6 h + 4 h of work: the bound is 10 h and every step is critical.
  const work = fakeWork(
    [
      { entityId: 1, seconds: 4 * H },
      { entityId: 2, seconds: 10 * H },
      { entityId: 3, seconds: 6 * H },
    ],
    2,
  );
  assert.equal(work.lowerBound.seconds, 10 * H);
  const plan = simulate(work, fakeVillage(2), gd);
  assert.deepEqual(timeline(plan), {
    "2:0:1": [0, 10, "critical"], // slack 0
    "3:0:1": [0, 6, "critical"], // slack 4 h
    "1:0:1": [6, 10, "only-ready"],
  });
  assert.equal(plan.finish - plan.start, 10 * H);
  assert.equal(plan.decisions, 2);
});

test("with time to spare, steps go by strategy value per hour", () => {
  const work = fakeWork([
    { entityId: 1, seconds: 1 * H, category: "defense" },
    { entityId: 2, seconds: 4 * H, category: "hero" },
    { entityId: 3, seconds: 2 * H, category: "defense" },
  ]);
  const far = 1000 * 24 * H;
  // Balanced: defense 1.5/h and 0.75/h beat the hero's 2.0 / 4 h = 0.5/h.
  const balanced = simulate(work, fakeVillage(1), gd, { targetFinish: far });
  assert.deepEqual(timeline(balanced), {
    "1:0:1": [0, 1, "value"],
    "3:0:1": [1, 3, "value"],
    "2:0:1": [3, 7, "only-ready"],
  });
  // Offense: the hero's 3.0 / 4 h = 0.75/h beats the 2 h defense's 1.0 / 2 h.
  const offense = simulate(work, fakeVillage(1), gd, { targetFinish: far, strategy: "offense" });
  assert.deepEqual(
    offense.steps.map((p) => p.id),
    ["1:0:1", "2:0:1", "3:0:1"],
  );
});

test("the Laboratory waits for its own upgrade and does short research meanwhile", () => {
  // One builder busy with a 10 h defense; the Laboratory upgrade (5 h) unlocks a 4 h
  // research. Bound: 15 h of builder work.
  const lab2 = `${IDS.laboratory}:0:2`;
  const work = fakeWork([
    { entityId: IDS.cannon, seconds: 10 * H },
    { entityId: IDS.laboratory, toLevel: 2, seconds: 5 * H, category: "army", blocksLane: "lab" },
    { entityId: IDS.barbarian, toLevel: 2, seconds: 3 * H, lane: "lab", category: "troop" },
    {
      entityId: IDS.lightning,
      toLevel: 2,
      seconds: 4 * H,
      lane: "lab",
      category: "spell",
      after: [lab2],
    },
  ]);
  assert.equal(work.lowerBound.seconds, 15 * H);
  const plan = simulate(work, fakeVillage(1), gd);
  assert.deepEqual(timeline(plan), {
    [`${IDS.cannon}:0:1`]: [0, 10, "critical"], // slack 5 h beats the lab upgrade's 6 h
    [`${IDS.barbarian}:0:2`]: [0, 3, "only-ready"], // fits before the builder is free
    [lab2]: [10, 15, "critical"],
    [`${IDS.lightning}:0:2`]: [15, 19, "only-ready"],
  });
  const lab = plan.steps.find((p) => p.id === lab2)!;
  assert.equal(plan.workers[lab.holds!]?.lane, "lab");
  assert.equal(plan.decisions, 2);
});

test("steps running in the export are pinned at the start, on extra workers if needed", () => {
  // One builder, but two upgrades running (an event builder, say).
  const work = fakeWork([
    { entityId: 1, seconds: 2 * H, inProgress: true },
    { entityId: 2, seconds: 5 * H, inProgress: true },
    { entityId: 3, seconds: 1 * H },
  ]);
  const plan = simulate(work, fakeVillage(1, { lab: false }), gd);
  assert.deepEqual(timeline(plan), {
    "1:0:1": [0, 2, "running"],
    "2:0:1": [0, 5, "running"],
    "3:0:1": [2, 3, "only-ready"],
  });
  assert.deepEqual(plan.workers[1], {
    lane: "builder",
    index: 1,
    opensAt: T0,
    closesAt: T0 + 5 * H,
  });
});

test("discounts fix the duration and cost when a step starts", () => {
  const work = fakeWork([
    { entityId: 1, seconds: 10 * H, cost: 1001 },
    { entityId: 2, seconds: 3 * H, inProgress: true },
  ]);
  const plan = simulate(work, fakeVillage(1), gd, {
    discounts: [() => ({ timePct: 20, costPct: 20 })],
  });
  const step = plan.steps.find((p) => p.id === "1:0:1")!;
  assert.deepEqual(
    [step.start - T0, step.seconds, step.baseSeconds, step.cost],
    [3 * H, 8 * H, 10 * H, 801],
  );
  assert.deepEqual(step.timePcts, [20]);
  // A running step was already paid for and timed by the game.
  assert.deepEqual(plan.steps.find((p) => p.id === "2:0:1")!.timePcts, []);
});

test("no step starts while the player is offline, and value counts the idle night", () => {
  // Export at 20:00 IST; offline 22:00 to 06:00. A 2.5 h defense would end at 22:30 and
  // leave the builder idle until 06:10, so the 10 h hero ending at 06:00 is worth more.
  const exportedAt = Date.parse("2026-11-20T14:30:00Z") / 1000;
  const village = { ...fakeVillage(1), exportedAt };
  const calendar = new OnlineCalendar(
    {
      timeZone: "Asia/Kolkata",
      offline: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "22:00", to: "06:00" }],
    },
    exportedAt,
  );
  const work = fakeWork([
    { entityId: 1, seconds: 2.5 * H, category: "defense" },
    { entityId: 2, seconds: 10 * H, category: "hero" },
  ]);
  const far = 1000 * 24 * H;
  const without = simulate(work, village, gd, { targetFinish: far });
  assert.equal(without.steps[0]!.id, "1:0:1");
  const plan = simulate(work, village, gd, { targetFinish: far, calendar });
  assert.deepEqual(
    plan.steps.map((p) => [p.id, new Date(p.start * 1000).toISOString()]),
    [
      ["2:0:1", "2026-11-20T14:30:00.000Z"], // 20:00 IST
      ["1:0:1", "2026-11-21T00:30:00.000Z"], // 06:00 IST, when the hero ends
    ],
  );
  // Ending at 22:00 sharp, the next start waits for the morning plus 10 minutes.
  const late = simulate(
    fakeWork([
      { entityId: 1, seconds: 2 * H },
      { entityId: 2, seconds: 1 * H, after: ["1:0:1"] },
    ]),
    village,
    gd,
    { calendar },
  );
  assert.equal(new Date(late.steps[1]!.start * 1000).toISOString(), "2026-11-21T00:40:00.000Z");
});

test("a step with nowhere to run is reported instead of looping", () => {
  const work = fakeWork([{ entityId: IDS.barbarian, toLevel: 2, seconds: H, lane: "lab" }]);
  const plan = simulate(work, fakeVillage(1, { lab: false }), gd);
  assert.deepEqual(plan.unplaced, [
    { stepId: `${IDS.barbarian}:0:2`, reason: "No Laboratory to do it." },
  ]);
  assert.equal(plan.halls[0]!.maxedAt, null);
});

test("the fixture village: Town Hall 3 is maxed at 26 h 25 min, as tight as it gets", () => {
  const parsed = parseExport(readFixture("synthetic-th2.json"), gd, { now: T0 });
  assert.ok(parsed.ok);
  const village = parsed.village;

  const now = simulate(remainingWork(village, gd), village, gd);
  // Two builders free at 600 s and 3,000 s take the Archer Tower and Army Camp (1 h each).
  assert.equal(now.finish - now.start, 6600);
  assert.deepEqual(now.halls, [{ townHall: 2, reachedAt: T0, maxedAt: T0 + 6600 }]);

  const work = remainingWork(village, gd, { targetTownHall: 3 });
  const plan = simulate(work, village, gd);
  assert.deepEqual(plan.unplaced, []);
  assert.equal(plan.steps.length, work.steps.length);
  // Town Hall 3 starts at 4,200 s, after the Archer Tower its gate needs, and takes 12 h.
  const hall = plan.halls[1]!;
  assert.equal(hall.reachedAt! - T0, 4200 + 12 * H);
  // After it, 143,100 s of builder work across three builders: 47,400 + 47,700 = 95,100 s.
  assert.equal(hall.maxedAt! - T0, 95_100);
  // The third Builder's Hut is bought the moment Town Hall 3 allows it.
  assert.deepEqual(plan.workers.at(-1), { lane: "builder", index: 2, opensAt: T0 + 47_400 });
  assert.ok(plan.finish - plan.start >= work.lowerBound.seconds);
});
