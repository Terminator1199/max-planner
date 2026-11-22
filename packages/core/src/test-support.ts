// Shared helpers for tests. Not exported from the package.
import { readFileSync } from "node:fs";
import {
  createGameData,
  validateEvents,
  validateGameData,
  validateMagicItems,
  type Category,
  type GameEvent,
  type MagicItem,
  type GameData,
  type GameDataFile,
  type Lane,
} from "@max-planner/gamedata";
import { stepId, type RemainingWork, type Step } from "./calc/remaining.ts";
import type { Village } from "./types.ts";
import sample from "../../../fixtures/gamedata/sample.json" with { type: "json" };
import itemsFile from "@max-planner/gamedata/files/magic-items.json" with { type: "json" };
import eventsFile from "@max-planner/gamedata/files/events.json" with { type: "json" };

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

export const T0 = 1_795_000_000;

export interface FakeStep {
  entityId: number;
  instance?: number;
  toLevel?: number;
  seconds: number;
  cost?: number;
  lane?: Lane;
  category?: Category;
  after?: string[];
  blocksLane?: Lane;
  inProgress?: true;
}

/**
 * A hand-made step graph with its tails and lower bound, for scheduler tests. Steps
 * must be listed so that each comes after the steps it waits for.
 */
export function fakeWork(specs: FakeStep[], builders = 1): RemainingWork {
  const steps: Step[] = specs.map((f) => ({
    id: stepId(f.entityId, f.instance ?? 0, f.toLevel ?? 1),
    entityId: f.entityId,
    instance: f.instance ?? 0,
    toLevel: f.toLevel ?? 1,
    seconds: f.seconds,
    cost: f.cost ?? 0,
    resource: "gold",
    lane: f.lane ?? "builder",
    category: f.category ?? "defense",
    townHall: 1,
    after: f.after ?? [],
    ...(f.inProgress ? { inProgress: true as const } : {}),
    ...(f.blocksLane ? { blocksLane: f.blocksLane } : {}),
  }));
  const tail = new Map<string, number>();
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    let rest = 0;
    for (const q of steps) if (q.after.includes(s.id)) rest = Math.max(rest, tail.get(q.id)!);
    tail.set(s.id, s.seconds + rest);
  }
  const work = { builder: 0, lab: 0, petHouse: 0 };
  for (const s of steps) {
    work[s.lane] += s.seconds;
    if (s.blocksLane) work[s.blocksLane] += s.seconds;
  }
  const chain = Math.max(0, ...tail.values());
  const terms = {
    builders: Math.ceil(work.builder / builders),
    lab: work.lab,
    petHouse: work.petHouse,
    chain,
  };
  const seconds = Math.max(...Object.values(terms));
  const lowerBound = { seconds, bottleneck: "builders" as const, terms, builders, chainSteps: [] };
  return {
    currentTownHall: 1,
    targetTownHall: 1,
    steps,
    hallSteps: [],
    tail,
    totals: {
      seconds: work,
      steps: { builder: 0, lab: 0, petHouse: 0 },
      cost: { gold: 0, elixir: 0, darkElixir: 0 },
      byCategory: {},
      byHall: {},
      walls: { upgrades: 0, cost: { gold: 0, elixir: 0, darkElixir: 0 } },
    },
    lowerBound,
    hallBounds: [{ townHall: 1, lowerBound }],
    unplannable: [],
    notes: [],
  };
}

/** A village with `builders` huts and, unless told otherwise, a level 1 Laboratory. */
export function fakeVillage(builders: number, options: { lab?: boolean } = {}): Village {
  const instances = [];
  for (let i = 0; i < builders; i++)
    instances.push({ entityId: IDS.builderHut, index: i, level: 1 });
  if (options.lab !== false) instances.push({ entityId: IDS.laboratory, index: 0, level: 1 });
  return { tag: "#FAKE", exportedAt: T0, townHall: 1, builders, instances, walls: [], helpers: [] };
}

/** The magic items from packages/gamedata/files, validated. */
export function magicItems(): MagicItem[] {
  const result = validateMagicItems(itemsFile);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value.items;
}

/** The events from packages/gamedata/files, validated. */
export function gameEvents(): GameEvent[] {
  const result = validateEvents(eventsFile);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value.events;
}
