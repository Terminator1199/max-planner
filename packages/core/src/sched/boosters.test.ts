// Magic items and events inside the scheduler, worked out by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameEvent } from "@max-planner/gamedata";
import { arrivals, type Arrival } from "../boost/inventory.ts";
import { expandEvents } from "../events/windows.ts";
import { T0, fakeVillage, fakeWork, magicItems, sampleGameData } from "../test-support.ts";
import { simulate, type Plan, type SimulateOptions } from "./simulate.ts";

const H = 3600;
const D = 86_400;
const gd = sampleGameData();
const items = magicItems();
const iso = (t: number) => new Date(t * 1000).toISOString();

const stock = (counts: Record<string, number>): Arrival[] =>
  Object.entries(counts).map(([item, count]) => ({ item, at: T0, count, source: "stock" }));
const withItems = (counts: Record<string, number>, rules = {}): SimulateOptions => ({
  boosters: { items, arrivals: stock(counts), rules },
});
const hours = (plan: Plan) =>
  Object.fromEntries(plan.steps.map((p) => [p.id, [(p.start - T0) / H, (p.end - T0) / H]]));
const event = (effects: GameEvent["effects"], fromHours: number, toHours: number): GameEvent => ({
  id: "test-event",
  name: "Test event",
  status: "confirmed",
  start: iso(T0 + fromHours * H),
  end: iso(T0 + toHours * H),
  effects,
  source: "test",
});

test("a Builder Potion on 4 busy builders saves 36 builder-hours (LLD example)", () => {
  // Four 20 h upgrades. The potion's hour does 10 h of work on each; 10 h are left.
  const work = fakeWork(
    [1, 2, 3, 4].map((entityId) => ({ entityId, seconds: 20 * H })),
    4,
  );
  const plan = simulate(work, fakeVillage(4), gd, withItems({ "builder-potion": 1 }));
  assert.deepEqual(plan.itemUses, [
    { item: "builder-potion", kind: "potion", at: T0, lane: "builder", savedSeconds: 36 * H },
  ]);
  assert.ok(plan.steps.every((p) => p.end - T0 === 11 * H));
  assert.equal(plan.finish - T0, 11 * H);
});

test("no potion while a builder is idle or has under 10 h of work left", () => {
  const idle = fakeWork([{ entityId: 1, seconds: 20 * H }], 2);
  assert.deepEqual(
    simulate(idle, fakeVillage(2), gd, withItems({ "builder-potion": 1 })).itemUses,
    [],
  );
  const short = fakeWork([{ entityId: 1, seconds: 9 * H }]);
  assert.deepEqual(
    simulate(short, fakeVillage(1), gd, withItems({ "builder-potion": 1 })).itemUses,
    [],
  );
  const off = fakeWork([{ entityId: 1, seconds: 20 * H }]);
  const plan = simulate(
    off,
    fakeVillage(1),
    gd,
    withItems({ "builder-potion": 1 }, { potions: "off" }),
  );
  assert.deepEqual(plan.itemUses, []);
});

test("a Research Potion makes an hour of research worth 24", () => {
  const work = fakeWork([{ entityId: 1, seconds: 48 * H, lane: "lab", category: "troop" }]);
  const plan = simulate(work, fakeVillage(1), gd, withItems({ "research-potion": 1 }));
  assert.equal(plan.steps[0]!.end - T0, 25 * H); // 24 h in the first hour, 24 h after
  assert.equal(plan.itemUses[0]!.savedSeconds, 23 * H);
});

test("a book finishes a long running upgrade and the builder moves on", () => {
  const work = fakeWork([
    { entityId: 1, seconds: 5 * D, inProgress: true },
    { entityId: 2, seconds: 1 * H },
  ]);
  const plan = simulate(work, fakeVillage(1), gd, withItems({ "book-of-building": 1 }));
  assert.deepEqual(hours(plan), { "1:0:1": [0, 0], "2:0:1": [0, 1] });
  assert.equal(plan.steps.find((p) => p.id === "1:0:1")!.item, "book-of-building");
  assert.deepEqual(plan.itemUses, [
    { item: "book-of-building", kind: "book", at: T0, stepId: "1:0:1", savedSeconds: 5 * D },
  ]);
});

test("Book of Everything is kept for a step no other book in stock fits", () => {
  // Builder 1 runs a 5-day defense, builder 2 a 4-day hero. Only Book of Heroes and Book
  // of Everything are in stock: the defense gets Everything, the hero gets Heroes.
  const work = fakeWork(
    [
      { entityId: 1, seconds: 5 * D, inProgress: true, category: "defense" },
      { entityId: 2, seconds: 4 * D, inProgress: true, category: "hero" },
    ],
    2,
  );
  const plan = simulate(
    work,
    fakeVillage(2),
    gd,
    withItems({ "book-of-everything": 1, "book-of-heroes": 1 }),
  );
  assert.deepEqual(
    plan.itemUses.map((u) => [u.item, u.stepId]),
    [
      ["book-of-everything", "1:0:1"],
      ["book-of-heroes", "2:0:1"],
    ],
  );
});

