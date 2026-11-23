// Pinned numbers: hand-checked rows of the built game data, so a wrong conversion or a
// changed source cannot pass silently (LLD, "Validation checks"). Values were read from
// ClashKing's raw files at the pinned commit and from real exports.
import assert from "node:assert/strict";
import { test } from "node:test";
import real from "../files/gamedata.json" with { type: "json" };
import { createGameData } from "./gamedata.ts";
import type { GameDataFile } from "./types.ts";
import { validateGameData } from "./validate.ts";

const result = validateGameData(real as GameDataFile);

test("the built game data validates, with only the merge count warnings", () => {
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  assert.ok(
    result.warnings.every((w) => /count falls/.test(w.message)),
    JSON.stringify(result.warnings),
  );
});

test("pinned rows match ClashKing's raw values", () => {
  assert.ok(result.ok);
  const gd = createGameData(result.value);
  assert.equal(gd.maxTownHall, 19);
  // Town Hall 19: 27M gold, 13 days, after Town Hall 18.
  assert.deepEqual(gd.level(1000001, 19), {
    level: 19,
    cost: 27_000_000,
    resource: "gold",
    seconds: 1_123_200,
    townHall: 19,
  });
  // Cannon 21: 3M gold, 1 day 12 hours, Town Hall 15.
  assert.deepEqual(gd.level(1000008, 21), {
    level: 21,
    cost: 3_000_000,
    resource: "gold",
    seconds: 129_600,
    townHall: 15,
  });
  // Barbarian 14: 30M elixir, 13.5 days, Town Hall 19 and Laboratory 17.
  assert.deepEqual(gd.level(4000000, 14), {
    level: 14,
    cost: 30_000_000,
    resource: "elixir",
    seconds: 1_166_400,
    townHall: 19,
  });
  assert.ok(
    gd
      .entity(4000000)!
      .requires!.some((r) => r.entityId === 1000007 && r.level === 17 && r.forLevel === 14),
  );
  // Barbarian King 2: 5,000 dark elixir, 2 hours, Town Hall 7 and Hero Hall 1.
  assert.deepEqual(gd.level(28000000, 2), {
    level: 2,
    cost: 5000,
    resource: "darkElixir",
    seconds: 7200,
    townHall: 7,
  });
  assert.equal(gd.maxLevel(28000000), 115);
  // Multi-Archer Tower: merges two level 21 Archer Towers at Town Hall 16.
  assert.deepEqual(gd.entity(1000084)!.mergeOf, [{ entityId: 1000009, level: 21, count: 2 }]);
  // L.A.S.S.I 2: 20,000 dark elixir, 1 day, Pet House 1.
  assert.deepEqual(gd.level(73000000, 2), {
    level: 2,
    cost: 20_000,
    resource: "darkElixir",
    seconds: 86_400,
    townHall: 14,
  });
});

test("counts after merges match what Town Hall 18 players have", () => {
  assert.ok(result.ok);
  const gd = createGameData(result.value);
  const at18 = (id: number) => gd.countAt(id, 18);
  // Three public Town Hall 18 exports agree on every one of these.
  assert.deepEqual(
    [1000008, 1000009, 1000011, 1000067, 1000031, 1000084, 1000085, 1000079, 1000102].map(at18),
    [0, 2, 2, 2, 0, 3, 3, 1, 2],
  );
  assert.equal(gd.countAt(1000015, 1), 5); // Builder's Huts
  assert.equal(gd.byRole("extraBuilder")?.name, "B.O.B's Hut");
  assert.deepEqual(gd.gateAt(16), [{ entityId: 1000031, level: 7 }]); // Eagle into Town Hall 17
});
