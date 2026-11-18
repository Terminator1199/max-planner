import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_PACKAGE, DEPENDS_ON } from "./index.ts";

test("core package resolves its workspace dependency", () => {
  assert.equal(CORE_PACKAGE, "@max-planner/core");
  assert.deepEqual(DEPENDS_ON, ["@max-planner/gamedata"]);
});
