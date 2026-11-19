export const GAMEDATA_PACKAGE = "@max-planner/gamedata";

export * from "./types.ts";
export { Checker, type Issue, type Result } from "./check.ts";
export {
  validateGameData,
  validateMagicItems,
  validateEvents,
  validateSeasons,
} from "./validate.ts";
export { createGameData, type GameData } from "./gamedata.ts";
