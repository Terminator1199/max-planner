// The data every plan needs, built once from the four data files. The page builds it
// from the files it bundles; the worker builds it from the copy the page sends.
import {
  createGameData,
  validateEvents,
  validateGameData,
  validateMagicItems,
  validateSeasons,
  type GameData,
  type GameDataFile,
  type GameEvent,
  type MagicItem,
  type SeasonsFile,
} from "@max-planner/gamedata";

export interface Files {
  gamedata: unknown;
  items: unknown;
  events: unknown;
  seasons: unknown;
}

export interface Context {
  gd: GameData;
  items: MagicItem[];
  events: GameEvent[];
  seasons: SeasonsFile;
}

function must<T>(name: string, r: { ok: true; value: T } | { ok: false; errors: unknown }): T {
  if (!r.ok) throw new Error(`${name} is invalid: ${JSON.stringify(r.errors)}`);
  return r.value;
}

export function makeContext(files: Files): Context {
  const gd = createGameData(
    must("gamedata.json", validateGameData(files.gamedata as GameDataFile)),
  );
  const items = must("magic-items.json", validateMagicItems(files.items)).items;
  const events = must("events.json", validateEvents(files.events)).events;
  const seasons = must(
    "seasons.json",
    validateSeasons(files.seasons, new Set(items.map((i) => i.id))),
  );
  return { gd, items, events, seasons };
}
