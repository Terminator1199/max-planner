// Builds dist/preview/index.html: the page template with the whole app inlined.
//   pnpm preview:build
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(root, "dist", "preview");
const { code, modules } = bundle({ root, entry: join(root, "apps/preview/src/main.ts") });
const template = readFileSync(join(root, "apps/preview/index.html"), "utf8");
if (!template.includes("<!-- bundle -->"))
  throw new Error("index.html lost its <!-- bundle --> marker.");
// Inside an inline script, "</script" would end it early.
const inline = code.replace(/<\/script/gi, "<\\/script");
mkdirSync(outDir, { recursive: true });
const html = template.replace("<!-- bundle -->", () => `<script>\n${inline}</script>`);
writeFileSync(join(outDir, "index.html"), html);
console.log(
  `dist/preview/index.html: ${modules.length} modules, ${Math.round(html.length / 1024)} KB`,
);
