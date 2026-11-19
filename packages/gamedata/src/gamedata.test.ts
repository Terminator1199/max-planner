import { test } from "node:test";
import assert from "node:assert/strict";
import sample from "../../../fixtures/gamedata/sample.json" with { type: "json" };
import { createGameData } from "./gamedata.ts";
import type { GameDataFile } from "./types.ts";
import { validateGameData } from "./validate.ts";

const CANNON = 9000010;
const ARCHER_TOWER = 9000011;
const GOLD_STORAGE = 9000003;

function load() {
  const result = validateGameData(sample);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.errors));
  return createGameData(result.value);
}

test("the synthetic sample validates and is flagged synthetic", () => {
  const gd = load();
  assert.equal(gd.synthetic, true);
  assert.equal(gd.maxTownHall, 3);
});

test("roles find special buildings without hard-coded ids", () => {
  const gd = load();
  assert.equal(gd.byRole("townHall")?.name, "Town Hall");
  assert.equal(gd.byRole("builderHut")?.name, "Builder's Hut");
  assert.equal(gd.byRole("petHouse"), undefined);
});

test("capAt is the highest level whose Town Hall requirement is met", () => {
  const gd = load();
  assert.equal(gd.capAt(CANNON, 1), 2);
  assert.equal(gd.capAt(CANNON, 2), 3);
  assert.equal(gd.capAt(CANNON, 3), 4);
  assert.equal(gd.capAt(ARCHER_TOWER, 1), 0, "not available at Town Hall 1");
  assert.equal(gd.capAt(123, 3), 0, "unknown entity");
});

test("countAt reads the hall table and clamps above the highest hall", () => {
  const gd = load();
  assert.equal(gd.countAt(ARCHER_TOWER, 1), 0);
  assert.equal(gd.countAt(ARCHER_TOWER, 2), 1);
  assert.equal(gd.countAt(ARCHER_TOWER, 3), 2);
  assert.equal(gd.countAt(ARCHER_TOWER, 9), 2);
});

test("level rows, max level and gates", () => {
  const gd = load();
  assert.equal(gd.level(CANNON, 3)?.seconds, 7200);
  assert.equal(gd.level(CANNON, 5), undefined);
  assert.equal(gd.maxLevel(CANNON), 4);
  assert.deepEqual(gd.gateAt(1), [{ entityId: CANNON, level: 2 }]);
  assert.deepEqual(gd.gateAt(3), []);
});

test("storageCapacity sums every instance", () => {
  const gd = load();
  const capacity = gd.storageCapacity("gold", [
    { entityId: GOLD_STORAGE, level: 1 },
    { entityId: GOLD_STORAGE, level: 3 },
  ]);
  assert.equal(capacity, 21500);
  assert.equal(gd.storageCapacity("darkElixir", [{ entityId: GOLD_STORAGE, level: 3 }]), 0);
});

// --- validator failures -----------------------------------------------------

function broken(change: (file: GameDataFile) => void): string[] {
  const copy = structuredClone(sample) as unknown as GameDataFile;
  change(copy);
  const result = validateGameData(copy);
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

function entity(file: GameDataFile, id: number) {
  const found = file.entities.find((e) => e.id === id);
  assert.ok(found);
  return found;
}

test("rejects a gap in levels", () => {
  const errors = broken((f) => entity(f, CANNON).levels.splice(1, 1));
  assert.ok(
    errors.some((e) => e.includes("without gaps")),
    errors.join("\n"),
  );
});

test("rejects a Town Hall requirement that falls as levels rise", () => {
  const errors = broken((f) => {
    entity(f, CANNON).levels[3]!.townHall = 1;
  });
  assert.ok(
    errors.some((e) => e.includes("must not fall")),
    errors.join("\n"),
  );
});

test("rejects a wall with a worker lane and a building without one", () => {
  const errors = broken((f) => {
    entity(f, 9000050).lane = "builder";
    entity(f, CANNON).lane = null;
  });
  assert.ok(
    errors.some((e) => e.includes("walls take no worker time")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.includes("only walls may have a null lane")),
    errors.join("\n"),
  );
});

test("rejects duplicate ids", () => {
  const errors = broken((f) => {
    entity(f, ARCHER_TOWER).id = CANNON;
  });
  assert.ok(
    errors.some((e) => e.includes("duplicate entity id")),
    errors.join("\n"),
  );
});

test("rejects unknown references, levels past the end and a missing Town Hall", () => {
  const errors = broken((f) => {
    f.townHalls[0]!.counts["123"] = 1;
    f.townHalls[0]!.gate = [{ entityId: CANNON, level: 9 }];
    delete entity(f, 9000001).role;
  });
  assert.ok(
    errors.some((e) => e.includes("counts.123: unknown entity id")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.includes("has only 4 levels")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((e) => e.includes("no entity has role townHall")),
    errors.join("\n"),
  );
});

test("warns, without failing, when a count falls between halls", () => {
  const copy = structuredClone(sample) as unknown as GameDataFile;
  copy.townHalls[2]!.counts[String(CANNON)] = 1;
  const result = validateGameData(copy);
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
});
