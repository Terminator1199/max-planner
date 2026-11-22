import type { Category } from "@max-planner/gamedata";

export type Strategy = "offense" | "balanced" | "defense";

export const STRATEGIES: readonly Strategy[] = ["offense", "balanced", "defense"];

/**
 * How much a strategy values finishing a step of each category early. These are the
 * LLD's starting weights, to be tuned against real fixtures. Research and pets share
 * one weight; a priority list orders them instead (see `labPriority`).
 */
export const WEIGHTS: Readonly<Record<Strategy, Readonly<Record<Category, number>>>> = {
  offense: {
    hero: 3.0,
    army: 2.5,
    defense: 1.0,
    resource: 0.8,
    storage: 0.8,
    trap: 0.5,
    other: 0.5,
    troop: 1.0,
    spell: 1.0,
    siege: 1.0,
    pet: 1.0,
    wall: 0,
  },
  balanced: {
    hero: 2.0,
    army: 1.6,
    defense: 1.5,
    resource: 1.0,
    storage: 1.0,
    trap: 0.8,
    other: 0.6,
    troop: 1.0,
    spell: 1.0,
    siege: 1.0,
    pet: 1.0,
    wall: 0,
  },
  defense: {
    hero: 1.5,
    army: 1.2,
    defense: 2.5,
    resource: 1.0,
    storage: 1.0,
    trap: 1.0,
    other: 0.6,
    troop: 1.0,
    spell: 1.0,
    siege: 1.0,
    pet: 1.0,
    wall: 0,
  },
};
