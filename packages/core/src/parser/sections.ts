// What the parser does with each top-level key of the in-game export.
//
// Checked against nine exports that players and tool makers posted publicly on GitHub:
// Town Hall 8 to 18, from October 2025 to November 2026. docs/export-format.md has the
// details. Any key not listed here is still reported to the player, not guessed at.

export type SectionUse =
  /** Rows become instances and walls for planning (Home Village). */
  | "plan"
  /** Rows describe the Builder's Apprentice, Lab Assistant and similar helpers. */
  | "helpers"
  /** Known but outside v1: Builder Base, cosmetics, obstacles, hero equipment. */
  | "ignore";

export interface SectionInfo {
  use: SectionUse;
  confirmed: boolean;
}

export const SECTIONS: Readonly<Record<string, SectionInfo>> = {
  buildings: { use: "plan", confirmed: true },
  traps: { use: "plan", confirmed: true },
  heroes: { use: "plan", confirmed: true },
  units: { use: "plan", confirmed: true },
  spells: { use: "plan", confirmed: true },
  siege_machines: { use: "plan", confirmed: true },
  pets: { use: "plan", confirmed: true },

  helpers: { use: "helpers", confirmed: true },

  // Town Hall 18 and up. Upgradeable, with timers, but not in the game data yet.
  guardians: { use: "ignore", confirmed: true },
  // Active potions (lab_boost, builder_boost: seconds left) and the Clock Tower cooldown.
  // An object, not a list; the scheduler could start from these later.
  boosts: { use: "ignore", confirmed: true },
  equipment: { use: "ignore", confirmed: true },
  decos: { use: "ignore", confirmed: true },
  obstacles: { use: "ignore", confirmed: true },
  // Lists of ids, not rows.
  skins: { use: "ignore", confirmed: true },
  sceneries: { use: "ignore", confirmed: true },
  house_parts: { use: "ignore", confirmed: true },

  buildings2: { use: "ignore", confirmed: true },
  traps2: { use: "ignore", confirmed: true },
  heroes2: { use: "ignore", confirmed: true },
  units2: { use: "ignore", confirmed: true },
  decos2: { use: "ignore", confirmed: true },
  obstacles2: { use: "ignore", confirmed: true },
  skins2: { use: "ignore", confirmed: true },
  sceneries2: { use: "ignore", confirmed: true },
};

/** Top-level keys that are not sections. */
export const META_KEYS: ReadonlySet<string> = new Set(["tag", "timestamp"]);

/** Row fields the parser understands, all seen in real exports. */
export const ROW_FIELDS = {
  id: "data",
  level: "lvl",
  count: "cnt",
  /** Seconds until the running upgrade to the next level ends. */
  timer: "timer",
  helperCooldown: "helper_cooldown",
  /** A Master Builder gear-up; its timer is not a level upgrade. */
  gearUp: "gear_up",
  /** Supercharge tiers done; a timer on the row belongs to the next tier. */
  supercharge: "supercharge",
  /** The Town Hall's weapon level. Not planned yet. */
  weapon: "weapon",
  /** Crafted defense modules; such rows have no level. Not planned yet. */
  types: "types",
  /** A second upgrade running at once in a lane, such as a second research. */
  extra: "extra",
  /** The helper is assigned to this upgrade and returns to it each cycle. */
  helperRecurrent: "helper_recurrent",
  helperTimer: "helper_timer",
} as const;

export const KNOWN_ROW_FIELDS: ReadonlySet<string> = new Set(Object.values(ROW_FIELDS));
