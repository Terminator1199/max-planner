import { test } from "node:test";
import assert from "node:assert/strict";
import items from "../files/magic-items.json" with { type: "json" };
import events from "../files/events.json" with { type: "json" };
import seasons from "../files/seasons.json" with { type: "json" };
import { validateEvents, validateMagicItems, validateSeasons } from "./validate.ts";

test("magic-items.json is valid", () => {
  const result = validateMagicItems(items);
  assert.deepEqual(result.ok ? [] : result.errors, []);
});

test("events.json is valid", () => {
  const result = validateEvents(events);
  assert.deepEqual(result.ok ? [] : result.errors, []);
});

test("seasons.json is valid and names only known items", () => {
  const ids = new Set(items.items.map((item) => item.id));
  const result = validateSeasons(seasons, ids);
  assert.deepEqual(result.ok ? [] : result.errors, []);
  assert.equal(result.warnings.length, 1, "unset counts produce one warning");
});

test("a Builder Potion makes builders work 10x for an hour", () => {
  const potion = items.items.find((item) => item.id === "builder-potion");
  assert.equal(potion?.rateBonus, 9);
  assert.equal(potion?.seconds, 3600);
});
