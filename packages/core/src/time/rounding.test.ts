import assert from "node:assert/strict";
import { test } from "node:test";
import { combinedPct, discountedCost, discountedSeconds } from "./rounding.ts";

const H = 3600;
const D = 86_400;

test("no discount keeps the base duration and cost exactly", () => {
  assert.equal(discountedSeconds(61, []), 61);
  assert.equal(discountedSeconds(61, [0, 0]), 61);
  assert.equal(discountedCost(1001, []), 1001);
});

test("a 20% Gold Pass turns 10 hours into 8 with no float drift", () => {
  assert.equal(discountedSeconds(10 * H, [20]), 8 * H);
});

test("under 30 minutes rounds up to the second", () => {
  assert.equal(discountedSeconds(1999, [20]), 1600); // 1599.2
  assert.equal(discountedSeconds(2000, [20]), 1600);
});

test("up to a day rounds down to 10 minutes", () => {
  assert.equal(discountedSeconds(7200, [15]), 6000); // 6120 s = 1 h 42 min
  assert.equal(discountedSeconds(108_000, [20]), D); // exactly a day stays in this band
});

test("beyond a day rounds down to the hour (ClashClock's X-Bow example)", () => {
  // 20% off leaves 10 d 19 h 12 min unrounded; the game shows 10 d 19 h.
  const unrounded = 10 * D + 19 * H + 12 * 60;
  const base = (unrounded * 100) / 80;
  assert.equal(discountedSeconds(base, [20]), 10 * D + 19 * H);
});

test("discounts multiply: 50% and 20% leave 40%", () => {
  assert.equal(discountedSeconds(10 * H, [50, 20]), 4 * H);
  assert.equal(combinedPct([50, 20]), 60);
});

test("costs round up", () => {
  assert.equal(discountedCost(1001, [20]), 801); // 800.8
  assert.equal(discountedCost(0, [50]), 0);
});

test("a percentage that is not a whole number from 0 to 100 is rejected", () => {
  assert.throws(() => discountedSeconds(100, [12.5]), RangeError);
  assert.throws(() => discountedSeconds(100, [101]), RangeError);
  assert.throws(() => discountedCost(100, [-1]), RangeError);
});
