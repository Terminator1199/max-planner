import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mulberry32 } from "../sched/prng.ts";
import { sha256 } from "./sha256.ts";

const node = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("known answers from FIPS 180-4", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("matches node:crypto across block boundaries and non-ASCII text", () => {
  const rng = mulberry32(7);
  for (const n of [55, 56, 63, 64, 65, 119, 120, 1000, 10_000]) {
    let text = "";
    for (let i = 0; i < n; i++) text += String.fromCharCode(32 + rng.int(0, 94));
    assert.equal(sha256(text), node(text), `length ${n}`);
  }
  assert.equal(sha256("Town Hall ✓ — ₹ 🏰"), node("Town Hall ✓ — ₹ 🏰"));
});
