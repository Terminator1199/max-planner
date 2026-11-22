import assert from "node:assert/strict";
import { test } from "node:test";
import type { Step } from "../calc/remaining.ts";
import { goldPassDiscount, goldPassPctAt, nextSeasonStart, seasonStartAt } from "./goldpass.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const pace = [
  { day: 1, pct: 10 },
  { day: 7, pct: 15 },
  { day: 14, pct: 20 },
];
const season = { pace, seasonStartDay: 1 };

test("season starts are the 1st at 08:00 UTC by default", () => {
  assert.equal(seasonStartAt(at("2026-11-20T12:00:00Z"), 1), at("2026-11-01T08:00:00Z"));
  assert.equal(seasonStartAt(at("2026-11-01T07:59:59Z"), 1), at("2026-10-01T08:00:00Z"));
  assert.equal(seasonStartAt(at("2027-01-01T00:00:00Z"), 1), at("2026-12-01T08:00:00Z"));
  assert.equal(nextSeasonStart(at("2026-11-20T12:00:00Z"), 1), at("2026-12-01T08:00:00Z"));
  assert.equal(nextSeasonStart(at("2026-12-20T12:00:00Z"), 1), at("2027-01-01T08:00:00Z"));
});

test("a start day past the 28th is refused, since some months lack it", () => {
  assert.throws(() => seasonStartAt(0, 29), RangeError);
});

test("the boost follows the pace through each season", () => {
  const from = at("2026-11-01T08:00:00Z");
  assert.equal(goldPassPctAt(season, from, at("2026-11-01T09:00:00Z")), 10);
  assert.equal(goldPassPctAt(season, from, at("2026-11-07T08:00:00Z")), 15); // day 7
  assert.equal(goldPassPctAt(season, from, at("2026-11-20T00:00:00Z")), 20);
  assert.equal(goldPassPctAt(season, from, at("2026-12-01T07:59:00Z")), 20);
  assert.equal(goldPassPctAt(season, from, at("2026-12-01T08:00:00Z")), 10); // new season
});

test("a typed-in percentage holds until the season ends", () => {
  const from = at("2026-11-20T12:00:00Z");
  const options = { ...season, currentPct: 5 };
  assert.equal(goldPassPctAt(options, from, at("2026-11-30T12:00:00Z")), 5);
  assert.equal(goldPassPctAt(options, from, at("2026-12-01T08:00:00Z")), 10);
});

test("the discount covers builders and research but not pets by default", () => {
  const from = at("2026-11-20T12:00:00Z");
  const source = goldPassDiscount(season, from);
  const step = (lane: Step["lane"]) => ({ lane }) as Step;
  assert.deepEqual(source(step("builder"), from), { timePct: 20, costPct: 20 });
  assert.deepEqual(source(step("lab"), from), { timePct: 20, costPct: 20 });
  assert.deepEqual(source(step("petHouse"), from), { timePct: 0, costPct: 0 });
  const all = goldPassDiscount({ ...season, lanes: ["petHouse"] }, from);
  assert.deepEqual(all(step("petHouse"), from), { timePct: 20, costPct: 20 });
});
