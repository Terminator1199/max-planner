// A small bundler for the preview: TypeScript modules in, one classic script out.
//
// Node strips the types (the code base uses only erasable syntax), acorn parses the
// result, and each module's imports and exports are rewritten into a registry of
// functions. The output runs from a single inline <script>, so the page works as a
// published artifact and when opened straight from disk, where browsers refuse to
// load module files.
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "acorn";
import type {
  ExportNamedDeclaration,
  ImportDeclaration,
  ModuleDeclaration,
  Program,
  Statement,
} from "acorn";

export interface BundleOptions {
  /** Repository root; workspace packages are found under packages/. */
  root: string;
  entry: string;
  /** Also put the entry module's exports on globalThis under this name (for tests). */
  globalName?: string;
}

export interface Bundle {
  code: string;
  /** Module paths relative to the root, in load order. */
  modules: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Resolves an import specifier the way Node and the workspace do. */
export function resolveSpecifier(root: string, from: string, spec: string): string {
  if (spec.startsWith(".")) return checked(resolve(dirname(from), spec), spec, from);
  const m = /^@max-planner\/([^/]+)(?:\/(.*))?$/.exec(spec);
  if (!m) throw new Error(`${rel(root, from)}: cannot bundle "${spec}" (only workspace packages).`);
  const pkgDir = join(root, "packages", m[1]!);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  const sub = m[2] ? `./${m[2]}` : ".";
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === sub) return checked(join(pkgDir, target), spec, from);
    if (key.endsWith("/*") && sub.startsWith(key.slice(0, -1))) {
      return checked(join(pkgDir, target.replace("*", sub.slice(key.length - 1))), spec, from);
    }
  }
  throw new Error(`${rel(root, from)}: "${spec}" is not exported by @max-planner/${m[1]}.`);
}

export function bundle({ root, entry, globalName }: BundleOptions): Bundle {
  const ids = new Map<string, number>();
  const bodies: string[] = [];
  const order: string[] = [];
  const visiting = new Set<string>();

  const load = (file: string, chain: string[]): number => {
    const known = ids.get(file);
    if (known !== undefined) return known;
    if (visiting.has(file)) {
      throw new Error(`Import cycle: ${[...chain, file].map((f) => rel(root, f)).join(" -> ")}`);
    }
    visiting.add(file);
    const source = readFileSync(file, "utf8");
    const body = file.endsWith(".json")
      ? `__e.default = ${JSON.stringify(JSON.parse(source))};`
      : transform(stripTypeScriptTypes(source, { mode: "strip" }), file, (spec) =>
          load(resolveSpecifier(root, file, spec), [...chain, file]),
        );
    visiting.delete(file);
    const id = bodies.length;
    ids.set(file, id);
    bodies.push(body);
    order.push(rel(root, file));
    return id;
  };

  const main = load(resolve(entry), []);
  const defs = bodies
    .map((b, i) => `/* ${order[i]} */\n${i}: function (__e, __r) {\n"use strict";\n${b}\n}`)
    .join(",\n");
  const code = `(() => {
const defs = {
${defs}
};
const cache = {};
const __r = (id) => {
  if (cache[id]) return cache[id];
  const e = (cache[id] = {});
  defs[id](e, __r);
  return e;
};
${globalName ? `globalThis[${JSON.stringify(globalName)}] = ` : ""}__r(${main});
})();
`;
  return { code, modules: order };
}

/**
 * Rewrites one module's top-level imports and exports. Exports become getters on the
 * module object, defined once the body has run; imports read them.
 */
function transform(code: string, file: string, dep: (spec: string) => number): string {
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" }) as Program;
  const edits: Edit[] = [];
  const getters: [string, string][] = [];
  let n = 0;
  const local = () => `__m${n++}`;

  for (const node of ast.body as (Statement | ModuleDeclaration)[]) {
    switch (node.type) {
      case "ImportDeclaration": {
        const id = dep(node.source.value as string);
        edits.push({ start: node.start, end: node.end, text: importText(node, id, local()) });
        break;
      }
      case "ExportNamedDeclaration": {
        edits.push(...exportNamed(node, dep, getters, local));
        break;
      }
      case "ExportAllDeclaration": {
        if (node.exported) throw new Error(`${file}: "export * as" is not supported.`);
        const id = dep(node.source.value as string);
        const m = local();
        edits.push({
          start: node.start,
          end: node.end,
          text: `const ${m} = __r(${id}); for (const k of Object.keys(${m})) if (k !== "default") Object.defineProperty(__e, k, { get: () => ${m}[k], enumerable: true });`,
        });
        break;
      }
      case "ExportDefaultDeclaration":
        throw new Error(`${file}: default exports are not supported; use a named export.`);
      default:
        break;
    }
  }
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  if (getters.length > 0) {
    out += `\nObject.defineProperties(__e, {${getters
      .map(([name, expr]) => `${JSON.stringify(name)}: { get: () => ${expr}, enumerable: true }`)
      .join(", ")}});`;
  }
  return out;
}

function importText(node: ImportDeclaration, id: number, m: string): string {
  const parts: string[] = [`const ${m} = __r(${id});`];
  for (const s of node.specifiers) {
    if (s.type === "ImportDefaultSpecifier") parts.push(`const ${s.local.name} = ${m}.default;`);
    else if (s.type === "ImportNamespaceSpecifier") parts.push(`const ${s.local.name} = ${m};`);
    else {
      const imported =
        s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value);
      // A copy is safe: import cycles are refused, so the dependency has finished running.
      parts.push(`const ${s.local.name} = ${m}[${JSON.stringify(imported)}];`);
    }
  }
  return parts.join(" ");
}

function exportNamed(
  node: ExportNamedDeclaration,
  dep: (spec: string) => number,
  getters: [string, string][],
  local: () => string,
): Edit[] {
  const name = (x: { type: string; name?: string; value?: unknown }) =>
    x.type === "Identifier" ? x.name! : String(x.value);
  if (node.source) {
    const id = dep(node.source.value as string);
    const m = local();
    for (const s of node.specifiers)
      getters.push([name(s.exported), `${m}[${JSON.stringify(name(s.local))}]`]);
    return [{ start: node.start, end: node.end, text: `const ${m} = __r(${id});` }];
  }
  if (node.declaration) {
    const d = node.declaration;
    if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") {
      getters.push([d.id!.name, d.id!.name]);
    } else {
      for (const v of d.declarations) {
        if (v.id.type !== "Identifier") throw new Error("Destructured exports are not supported.");
        getters.push([v.id.name, v.id.name]);
      }
    }
    return [{ start: node.start, end: d.start, text: "" }];
  }
  for (const s of node.specifiers) getters.push([name(s.exported), name(s.local)]);
  return [{ start: node.start, end: node.end, text: "" }];
}

function checked(path: string, spec: string, from: string): string {
  if (!existsSync(path))
    throw new Error(`${from}: "${spec}" resolves to ${path}, which does not exist.`);
  return path;
}

function rel(root: string, file: string): string {
  return relative(root, file).split("\\").join("/");
}
