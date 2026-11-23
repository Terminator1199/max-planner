// Builds packages/gamedata/files/gamedata.json from the pinned ClashKing snapshot.
//   pnpm gamedata:build
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGameData } from "@max-planner/gamedata";
import { fetchSource } from "./fetch.ts";
import { normalise } from "./normalise.ts";
import { SOURCE } from "./source.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ck = fetchSource(join(root, "tools/gamedata-build/cache"));
const { file, skipped } = normalise(ck, {
  version: `${SOURCE.date}.${SOURCE.commit.slice(0, 7)}`,
  generatedAt: `${SOURCE.date}T00:00:00Z`,
  sources: {
    clashking: `${SOURCE.repo}/tree/${SOURCE.commit}/${SOURCE.dir}`,
    license: `${SOURCE.license}; see packages/gamedata/files/COPYING.gamedata`,
  },
});
const result = validateGameData(file);
if (!result.ok) {
  console.error(JSON.stringify(result.errors, null, 2));
  process.exit(1);
}
// One entity per line keeps diffs between snapshots readable.
const lines = [
  "{",
  `  "version": ${JSON.stringify(file.version)},`,
  `  "generatedAt": ${JSON.stringify(file.generatedAt)},`,
  `  "sources": ${JSON.stringify(file.sources)},`,
  `  "entities": [`,
  file.entities.map((e) => `    ${JSON.stringify(e)}`).join(",\n"),
  "  ],",
  `  "townHalls": [`,
  file.townHalls.map((t) => `    ${JSON.stringify(t)}`).join(",\n"),
  "  ],",
  `  "storage": []`,
  "}",
  "",
];
const out = join(root, "packages/gamedata/files/gamedata.json");
writeFileSync(out, lines.join("\n"));
const warn = result.warnings.length;
console.log(
  `gamedata.json: ${file.entities.length} entities, ${file.townHalls.length} halls, ${skipped.length} left out, ${warn} warning${warn === 1 ? "" : "s"}`,
);
for (const w of result.warnings) console.log(`  warning ${w.path}: ${w.message}`);
