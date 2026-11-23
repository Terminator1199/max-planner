import assert from "node:assert/strict";
import { test } from "node:test";
import { progress } from "../calc/progress.ts";
import { remainingWork } from "../calc/remaining.ts";
import { parseExport } from "../parser/parse.ts";
import { IDS, exportText, readFixture, sampleGameData } from "../test-support.ts";
import { compareVillages } from "./compare.ts";

const gd = sampleGameData();
const village = (text: string) => {
  const r = parseExport(text, gd, {});
  assert.ok(r.ok);
  return r.village;
};

test("the same village later: levels gained per building, walls and halls", () => {
  const before = village(
    exportText([
      { data: IDS.townHall, lvl: 2 },
      { data: IDS.cannon, lvl: 1, cnt: 2 },
      { data: IDS.wall, lvl: 1, cnt: 10 },
    ]),
  );
  const after = village(
    exportText([
      { data: IDS.townHall, lvl: 2 },
      { data: IDS.cannon, lvl: 3 },
      { data: IDS.cannon, lvl: 1, timer: 60 }, // the running upgrade counts as done
      { data: IDS.wall, lvl: 2, cnt: 4 },
      { data: IDS.wall, lvl: 1, cnt: 6 },
    ]),
  );
  const c = compareVillages(before, after, gd);
  assert.deepEqual(c.changes, [
    {
      entityId: IDS.cannon,
      name: "Cannon",
      category: "defense",
      a: [1, 1],
      b: [3, 2],
      levelsGained: 3,
    },
  ]);
  assert.equal(c.levelsGained, 3);
  assert.deepEqual(c.walls, { a: 10, b: 10, levelsGained: 4 });
});

test("progress weighs time already in the village against time left", () => {
  const v = village(readFixture("synthetic-th2.json"));
  const work = remainingWork(v, gd);
  const p = progress(v, gd, work);
  assert.ok(p.fraction > 0 && p.fraction < 1);
  assert.equal(
    p.leftSeconds,
    work.totals.seconds.builder + work.totals.seconds.lab + work.totals.seconds.petHouse,
  );
  assert.equal(p.doneSeconds / (p.doneSeconds + p.leftSeconds), p.fraction);
});
