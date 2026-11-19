// What the parser does with each top-level key of the in-game export.
//
// Only `tag`, `timestamp`, `buildings`, `buildings2` and `helpers` are confirmed by a
// public write-up (ClashClock, "How it works"). The other section names follow what
// community tools describe and must be checked against real exports (LLD: confirm in M1).
// Any key not listed here is reported to the player rather than guessed at.

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
  traps: { use: "plan", confirmed: false },
  heroes: { use: "plan", confirmed: false },
  units: { use: "plan", confirmed: false },
  spells: { use: "plan", confirmed: false },
  siege_machines: { use: "plan", confirmed: false },
  pets: { use: "plan", confirmed: false },

  helpers: { use: "helpers", confirmed: true },

  buildings2: { use: "ignore", confirmed: true },
  traps2: { use: "ignore", confirmed: false },
  heroes2: { use: "ignore", confirmed: false },
  units2: { use: "ignore", confirmed: false },
  equipment: { use: "ignore", confirmed: false },
  decos: { use: "ignore", confirmed: false },
  obstacles: { use: "ignore", confirmed: false },
  skins: { use: "ignore", confirmed: false },
  sceneries: { use: "ignore", confirmed: false },
  house_parts: { use: "ignore", confirmed: false },
};

/** Top-level keys that are not sections. */
export const META_KEYS: ReadonlySet<string> = new Set(["tag", "timestamp"]);

/**
 * Row fields the parser understands. The gear-up and supercharge names are
 * placeholders until a real export confirms them; rows with other fields are
 * still parsed, and the unknown field names are listed in the import report.
 */
export const ROW_FIELDS = {
  id: "data",
  level: "lvl",
  count: "cnt",
  timer: "timer",
  helperCooldown: "helper_cooldown",
  gearUp: "gear_up",
  supercharge: "supercharge",
} as const;

export const KNOWN_ROW_FIELDS: ReadonlySet<string> = new Set(Object.values(ROW_FIELDS));
