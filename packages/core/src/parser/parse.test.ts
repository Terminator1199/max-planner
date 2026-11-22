import { test } from "node:test";
import assert from "node:assert/strict";
import { IDS, exportText, readFixture, sampleGameData } from "../test-support.ts";
import { parseExport, type ParseResult } from "./parse.ts";

const gd = sampleGameData();
const T0 = 1_795_000_000;

function ok(result: ParseResult) {
  assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
  return result;
}

const HALL = { data: IDS.townHall, lvl: 2 };

// --- the full fixture ---------------------------------------------------------

test("fixture: Town Hall, builders, instances and walls", () => {
  const { village, report } = ok(parseExport(readFixture("synthetic-th2.json"), gd));
  assert.equal(village.tag, "#FIXTURE01");
  assert.equal(village.exportedAt, T0);
  assert.equal(village.townHall, 2);
  assert.equal(village.builders, 2);
  assert.deepEqual(village.walls, [
    { entityId: IDS.wall, level: 2, count: 12 },
    { entityId: IDS.wall, level: 1, count: 8 },
  ]);
  assert.equal(report.totals.walls, 20);
  assert.equal(report.totals.upgrading, 3, "gold storage, cannon and barbarian");
  assert.equal(report.totals.instances, village.instances.length);
});

test("fixture: running timers finish at export time plus the timer", () => {
  const { village } = ok(parseExport(readFixture("synthetic-th2.json"), gd));
  const cannons = village.instances.filter((i) => i.entityId === IDS.cannon);
  assert.deepEqual(cannons, [
    { entityId: IDS.cannon, level: 2, finishesAt: T0 + 3000, index: 0 },
    { entityId: IDS.cannon, level: 3, index: 1 },
  ]);
  const barbarian = village.instances.find((i) => i.entityId === IDS.barbarian);
  assert.equal(barbarian?.finishesAt, T0 + 5000, "research rows follow the same rules");
});

test("fixture: unknown ids, fields and sections are reported, not dropped silently", () => {
  const { report } = ok(parseExport(readFixture("synthetic-th2.json"), gd));
  assert.deepEqual(report.unknownIds, [{ section: "buildings", id: 8000001, rows: 1 }]);
  assert.deepEqual(report.unknownFields, [{ section: "buildings", field: "extra_field", rows: 1 }]);
  const uses = Object.fromEntries(report.sections.map((s) => [s.key, s.use]));
  assert.deepEqual(uses, {
    buildings: "plan",
    traps: "plan",
    units: "plan",
    helpers: "helpers",
    buildings2: "ignore",
    decos: "ignore",
    mystery_section: "unknown",
  });
});

test("fixture: helpers keep their level and cooldown", () => {
  const { village } = ok(parseExport(readFixture("synthetic-th2.json"), gd));
  assert.deepEqual(village.helpers, [{ dataId: 93000000, level: 2, cooldownSeconds: 3600 }]);
});

// --- row rules ------------------------------------------------------------------

test("cnt adds that many idle instances; no cnt and no timer adds one", () => {
  const { village } = ok(
    parseExport(
      exportText([HALL, { data: IDS.armyCamp, lvl: 2, cnt: 2 }, { data: IDS.builderHut, lvl: 1 }]),
      gd,
    ),
  );
  assert.equal(village.instances.filter((i) => i.entityId === IDS.armyCamp).length, 2);
  assert.equal(village.builders, 1);
});

test("instances are ordered upgrading first, then by level, highest first", () => {
  const { village } = ok(
    parseExport(
      exportText([
        HALL,
        { data: IDS.cannon, lvl: 1 },
        { data: IDS.cannon, lvl: 3 },
        { data: IDS.cannon, lvl: 1, timer: 60 },
      ]),
      gd,
    ),
  );
  const order = village.instances
    .filter((i) => i.entityId === IDS.cannon)
    .map((i) => [i.index, i.level, i.finishesAt !== undefined]);
  assert.deepEqual(order, [
    [0, 1, true],
    [1, 3, false],
    [2, 1, false],
  ]);
});

test("a level 0 row with a timer is a building under construction", () => {
  const { village, report } = ok(
    parseExport(exportText([HALL, { data: IDS.archerTower, lvl: 0, timer: 600 }]), gd),
  );
  const tower = village.instances.find((i) => i.entityId === IDS.archerTower);
  assert.equal(tower?.level, 0);
  assert.equal(tower?.finishesAt, T0 + 600);
  assert.equal(report.warnings.length, 0);
});

// --- warnings -----------------------------------------------------------------------

function codes(text: string, options = {}) {
  return ok(parseExport(text, gd, options)).report.warnings.map((w) => w.code);
}

test("warns when a timer is longer than the level takes", () => {
  assert.deepEqual(codes(exportText([HALL, { data: IDS.cannon, lvl: 1, timer: 999_999 }])), [
    "timer_exceeds_level",
  ]);
});

test("warns and keeps the instance idle when a timer runs past the last level", () => {
  const text = exportText([
    { data: IDS.townHall, lvl: 3 },
    { data: IDS.cannon, lvl: 4, timer: 60 },
  ]);
  assert.deepEqual(codes(text), ["timer_past_max"]);
});

test("warns when a level is above the Town Hall cap", () => {
  assert.deepEqual(codes(exportText([HALL, { data: IDS.cannon, lvl: 4 }])), ["above_cap"]);
  assert.deepEqual(codes(exportText([HALL, { data: IDS.cannon, lvl: 3, timer: 60 }])), [
    "above_cap",
  ]);
});

test("gear-ups and supercharges are not treated as level upgrades", () => {
  const { village, report } = ok(
    parseExport(
      exportText([
        HALL,
        { data: IDS.cannon, lvl: 3, timer: 600, gear_up: 1 },
        { data: IDS.archerTower, lvl: 2, timer: 600, supercharge: 0 },
      ]),
      gd,
    ),
  );
  assert.equal(report.totals.upgrading, 0);
  assert.equal(report.totals.supercharges, 1);
  assert.deepEqual(report.warnings.map((w) => w.code).sort(), [
    "gear_up_ignored",
    "supercharge_excluded",
  ]);
  assert.ok(village.instances.every((i) => i.finishesAt === undefined));
});

test("warns about an old export only when the caller passes the time", () => {
  const text = exportText([HALL]);
  assert.deepEqual(codes(text), []);
  assert.deepEqual(codes(text, { now: T0 + 8 * 86400 }), ["stale_export"]);
  assert.deepEqual(codes(text, { now: T0 + 86400 }), []);
});

test("bad rows are reported and skipped", () => {
  assert.deepEqual(codes(exportText([HALL, { data: "x", lvl: 1 }, { lvl: 2 }])), [
    "bad_row",
    "bad_row",
  ]);
});

// --- failures ---------------------------------------------------------------------------

test("fails clearly on empty, non-JSON, wrong shape and missing Town Hall", () => {
  const code = (text: string) => {
    const result = parseExport(text, gd);
    assert.equal(result.ok, false);
    return result.ok ? "" : result.error.code;
  };
  assert.equal(code("   "), "empty");
  assert.equal(code("{ not json"), "not_json");
  assert.equal(code("[1, 2]"), "not_object");
  assert.equal(code(JSON.stringify({ timestamp: 1 })), "missing_field");
  assert.equal(code(JSON.stringify({ tag: "#A" })), "missing_field");
  assert.equal(code(exportText([{ data: IDS.cannon, lvl: 1 }])), "no_town_hall");
});
