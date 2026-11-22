// Property tests: random game data and villages, checked against the invariants every
// plan must meet (LLD, "Scheduler invariants"). A failure prints its seed to replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameData } from "@max-planner/gamedata";
import { remainingWork, type RemainingWork } from "../calc/remaining.ts";
import { T0, sampleGameData } from "../test-support.ts";
import { randomGameData, randomVillage } from "../test-random.ts";
import { goldPassDiscount } from "../time/goldpass.ts";
import { OnlineCalendar } from "../time/online.ts";
import type { Village } from "../types.ts";
import { mulberry32 } from "./prng.ts";
import { simulate, type Plan, type SimulateOptions } from "./simulate.ts";
import { STRATEGIES } from "./weights.ts";

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

interface Case {
  seed: number;
  gd: GameData;
  village: Village;
  work: RemainingWork;
  options: SimulateOptions;
  discounted: boolean;
}

function randomCase(seed: number, gd?: GameData): Case {
  const rng = mulberry32(seed);
  gd ??= randomGameData(rng);
  const townHall = rng.int(1, gd.maxTownHall);
  const at = T0 + rng.int(0, 30 * 86_400);
  const village = randomVillage(rng, gd, townHall, at);
  const work = remainingWork(village, gd, { targetTownHall: rng.int(townHall, gd.maxTownHall) });
  const options: SimulateOptions = { strategy: STRATEGIES[rng.int(0, 2)]! };
  if (rng.next() < 0.4) {
    options.calendar = new OnlineCalendar(
      {
        timeZone: rng.next() < 0.5 ? "Asia/Kolkata" : "America/New_York",
        offline: [
          { days: EVERY_DAY, from: "23:00", to: "07:00" },
          ...(rng.next() < 0.5 ? [{ days: [1, 2, 3, 4, 5], from: "09:30", to: "17:30" }] : []),
        ],
      },
      at,
    );
  }
  const discounted = rng.next() < 0.3;
  if (discounted) {
    options.discounts = [
      goldPassDiscount(
        {
          pace: [
            { day: 1, pct: 10 },
            { day: 7, pct: 15 },
            { day: 14, pct: 20 },
          ],
          seasonStartDay: 1,
        },
        at,
      ),
    ];
  }
  if (rng.next() < 0.3) options.targetFinish = rng.int(0, 2) * work.lowerBound.seconds;
  if (rng.next() < 0.2) options.swaps = new Set([rng.int(0, 5), rng.int(0, 20)]);
  return { seed, gd, village, work, options, discounted };
}

function checkPlan(c: Case, plan: Plan, again: Plan) {
  const { work, options } = c;
  const steps = new Map(work.steps.map((s) => [s.id, s]));
  const placed = new Map(plan.steps.map((p) => [p.id, p]));

  // 1. Every remaining step is placed exactly once.
  assert.deepEqual(plan.unplaced, []);
  assert.equal(plan.steps.length, work.steps.length);
  assert.equal(placed.size, work.steps.length);

  // 2. No two steps overlap on one worker, counting the time a worker is held.
  const busy = new Map<number, [number, number, string][]>();
  for (const p of plan.steps) {
    for (const w of [p.worker, p.holds]) {
      if (w === null || w === undefined) continue;
      const list = busy.get(w) ?? [];
      list.push([p.start, p.end, p.id]);
      busy.set(w, list);
    }
  }
  for (const [w, list] of busy) {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const worker = plan.workers[w]!;
    for (let i = 0; i < list.length; i++) {
      const [s, e, id] = list[i]!;
      assert.ok(s >= worker.opensAt, `${id} starts before worker ${w} opens`);
      if (worker.closesAt !== undefined) assert.ok(e <= worker.closesAt, `${id} after close`);
      if (i > 0) {
        const prev = list[i - 1]!;
        // Zero-length steps never sit on a worker, so ends and starts may touch.
        assert.ok(s >= prev[1], `${prev[2]} and ${id} overlap on worker ${w}`);
      }
    }
  }
  for (const p of plan.steps) {
    if (p.worker !== null) assert.equal(plan.workers[p.worker]!.lane, p.lane, `${p.id} lane`);
  }

  // 3. Each step starts after every step it waits for has ended.
  for (const s of work.steps) {
    const p = placed.get(s.id)!;
    for (const q of s.after) {
      assert.ok(p.start >= placed.get(q)!.end, `${s.id} starts before ${q} ends`);
    }
  }

  // 4. No step starts while the player is offline (running ones started in the game).
  if (options.calendar) {
    for (const p of plan.steps) {
      if (p.reason === "running") continue;
      assert.ok(options.calendar.isOnline(p.start), `${p.id} starts offline`);
    }
  }

  // 5. Without discounts the finish is never earlier than the lower bound.
  if (!c.discounted) {
    assert.ok(
      plan.finish - plan.start >= work.lowerBound.seconds,
      `finish ${plan.finish - plan.start} under bound ${work.lowerBound.seconds}`,
    );
  }

  // 6. No step runs longer than its base duration; running steps start at the export.
  for (const p of plan.steps) {
    assert.ok(p.seconds <= p.baseSeconds, `${p.id} runs past its base time`);
    assert.equal(p.end - p.start, p.seconds);
    assert.ok(p.start >= plan.start);
    if (steps.get(p.id)!.inProgress) assert.equal(p.start, plan.start);
  }

  // 7. The same input gives the same plan.
  assert.deepEqual(again, plan);

  // Hall dates rise with the hall.
  for (let i = 1; i < plan.halls.length; i++) {
    assert.ok(plan.halls[i]!.reachedAt! >= plan.halls[i - 1]!.reachedAt!);
    assert.ok(plan.halls[i]!.maxedAt! >= plan.halls[i - 1]!.maxedAt!);
  }
  // A running Town Hall upgrade past the target may end after the target is maxed.
  assert.ok(plan.halls.at(-1)!.maxedAt! <= plan.finish);
  const beyond = work.steps.some((s) => s.hall && s.toLevel > work.targetTownHall);
  if (!beyond) assert.equal(plan.halls.at(-1)!.maxedAt, plan.finish);
}

function run(c: Case) {
  try {
    const plan = simulate(c.work, c.village, c.gd, c.options);
    const again = simulate(c.work, c.village, c.gd, c.options);
    checkPlan(c, plan, again);
    return plan;
  } catch (e) {
    (e as Error).message = `seed ${c.seed}: ${(e as Error).message}`;
    throw e;
  }
}

test("invariants hold on 300 random villages over random game data", () => {
  let steps = 0;
  for (let seed = 1; seed <= 300; seed++) steps += run(randomCase(seed)).steps.length;
  assert.ok(steps > 3000, `only ${steps} steps were exercised`);
});

test("invariants hold on 200 random villages over the sample game data", () => {
  const gd = sampleGameData();
  for (let seed = 1001; seed <= 1200; seed++) run(randomCase(seed, gd));
});

test("the random generators themselves are deterministic", () => {
  const a = randomCase(42);
  const b = randomCase(42);
  assert.deepEqual(a.village, b.village);
  assert.deepEqual(
    a.work.steps.map((s) => s.id),
    b.work.steps.map((s) => s.id),
  );
});
