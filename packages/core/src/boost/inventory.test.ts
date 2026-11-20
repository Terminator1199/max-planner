import assert from "node:assert/strict";
import { test } from "node:test";
import type { SeasonsFile } from "@max-planner/gamedata";
import { magicItems } from "../test-support.ts";
import { arrivals, defaultPerMonth, Inventory } from "./inventory.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const items = magicItems();

test("stock arrives at the export; monthly items sit mid-slice in each season", () => {
  const from = at("2026-11-18T00:00:00Z");
  const to = at("2027-01-01T00:00:00Z");
  const list = arrivals(
    { stock: { "book-of-heroes": 1 }, perMonth: { "builder-potion": 2 } },
    1,
    from,
    to,
  );
  assert.deepEqual(
    list.map((a) => [a.item, new Date(a.at * 1000).toISOString(), a.source]),
    [
      ["book-of-heroes", "2026-11-18T00:00:00.000Z", "stock"],
      // November's season (1st 08:00 to 1 Dec 08:00) has 30 days: items at 7.5 and
      // 22.5 days in, and the first came before the export.
      ["builder-potion", "2026-11-23T20:00:00.000Z", "monthly"],
      // December has 31 days: items at 7.75 and 23.25 days in.
      ["builder-potion", "2026-12-09T02:00:00.000Z", "monthly"],
      ["builder-potion", "2026-12-24T14:00:00.000Z", "monthly"],
    ],
  );
});

test("holding limits waste what does not fit, and say when", () => {
  const inv = new Inventory(items, [
    { item: "builder-potion", at: 0, count: 4, source: "stock" },
    { item: "builder-potion", at: 10, count: 1, source: "monthly" },
    { item: "builder-potion", at: 20, count: 1, source: "monthly" },
    { item: "book-of-heroes", at: 20, count: 2, source: "monthly" },
  ]);
  assert.equal(inv.available("builder-potion", 0), 4);
  assert.equal(inv.available("builder-potion", 15), 5);
  inv.use("builder-potion", 15);
  assert.equal(inv.available("builder-potion", 25), 5);
  assert.equal(inv.available("book-of-heroes", 25), 1);
  assert.deepEqual(inv.wasted(), [{ item: "book-of-heroes", at: 20, count: 1 }]);
});

test("using what is not there, or going back in time, is an error", () => {
  const inv = new Inventory(items, []);
  assert.throws(() => inv.use("builder-potion", 0), /No builder-potion/);
  inv.available("builder-potion", 100);
  assert.throws(() => inv.available("builder-potion", 99), /forward/);
  assert.throws(
    () =>
      new Inventory(items, [{ item: "mystery", at: 0, count: 1, source: "stock" }]).available(
        "mystery",
        1,
      ),
    /Unknown magic item/,
  );
});

test("monthly defaults add every source, Gold Pass ones only with the pass", () => {
  const seasons = {
    perMonth: {
      "builder-potion": { free: 1, goldPass: 2, clanGames: 1, other: 0 },
      "book-of-heroes": { free: 0, goldPass: 1, clanGames: 0, other: 0 },
    },
  } as unknown as SeasonsFile;
  assert.deepEqual(defaultPerMonth(seasons, false), { "builder-potion": 2 });
  assert.deepEqual(defaultPerMonth(seasons, true), { "builder-potion": 4, "book-of-heroes": 1 });
});
