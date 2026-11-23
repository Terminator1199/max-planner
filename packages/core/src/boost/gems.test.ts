import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GEMS, MONTH_SECONDS, gemCost, gemsEarned, hasGems } from "./gems.ts";

const H = 3600;
const D = 86_400;

test("gem prices match the game's points and the lines between them", () => {
  assert.equal(gemCost(0), 0);
  assert.equal(gemCost(1), 1);
  assert.equal(gemCost(60), 1);
  assert.equal(gemCost(20 * 60), 7); // 20 minutes
  assert.equal(gemCost(H), 20);
  assert.equal(gemCost(4 * H), 51);
  assert.equal(gemCost(D), 260);
  assert.equal(gemCost(2 * D), 383);
  assert.equal(gemCost(7 * D), 1000);
  // Past a week the last line goes on.
  assert.equal(gemCost(14 * D), 1863);
});

test("a longer timer never costs fewer gems, and costs less per hour", () => {
  let last = 0;
  for (let s = 0; s <= 30 * D; s += 600) {
    const c = gemCost(s);
    assert.ok(c >= last, `${s}s cost ${c} after ${last}`);
    last = c;
  }
  assert.ok(gemCost(7 * D) / (7 * 24) < gemCost(D) / 24);
  assert.ok(gemCost(D) / 24 < gemCost(H));
});

test("monthly gems are earned evenly, on top of the stock", () => {
  const g = { ...DEFAULT_GEMS, stock: 100, perMonth: 3000 };
  assert.equal(gemsEarned(g, 0, 0), 100);
  assert.equal(gemsEarned(g, 0, MONTH_SECONDS / 2), 1600);
  assert.equal(gemsEarned(g, 0, MONTH_SECONDS * 12), 36_100);
  assert.equal(gemsEarned(g, 50, 0), 100, "nothing is earned before the start");
});

test("only stock above the reserve, or monthly gems, count as gems to spend", () => {
  assert.equal(hasGems(undefined), false);
  assert.equal(hasGems(DEFAULT_GEMS), false);
  assert.equal(hasGems({ ...DEFAULT_GEMS, stock: 500, reserve: 500 }), false);
  assert.equal(hasGems({ ...DEFAULT_GEMS, stock: 501, reserve: 500 }), true);
  assert.equal(hasGems({ ...DEFAULT_GEMS, perMonth: 1 }), true);
});
