// Where the game data comes from. Bump COMMIT to take a newer ClashKing snapshot, then
// run `pnpm gamedata:build` and review the diff of packages/gamedata/files/gamedata.json.
export const SOURCE = {
  name: "ClashKing static data",
  repo: "https://github.com/ClashKingInc/ClashKingAssets",
  /** 16 November 2026, the day of the Town Hall 19 update. */
  commit: "6da8ce864afe2b4510d3342e1c7374e48d7f5a49",
  date: "2026-11-16",
  dir: "assets/static_data",
  license: "GPL-3.0",
  files: ["buildings", "traps", "troops", "spells", "heroes", "pets"] as const,
};

export type SourceFile = (typeof SOURCE.files)[number];
