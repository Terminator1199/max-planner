import assert from "node:assert/strict";
import { test } from "node:test";
import { createGameData, validateGameData } from "@max-planner/gamedata";
import { normalise, type CkFiles, type CkItem } from "./normalise.ts";

// A small file in ClashKing's shape (made up, not copied), covering each convention.
const hall: CkItem = {
  _id: 1000001,
  name: "Town Hall",
  type: "Town Hall",
  village: "home",
  upgrade_resource: "Gold",
  levels: [
    {
      level: 1,
      build_cost: 0,
      build_time: 0,
      required_townhall: 0,
      unlocks: [
        { _id: 1000008, name: "Cannon", quantity: 2 },
        { _id: 1000015, name: "Builder's Hut", quantity: 5 },
        { _id: 1000064, name: "B.O.B's Hut", quantity: 1 },
        { _id: 1000007, name: "Laboratory", quantity: 1 },
        { _id: 1000097, name: "Crafting Station", quantity: 1 },
      ],
    },
    {
      level: 2,
      build_cost: 1000,
      build_time: 600,
      required_townhall: 1,
      unlocks: [
        { _id: 1000008, name: "Cannon", quantity: 1 },
        { _id: 1000010, name: "Wall", quantity: 25 },
        { _id: 1000031, name: "Eagle Artillery", quantity: 1 },
      ],
    },
    {
      level: 3,
      build_cost: 5000,
      build_time: 3600,
      required_townhall: 2,
      unlocks: [{ _id: 1000085, name: "Twin Cannon", quantity: 1 }],
      merge_requirement: [{ _id: 1000031, name: "Eagle Artillery", level: 1 }],
    },
  ],
};
const building = (
  id: number,
  name: string,
  type: string,
  resource: string,
  levels: [number, number, number][],
): CkItem => ({
  _id: id,
  name,
  type,
  village: "home",
  upgrade_resource: resource,
  levels: levels.map(([cost, time, th], i) => ({
    level: i + 1,
    build_cost: cost,
    build_time: time,
    required_townhall: th,
  })),
});
const twin = building(1000085, "Twin Cannon", "Defense", "Gold", [[2000, 900, 3]]);
twin.levels[0]!.merge_requirement = [
  { _id: 1000008, name: "Cannon", level: 2 },
  { _id: 1000008, name: "Cannon", level: 2 },
];
const ck: CkFiles = {
  buildings: [
    hall,
    building(1000007, "Laboratory", "Army", "Elixir", [
      [100, 60, 1],
      [500, 600, 2],
    ]),
    building(1000008, "Cannon", "Defense", "Gold", [
      [250, 10, 1],
      [1000, 300, 2],
      [3000, 900, 1],
    ]),
    building(1000010, "Wall", "Wall", "Gold", [[50, 0, 2]]),
    building(1000015, "Builder's Hut", "Worker", "Gems", [[0, 0, 1]]),
    building(1000031, "Eagle Artillery", "Defense", "Gold", [[4000, 1200, 2]]),
    building(1000064, "B.O.B's Hut", "Worker2", "Gold", [[0, 0, 1]]),
    building(1000097, "Crafting Station", "Defense", "Gold", [[0, 0, 3]]),
    building(1000006, "Barracks", "Army", "Elixir", [[100, 60, 1]]),
    twin,
    {
      ...building(1000033, "Builder Hall", "BB Builder Hall", "Builder Gold", [[0, 0, 1]]),
      village: "builderBase",
    },
  ],
  traps: [],
  troops: [
    {
      _id: 4000000,
      name: "Barbarian",
      village: "home",
      upgrade_resource: "Elixir",
      production_building: "Barracks",
      production_building_level: 1,
      levels: [
        {
          level: 1,
          upgrade_cost: 100,
          upgrade_time: 60,
          required_townhall: 1,
          required_lab_level: null,
        },
        {
          level: 2,
          upgrade_cost: 400,
          upgrade_time: 600,
          required_townhall: 2,
          required_lab_level: 1,
        },
        { level: 3, upgrade_cost: 0, upgrade_time: 0, required_townhall: 3, required_lab_level: 2 },
      ],
    },
    {
      _id: 4000026,
      name: "Super Barbarian",
      village: "home",
      upgrade_resource: "Elixir",
      production_building: "Barracks",
      production_building_level: 1,
      levels: [{ level: 1, upgrade_cost: 0, upgrade_time: 0, required_townhall: 3 }],
    },
    {
      _id: 4000195,
      name: "Barch Squad",
      village: "home",
      upgrade_resource: "Elixir",
      production_building: "Squad Barracks",
      production_building_level: 1,
      levels: [
        { level: 1, upgrade_cost: 10, upgrade_time: 10, required_townhall: 1 },
        { level: 2, upgrade_cost: 0, upgrade_time: 0, required_townhall: 1 },
      ],
    },
  ],
  spells: [],
  heroes: [],
  pets: [],
};