test("books wait out an event discount, then go on what is left", () => {
  // A 50% event runs for the first two days, so the book waits and saves the 3 days left.
  const work = fakeWork([{ entityId: 1, seconds: 5 * D, inProgress: true }]);
  const events = expandEvents(
    [event([{ kind: "discount", timePct: 50, costPct: 50, villages: ["home"] }], -24, 48)],
    T0,
    T0 + 30 * D,
  );
  const plan = simulate(work, fakeVillage(1), gd, {
    ...withItems({ "book-of-building": 1 }),
    events,
  });
  assert.deepEqual(plan.itemUses, [
    {
      item: "book-of-building",
      kind: "book",
      at: T0 + 2 * D,
      stepId: "1:0:1",
      savedSeconds: 3 * D,
    },
  ]);
  const eager = simulate(work, fakeVillage(1), gd, {
    ...withItems({ "book-of-building": 1 }, { saveBooksForFullPrice: false }),
    events,
  });
  assert.equal(eager.itemUses[0]!.at, T0);
});

test("a hammer finishes a long waiting step at no cost; short ones wait their turn", () => {
  const work = fakeWork([
    { entityId: 1, seconds: 6 * D, cost: 5000 },
    { entityId: 2, seconds: 4 * D },
    { entityId: 3, seconds: 1 * H },
  ]);
  const plan = simulate(work, fakeVillage(1), gd, withItems({ "hammer-of-building": 1 }));
  const hammered = plan.steps.find((p) => p.id === "1:0:1")!;
  assert.deepEqual(
    [hammered.start, hammered.end, hammered.cost, hammered.reason, hammered.worker],
    [T0, T0, 0, "hammer", null],
  );
  assert.deepEqual(
    plan.itemUses.map((u) => [u.item, u.stepId, u.savedSeconds]),
    [["hammer-of-building", "1:0:1", 6 * D]],
  );
  // The 4-day step is under the 5-day rule, so the builder does it.
  assert.equal(plan.finish - T0, 4 * D + H);
});

test("an event discount is fixed for steps that start inside it", () => {
  // 50% off for the first 6 hours: two 10 h upgrades start inside it and take 5 h each,
  // the third starts at 10 h, after it, and takes the full 10 h.
  const work = fakeWork([1, 2, 3].map((entityId) => ({ entityId, seconds: 10 * H, cost: 1000 })));
  const events = expandEvents(
    [event([{ kind: "discount", timePct: 50, costPct: 50, villages: ["home"] }], 0, 6)],
    T0,
    T0 + D,
  );
  const plan = simulate(work, fakeVillage(1), gd, { events, targetFinish: 0 });
  assert.deepEqual(hours(plan), { "1:0:1": [0, 5], "2:0:1": [5, 10], "3:0:1": [10, 20] });
  assert.deepEqual(
    plan.steps.map((p) => [p.cost, p.timePcts]),
    [
      [500, [50]],
      [500, [50]],
      [1000, []],
    ],
  );
});

test("during the league, hero upgrades wait and the builder does other work", () => {
  const work = fakeWork([
    { entityId: 1, seconds: 10 * H, category: "hero" },
    { entityId: 2, seconds: 2 * H, category: "defense" },
  ]);
  const events = expandEvents([event([{ kind: "noHeroUpgrades" }], 0, 24)], T0, T0 + 2 * D);
  const plan = simulate(work, fakeVillage(1), gd, { events, targetFinish: 0 });
  assert.deepEqual(hours(plan), { "2:0:1": [0, 2], "1:0:1": [24, 34] });
});

test("items arriving past the holding limit are reported as wasted", () => {
  // Five potions in hand (the limit), two more a month, potions switched off: the 23 Nov,
  // 9 Dec and 24 Dec potions have nowhere to go before the 40-day upgrade ends.
  const work = fakeWork([{ entityId: 1, seconds: 40 * D }]);
  const incoming = arrivals(
    { stock: { "builder-potion": 5 }, perMonth: { "builder-potion": 2 } },
    1,
    T0,
    T0 + 60 * D,
  );
  const plan = simulate(work, fakeVillage(1), gd, {
    boosters: { items, arrivals: incoming, rules: { potions: "off" } },
  });
  assert.deepEqual(
    plan.wasted.map((w) => [iso(w.at).slice(0, 10), w.count]),
    [
      ["2026-11-23", 1],
      ["2026-12-09", 1],
      ["2026-12-24", 1],
    ],
  );
});
