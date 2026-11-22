import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as direct from "@max-planner/core";
import { T0, readFixture, sampleGameData } from "../../../packages/core/src/test-support.ts";
import { bundle } from "./bundle.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Runs a bundle and returns what it put on globalThis under `name`. */
function run<T>(code: string, name: string): T {
  new Function(code)();
  const value = (globalThis as Record<string, unknown>)[name] as T;
  delete (globalThis as Record<string, unknown>)[name];
  return value;
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("every import and export form the code base uses survives bundling", () => {
  const dir = project({
    "a.ts": `
      import { double, type Shape } from "./b.ts";
      import data from "./data.json" with { type: "json" };
      import * as all from "./c.ts";
      export { triple as thrice } from "./c.ts";
      export * from "./d.ts";
      const local = 1;
      export { local as one };
      export const answer: number = double(data.n);
      export class Box { size: number = all.triple(2); }
      export function shape(): Shape { return { sides: 4 }; }
    `,
    "b.ts": `export interface Shape { sides: number }\nexport function double(x: number) { return x * 2; }`,
    "c.ts": `export function triple(x: number): number { return x * 3; }`,
    "d.ts": `export const fromD = "d";\nexport type Unused = string;`,
    "data.json": `{ "n": 21 }`,
  });
  const out = bundle({ root: dir, entry: join(dir, "a.ts"), globalName: "t1" });
  assert.deepEqual(out.modules, ["b.ts", "data.json", "c.ts", "d.ts", "a.ts"]);
  const m = run<Record<string, unknown>>(out.code, "t1");
  assert.equal(m.answer, 42);
  assert.equal((m.thrice as (x: number) => number)(3), 9);
  assert.equal(m.fromD, "d");
  assert.equal(m.one, 1);
  assert.equal(new (m.Box as new () => { size: number })().size, 6);
  assert.deepEqual((m.shape as () => unknown)(), { sides: 4 });
});

test("cycles, default exports and outside packages are refused clearly", () => {
  const cyc = project({
    "a.ts": `import { b } from "./b.ts"; export const a = b;`,
    "b.ts": `import { a } from "./a.ts"; export const b = 1;`,
  });
  assert.throws(
    () => bundle({ root: cyc, entry: join(cyc, "a.ts") }),
    /Import cycle: a\.ts -> b\.ts -> a\.ts/,
  );
  const def = project({ "a.ts": `export default 1;` });
  assert.throws(() => bundle({ root: def, entry: join(def, "a.ts") }), /default exports/);
  const npm = project({ "a.ts": `import x from "left-pad"; export const y = x;` });
  assert.throws(() => bundle({ root: npm, entry: join(npm, "a.ts") }), /only workspace packages/);
});

test("the bundled planner gives the same plan as the source", () => {
  const out = bundle({ root, entry: join(root, "packages/core/src/index.ts"), globalName: "core" });
  const core = run<typeof direct>(out.code, "core");
  const gd = sampleGameData();
  const text = readFixture("synthetic-th2.json");
  const plan = (lib: typeof direct) => {
    const parsed = lib.parseExport(text, gd, { now: T0 });
    assert.ok(parsed.ok);
    const work = lib.remainingWork(parsed.village, gd, { targetTownHall: 3 });
    return lib.searchPlan(work, parsed.village, gd, { seed: 1, variants: 8 });
  };
  assert.equal(plan(core).hash, plan(direct).hash);
  assert.equal(core.sha256("abc"), direct.sha256("abc"));
});

test("the preview page bundles", () => {
  const out = bundle({ root, entry: join(root, "apps/preview/src/main.ts") });
  assert.ok(out.modules.includes("apps/preview/src/demo.ts"));
  assert.ok(out.modules.includes("packages/core/src/sched/simulate.ts"));
  assert.doesNotMatch(
    out.code,
    /^\s*(import|export)\s[^\n]*\sfrom\s/m,
    "an import or export was left",
  );
});