const meta = { version: "test", generatedAt: "2026-11-16T00:00:00Z", sources: { test: "made up" } };

test("buildings keep their reach-this-level costs; gems cost nothing", () => {
  const { file } = normalise(ck, meta);
  const cannon = file.entities.find((e) => e.id === 1000008)!;
  assert.deepEqual(cannon.levels[1], {
    level: 2,
    cost: 1000,
    resource: "gold",
    seconds: 300,
    townHall: 2,
  });
  // A Town Hall requirement never falls as levels rise.
  assert.equal(cannon.levels[2]!.townHall, 2);
  const hut = file.entities.find((e) => e.id === 1000015)!;
  assert.equal(hut.role, "builderHut");
  assert.equal(hut.levels[0]!.cost, 0);
  // The Town Hall's own levels are reached at that hall.
  assert.deepEqual(
    file.entities.find((e) => e.id === 1000001)!.levels.map((l) => l.townHall),
    [1, 2, 3],
  );
});

test("research costs shift one level down: a level's price is paid to reach the next", () => {
  const { file } = normalise(ck, meta);
  const barb = file.entities.find((e) => e.id === 4000000)!;
  assert.equal(barb.lane, "lab");
  assert.deepEqual(
    barb.levels.map((l) => [l.level, l.cost, l.seconds, l.townHall]),
    [
      [1, 0, 0, 1],
      [2, 100, 60, 2],
      [3, 400, 600, 3],
    ],
  );
  assert.deepEqual(barb.requires, [
    { entityId: 1000007, level: 1, forLevel: 2 },
    { entityId: 1000007, level: 2, forLevel: 3 },
    { entityId: 1000006, level: 1, forLevel: 1 },
  ]);
});

test("counts add up per hall; merges and hall upgrades consume their sources", () => {
  const { file } = normalise(ck, meta);
  const count = (id: number) => file.townHalls.map((t) => t.counts[String(id)] ?? 0);
  assert.deepEqual(count(1000008), [2, 3, 1]); // the Twin Cannon takes two at hall 3
  assert.deepEqual(count(1000085), [0, 0, 1]);
  assert.deepEqual(count(1000010), [0, 25, 25]);
  assert.deepEqual(count(1000031), [0, 1, 0]); // the hall 3 upgrade consumes it
  assert.deepEqual(file.townHalls[1]!.gate, [{ entityId: 1000031, level: 1 }]);
  assert.deepEqual(file.entities.find((e) => e.id === 1000085)!.mergeOf, [
    { entityId: 1000008, level: 2, count: 2 },
  ]);
  // B.O.B's Hut adds a builder but is never built at home.
  assert.equal(file.entities.find((e) => e.id === 1000064)!.role, "extraBuilder");
  assert.deepEqual(count(1000064), [0, 0, 0]);
});

test("left out: Builder Base, crafted modules and super troops", () => {
  const { file, skipped } = normalise(ck, meta);
  const ids = new Set(file.entities.map((e) => e.id));
  for (const id of [1000033, 1000097, 4000026]) assert.ok(!ids.has(id), `${id} should be left out`);
  assert.deepEqual(skipped.map((s) => s.id).sort(), [1000097, 4000026]);
});

test("squads are researched in the Laboratory like troops", () => {
  const { file } = normalise(ck, meta);
  const squad = file.entities.find((e) => e.id === 4000195)!;
  assert.equal(squad.lane, "lab");
  assert.equal(squad.category, "troop");
  // Costs shift one level: level 2 costs what the source lists on level 1.
  assert.deepEqual(
    squad.levels.map((l) => [l.level, l.cost, l.seconds]),
    [
      [1, 0, 0],
      [2, 10, 10],
    ],
  );
});

test("the result validates and loads", () => {
  const { file } = normalise(ck, meta);
  const result = validateGameData(file);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  const gd = createGameData(result.value);
  assert.equal(gd.maxTownHall, 3);
  assert.equal(gd.byRole("extraBuilder")?.id, 1000064);
});
