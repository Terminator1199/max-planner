// Builds dist/web/index.html: the page template with the app and its planner worker
// inlined, so the whole site is one self-contained file.
//   pnpm web:build
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(root, "dist", "web");
const app = bundle({ root, entry: join(root, "apps/web/src/main.ts") });
const worker = bundle({ root, entry: join(root, "apps/web/src/worker.ts") });
const template = readFileSync(join(root, "apps/web/index.html"), "utf8");
for (const marker of ["<!-- worker -->", "<!-- bundle -->"]) {
  if (!template.includes(marker)) throw new Error(`index.html lost its ${marker} marker.`);
}
// Inside an inline script, "</script" would end it early.
const inline = (code: string) => code.replace(/<\/script/gi, "<\\/script");
const html = template
  // The page starts the worker from this text through a blob: URL.
  .replace(
    "<!-- worker -->",
    () => `<script type="text/plain" id="worker-src">\n${inline(worker.code)}</script>`,
  )
  .replace("<!-- bundle -->", () => `<script>\n${inline(app.code)}</script>`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), html);
console.log(
  `dist/web/index.html: ${app.modules.length} + ${worker.modules.length} modules, ${Math.round(html.length / 1024)} KB`,
);
