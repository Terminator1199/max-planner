import assert from "node:assert/strict";
import { test } from "node:test";
import { remainingWork } from "../calc/remaining.ts";
import { T0, fakeVillage, fakeWork, magicItems, sampleGameData } from "../test-support.ts";
import { randomGameData, randomVillage } from "../test-random.ts";
import { mulberry32 } from "./prng.ts";
import { betterPlan, planHash, searchPlan, searchWithBoosts, searchWithItems } from "./search.ts";
import { simulate } from "./simulate.ts";

const H = 3600;
const gd = sampleGameData();

test("the same input and seed give the same plan and hash", () => {
  const rng = mulberry32(3);
  const rgd = randomGameData(rng);
  const village = randomVillage(rng, rgd, 1, T0);
  const work = remainingWork(village, rgd, { targetTownHall: rgd.maxTownHall });
  const a = searchPlan(work, village, rgd, { seed: 11 });
  const b = searchPlan(work, village, rgd, { seed: 11 });
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.plan, b.plan);
  assert.equal(a.hash, planHash(a.plan));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test("the search never does worse than its own base runs", () => {
  let improved = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(seed);
    const rgd = randomGameData(rng);
    const townHall = rng.int(1, rgd.maxTownHall);
    const village = randomVillage(rng, rgd, townHall, T0);
    const work = remainingWork(village, rgd, { targetTownHall: rgd.maxTownHall });
    const result = searchPlan(work, village, rgd, { seed, variants: 16 });
    const chain = simulate(work, village, rgd, { targetFinish: 0 });
    const lld = simulate(work, village, rgd);
    assert.equal(result.chainFinish, chain.finish);
    assert.ok(!betterPlan(chain, result.plan), `seed ${seed}: chain run beat the search`);
    assert.ok(!betterPlan(lld, result.plan), `seed ${seed}: LLD run beat the search`);
    assert.ok(result.plan.finish - result.plan.start >= work.lowerBound.seconds);
    if (result.plan.finish < chain.finish) improved++;
  }
  assert.ok(improved > 0, "variants never improved on the chain run");
});

test("the search keeps the best packing of independent jobs", () => {
  // Two builders and jobs of 5, 4, 3 and 3 h: the best split is 5 + 3 and 4 + 3, 8 h.
  const work = fakeWork(
    [
      { entityId: 1, seconds: 5 * H },
      { entityId: 2, seconds: 4 * H },
      { entityId: 3, seconds: 3 * H },
      { entityId: 4, seconds: 3 * H },
    ],
    2,
  );
  const result = searchPlan(work, fakeVillage(2), gd, { variants: 8 });
  assert.equal(result.plan.finish - T0, 8 * H);
});

test("a time budget stops the search early but still returns a plan", () => {
  const work = fakeWork([
    { entityId: 1, seconds: H },
    { entityId: 2, seconds: 2 * H },
  ]);
  let now = 0;
  const clock = () => (now += 1000); // each read is a second later
  const progress: number[] = [];
  const result = searchPlan(work, fakeVillage(1), gd, {
    clock,
    budgetMs: 2500,
    onProgress: (f) => progress.push(f),
  });
  assert.equal(result.stoppedEarly, true);
  assert.ok(result.runs >= 1 && result.runs < 10, `ran ${result.runs} times`);
  assert.equal(result.plan.unplaced.length, 0);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(
    progress,
    [...progress].sort((a, b) => a - b),
  );
});

test("the plan hash changes when any step moves", () => {
  const work = fakeWork([
    { entityId: 1, seconds: H },
    { entityId: 2, seconds: 2 * H },
  ]);
  const plan = simulate(work, fakeVillage(1), gd);
  const moved = {
    ...plan,
    steps: plan.steps.map((p, i) => (i === 1 ? { ...p, end: p.end + 1 } : p)),
  };
  assert.notEqual(planHash(plan), planHash(moved));
});

test("at the same finish, the plan doing the strategy's priorities first wins", () => {
  // One builder, so every order finishes at 70 h. Longest first would do the hero, the
  // trap, then the defense; value per hour (balanced) does the defense first.
  const work = fakeWork([
    { entityId: 1, seconds: 40 * H, category: "hero" },
    { entityId: 2, seconds: 10 * H, category: "defense" },
    { entityId: 3, seconds: 20 * H, category: "trap" },
  ]);
  const result = searchPlan(work, fakeVillage(1), gd, { variants: 8 });
  assert.equal(result.plan.finish - T0, 70 * H);
  assert.deepEqual(
    result.plan.steps.map((p) => p.id),
    ["2:0:1", "1:0:1", "3:0:1"],
  );
  assert.equal(result.foundBy, "target");
  const chain = simulate(work, fakeVillage(1), gd, { targetFinish: 0 });
  assert.ok(result.plan.valueIn30Days > chain.valueIn30Days);
});

