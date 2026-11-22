import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameEvent } from "@max-planner/gamedata";
import type { Step } from "../calc/remaining.ts";
import { gameEvents } from "../test-support.ts";
import { blockedUntil, eventDiscounts, expandEvents, saleAt, saleEndsAt } from "./windows.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const DAY = 86_400;
const hero = { category: "hero" } as Step;
const cannon = { category: "defense" } as Step;

test("dated events: past ones drop out, overlapping ones stay", () => {
  const events = gameEvents();
  // Hammer Jam ran 1 to 16 November 2026.
  assert.deepEqual(
    expandEvents(events, at("2026-11-18T00:00:00Z"), at("2027-01-01T00:00:00Z")),
    [],
  );
  const during = expandEvents(events, at("2026-11-10T00:00:00Z"), at("2026-12-01T00:00:00Z"));
  assert.deepEqual(
    during.map((w) => [w.id, w.start, w.end]),
    [["hammer-jam-2026", at("2026-11-01T08:00:00Z"), at("2026-11-16T08:00:00Z")]],
  );
});

test("projected events stay off until switched on, then repeat monthly", () => {
  const events = gameEvents();
  const from = at("2026-11-05T00:00:00Z");
  const to = at("2027-01-20T00:00:00Z");
  assert.ok(!expandEvents(events, from, to).some((w) => w.id === "clan-war-league"));
  const cwl = expandEvents(events, from, to, ["clan-war-league"]);
  // November's league (1st to 12th, 08:00 UTC) is already running at `from`.
  assert.deepEqual(
    cwl.map((w) => new Date(w.start * 1000).toISOString()),
    ["2026-11-01T08:00:00.000Z", "2026-12-01T08:00:00.000Z", "2027-01-01T08:00:00.000Z"],
  );
  assert.ok(cwl.every((w) => w.end - w.start === 11 * DAY && w.status === "projected"));
  // Switching on only the league switches Hammer Jam off.
  assert.ok(!cwl.some((w) => w.id === "hammer-jam-2026"));
});

test("discounts apply to home steps that start inside the window", () => {
  const sale: GameEvent = {
    id: "sale",
    name: "Sale",
    status: "confirmed",
    start: "2026-11-20T08:00:00Z",
    end: "2026-11-22T08:00:00Z",
    effects: [{ kind: "discount", timePct: 50, costPct: 40, villages: ["home"] }],
    source: "test",
  };
  const builderBase: GameEvent = {
    ...sale,
    id: "bb",
    effects: [{ kind: "discount", timePct: 50, costPct: 50, villages: ["builder"] }],
  };
  const windows = expandEvents(
    [sale, builderBase],
    at("2026-11-19T00:00:00Z"),
    at("2026-12-01T00:00:00Z"),
  );
  const [source, ...rest] = eventDiscounts(windows);
  assert.equal(rest.length, 0, "Builder Base discounts do not touch the home village");
  assert.deepEqual(source!(cannon, at("2026-11-20T08:00:00Z")), { timePct: 50, costPct: 40 });
  assert.deepEqual(source!(cannon, at("2026-11-22T08:00:00Z")), { timePct: 0, costPct: 0 });
  assert.equal(saleAt(windows, at("2026-11-21T00:00:00Z")), true);
  assert.equal(saleEndsAt(windows, at("2026-11-21T00:00:00Z")), at("2026-11-22T08:00:00Z"));
  assert.equal(saleEndsAt(windows, at("2026-11-23T00:00:00Z")), undefined);
});

test("the league stops hero upgrades starting, and nothing else", () => {
  const windows = expandEvents(
    gameEvents(),
    at("2026-12-01T00:00:00Z"),
    at("2026-12-31T00:00:00Z"),
    ["clan-war-league"],
  );
  const during = at("2026-12-05T00:00:00Z");
  assert.equal(blockedUntil(windows, hero, during), at("2026-12-12T08:00:00Z"));
  assert.equal(blockedUntil(windows, cannon, during), undefined);
  assert.equal(blockedUntil(windows, hero, at("2026-12-12T08:00:00Z")), undefined);
});
