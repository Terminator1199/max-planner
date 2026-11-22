// Shared helpers for tests. Not exported from the package.
import { readFileSync } from "node:fs";
import {
  createGameData,
  validateGameData,
  type GameData,
  type GameDataFile,
} from "@max-planner/gamedata";
import sample from "../../../fixtures/gamedata/sample.json" with { type: "json" };

export const IDS = {
  townHall: 9000001,
  builderHut: 9000002,
  goldStorage: 9000003,
  elixirStorage: 9000004,
  laboratory: 9000005,
  cannon: 9000010,
  archerTower: 9000011,
  bomb: 9000012,
  armyCamp: 9000020,
  barbarian: 9000030,
  lightning: 9000031,
  king: 9000040,
  wall: 9000050,
} as const;

/** The sample game data, optionally changed first by `patch` (on a copy). */
export function sampleGameData(patch?: (file: GameDataFile) => void): GameData {
  const file = structuredClone(sample) as GameDataFile;
  patch?.(file);
  const result = validateGameData(file);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return createGameData(result.value);
}

export function readFixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/exports/${name}`, import.meta.url), "utf8");
}

/** Builds export text from a list of `buildings` rows plus optional extra sections. */
export function exportText(
  buildings: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  timestamp = 1_795_000_000,
): string {
  return JSON.stringify({ tag: "#TEST", timestamp, buildings, ...extra });
}