test("a tolerance trades a little finish for more early value, never more than allowed", () => {
  const day = 24 * H;
  let traded = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const rng = mulberry32(seed);
    const rgd = randomGameData(rng);
    const village = randomVillage(rng, rgd, rng.int(1, rgd.maxTownHall), T0);
    const work = remainingWork(village, rgd, { targetTownHall: rgd.maxTownHall });
    const strict = searchPlan(work, village, rgd, { seed, variants: 8 });
    const loose = searchPlan(work, village, rgd, { seed, variants: 8, toleranceSeconds: day });
    assert.equal(strict.plan.finish, strict.fastestFinish);
    assert.ok(loose.plan.finish <= loose.fastestFinish + day, `seed ${seed}: past the tolerance`);
    // Both searches share their base runs, so neither can be slower than the chain run.
    assert.ok(
      loose.fastestFinish <= loose.chainFinish && strict.fastestFinish <= strict.chainFinish,
    );
    if (loose.plan.finish > loose.fastestFinish) traded++;
  }
  assert.ok(traded > 0, "no village traded finish for value");
});

test("items are planned twice, with and without, and the saving is the difference", () => {
  const work = fakeWork(
    [1, 2, 3, 4].map((entityId) => ({ entityId, seconds: 20 * H })),
    4,
  );
  const boosters = {
    items: magicItems(),
    arrivals: [{ item: "builder-potion", at: T0, count: 1, source: "stock" as const }],
  };
  const result = searchWithItems(work, fakeVillage(4), gd, { boosters, variants: 4 });
  assert.equal(result.withoutItems.plan.finish - T0, 20 * H);
  assert.equal(result.withItems.plan.finish - T0, 11 * H);
  assert.equal(result.savedSeconds, 9 * H);
  assert.deepEqual(result.withoutItems.plan.itemUses, []);
});

test("a replayed winner gives back the same plan", () => {
  const rng = mulberry32(5);
  const rgd = randomGameData(rng);
  const village = randomVillage(rng, rgd, 1, T0);
  const work = remainingWork(village, rgd, { targetTownHall: rgd.maxTownHall });
  const first = searchPlan(work, village, rgd, { seed: 2, variants: 8 });
  const replay = searchPlan(work, village, rgd, {
    seed: 2,
    variants: 0,
    targetRuns: 0,
    alsoTry: [first.params],
  });
  assert.equal(replay.plan.finish, first.plan.finish);
  assert.equal(replay.hash, first.hash);
});

test("items never make the reported plan slower", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rng = mulberry32(seed);
    const rgd = randomGameData(rng);
    const village = randomVillage(rng, rgd, 1, T0);
    const work = remainingWork(village, rgd, { targetTownHall: rgd.maxTownHall });
    const boosters = {
      items: magicItems(),
      arrivals: [
        { item: "builder-potion", at: T0, count: 2, source: "stock" as const },
        { item: "book-of-building", at: T0, count: 1, source: "stock" as const },
      ],
    };
    const r = searchWithItems(work, village, rgd, { seed, variants: 6, boosters });
    assert.ok(r.savedSeconds >= 0, `seed ${seed}: items made it slower`);
    assert.equal(r.savedSeconds, r.withoutItems.plan.finish - r.withItems.plan.finish);
    if (!r.itemsHelp) assert.equal(r.withItems, r.withoutItems);
  }
});

test("items, then gems, each only ever bring the finish forward", () => {
  let gemsHelped = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const rng = mulberry32(seed);
    const rgd = randomGameData(rng);
    const village = randomVillage(rng, rgd, 1, T0);
    const work = remainingWork(village, rgd, { targetTownHall: rgd.maxTownHall });
    const boosters = {
      items: magicItems(),
      arrivals: [{ item: "builder-potion", at: T0, count: 1, source: "stock" as const }],
    };
    const gems = { stock: 3000, perMonth: 1500, reserve: 0, minDays: 1 };
    const r = searchWithBoosts(work, village, rgd, { seed, variants: 4, boosters, gems });
    assert.ok(r.items.plan.finish <= r.plain.plan.finish, `seed ${seed}: items slower`);
    assert.ok(r.all.plan.finish <= r.items.plan.finish, `seed ${seed}: gems slower`);
    assert.equal(r.itemsSaved, r.plain.plan.finish - r.items.plan.finish);
    assert.equal(r.gemsSaved, r.items.plan.finish - r.all.plan.finish);
    if (!r.gemsHelp) assert.equal(r.all, r.items);
    else assert.ok(r.all.plan.gemsSpent > 0 || r.gemsSaved === 0);
    if (r.gemsSaved > 0) gemsHelped++;
    // Without gems, the third search is skipped.
    const none = searchWithBoosts(work, village, rgd, { seed, variants: 4, boosters });
    assert.equal(none.all, none.items);
    assert.deepEqual(none.all.plan.gemUses, []);
  }
  assert.ok(gemsHelped > 0, "gems never helped");
});
