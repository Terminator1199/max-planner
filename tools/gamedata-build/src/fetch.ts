// Fetches the pinned ClashKing commit's static data into a local cache with git, which
// reaches GitHub from CI and from a developer machine alike.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CkFiles, CkItem } from "./normalise.ts";
import { SOURCE } from "./source.ts";

export function fetchSource(cacheRoot: string): CkFiles {
  const dir = join(cacheRoot, SOURCE.commit);
  const data = join(dir, SOURCE.dir);
  if (!existsSync(data)) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    execFileSync("mkdir", ["-p", dir]);
    git("init", "-q");
    git("remote", "add", "origin", SOURCE.repo);
    git("config", "core.sparseCheckout", "true");
    git("sparse-checkout", "set", SOURCE.dir);
    git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", SOURCE.commit);
    git("checkout", "-q", "FETCH_HEAD");
  }
  const read = (name: string): CkItem[] => {
    const json = JSON.parse(readFileSync(join(data, `${name}.json`), "utf8")) as {
      items?: CkItem[];
    };
    if (!Array.isArray(json.items)) throw new Error(`${name}.json has no items list.`);
    return json.items;
  };
  return Object.fromEntries(SOURCE.files.map((f) => [f, read(f)])) as CkFiles;
}
