import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvents, validateMagicItems, validateSeasons } from "./validate.ts";

function errorsOf(result: { ok: boolean; errors?: { path: string; message: string }[] }): string[] {
  return (result.errors ?? []).map((e) => `${e.path}: ${e.message}`);
}

test("an event needs dates or a recurrence, not both", () => {
  const event = {
    id: "x",
    name: "X",
    status: "projected",
    start: "2026-12-01T08:00:00Z",
    end: "2026-12-05T08:00:00Z",
    recurrence: { every: "month", startDay: 1, startHourUtc: 8, lengthDays: 4 },
    effects: [{ kind: "noHeroUpgrades" }],
    source: "test",
  };
  const errors = errorsOf(validateEvents({ version: "t", events: [event] }));
  assert.ok(
    errors.some((e) => e.includes("not both")),
    errors.join("\n"),
  );
});

test("a recurring event cannot be confirmed", () => {
  const event = {
    id: "x",
    name: "X",
    status: "confirmed",
    recurrence: { every: "month", startDay: 1, startHourUtc: 8, lengthDays: 4 },
    effects: [{ kind: "noHeroUpgrades" }],
    source: "test",
  };
  const errors = errorsOf(validateEvents({ version: "t", events: [event] }));
  assert.ok(
    errors.some((e) => e.includes("must be projected")),
    errors.join("\n"),
  );
});

test("event dates need a time zone and must run forwards", () => {
  const event = {
    id: "x",
    name: "X",
    status: "confirmed",
    start: "2026-12-05T08:00:00Z",
    end: "2026-12-01 08:00",
    effects: [{ kind: "discount", timePct: 50, costPct: 50, villages: ["home"] }],
    source: "test",
  };
  const errors = errorsOf(validateEvents({ version: "t", events: [event] }));
  assert.ok(
    errors.some((e) => e.includes("time zone")),
    errors.join("\n"),
  );
});

test("potions need lanes, a rate and a duration; books take categories", () => {
  const errors = errorsOf(
    validateMagicItems({
      version: "t",
      items: [
        { id: "p", name: "P", kind: "potion", categories: ["hero"], holdLimit: 5, source: "t" },
        { id: "b", name: "B", kind: "book", lanes: ["lab"], holdLimit: 1, source: "t" },
      ],
    }),
  );
  assert.ok(
    errors.some((e) => e.startsWith("$.items[0].lanes")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.startsWith("$.items[0].rateBonus")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.includes("potions act on lanes")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.includes("books and hammers take categories")),
    errors.join("\n"),
  );
});

test("seasons reject unknown items and a boost that falls", () => {
  const errors = errorsOf(
    validateSeasons(
      {
        version: "t",
        status: "set",
        seasonStartDay: 1,
        perMonth: { "mystery-potion": { free: 1, goldPass: 0, clanGames: 0, other: 0 } },
        goldPassBoostPace: [
          { day: 1, pct: 20 },
          { day: 7, pct: 10 },
        ],
        source: "t",
      },
      new Set(["builder-potion"]),
    ),
  );
  assert.ok(
    errors.some((e) => e.includes("unknown magic item")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.includes("never falls")),
    errors.join("\n"),
  );
});
