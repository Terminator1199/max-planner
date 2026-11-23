// The Builder's Apprentice and Lab Assistant, from the export's `helpers` rows.
//
// ClashKing's helpers data: each works for one hour (3,600 s) with a multiplier equal to
// its level, so a level N helper adds N hours of work in that hour. Exports show
// cooldowns of up to about 21 hours, which fits a 23-hour cycle (LLD, "Helpers").
import type { HelperBoost } from "../sched/simulate.ts";
import type { Village } from "../types.ts";

export const BUILDERS_APPRENTICE = 93000000;
export const LAB_ASSISTANT = 93000001;
export const HELPER_PERIOD = 23 * 3600;
export const HELPER_LENGTH = 3600;

/**
 * Repeating boosts for the scheduler. The Lab Assistant speeds up the Laboratory. The
 * Builder's Apprentice helps one builder; its hours are spread over all of them, which
 * adds the same builder time without tracking which upgrade it sits on.
 */
export function helperBoosts(village: Village): HelperBoost[] {
  const out: HelperBoost[] = [];
  for (const h of village.helpers) {
    if (h.level < 1) continue;
    const first = village.exportedAt + (h.cooldownSeconds ?? 0);
    if (h.dataId === LAB_ASSISTANT) {
      out.push({
        lane: "lab",
        bonus: h.level,
        first,
        period: HELPER_PERIOD,
        length: HELPER_LENGTH,
      });
    } else if (h.dataId === BUILDERS_APPRENTICE) {
      out.push({
        lane: "builder",
        bonus: h.level / Math.max(1, village.builders),
        first,
        period: HELPER_PERIOD,
        length: HELPER_LENGTH,
      });
    }
  }
  return out;
}
