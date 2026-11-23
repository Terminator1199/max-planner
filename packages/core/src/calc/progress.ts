// How far a village is toward maxing a hall, as a share of all the worker time involved.
import type { GameData } from "@max-planner/gamedata";
import type { Village } from "../types.ts";
import type { RemainingWork } from "./remaining.ts";

export interface Progress {
  /** Worker seconds already in the village's levels, up to the target hall's caps. */
  doneSeconds: number;
  /** Worker seconds left: builders, Laboratory and Pet House together. */
  leftSeconds: number;
  /** From 0 to 1. */
  fraction: number;
}

/** Time already put in, against the remaining work for the same target hall. */
export function progress(village: Village, gd: GameData, work: RemainingWork): Progress {
  let done = 0;
  for (const inst of village.instances) {
    const top = Math.min(inst.level, gd.capAt(inst.entityId, work.targetTownHall));
    for (let x = 1; x <= top; x++) done += gd.level(inst.entityId, x)?.seconds ?? 0;
  }
  const s = work.totals.seconds;
  const left = s.builder + s.lab + s.petHouse;
  const total = done + left;
  return { doneSeconds: done, leftSeconds: left, fraction: total === 0 ? 1 : done / total };
}
