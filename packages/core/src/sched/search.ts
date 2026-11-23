// The outer search: a few scheduling runs with different targets, then seeded variants
// around the best, keeping the plan that finishes first.
import type { GameData } from "@max-planner/gamedata";
import type { RemainingWork } from "../calc/remaining.ts";
import type { Village } from "../types.ts";
import { sha256 } from "../util/sha256.ts";
import { mulberry32 } from "./prng.ts";
import { simulate, type Plan, type SimulateOptions } from "./simulate.ts";

export interface SearchOptions extends Omit<SimulateOptions, "targetFinish" | "swaps"> {
  /** Seed for the variants. The web app derives it from the village, so plans repeat. */
  seed?: number;
  /** Variant runs after the base runs. Default 64. */
  variants?: number;
  /** Most runs of the target loop. Default 5. */
  targetRuns?: number;
  /** Milliseconds from any clock, such as `performance.now`. Core never reads a clock itself. */
  clock?: () => number;
  /** With `clock`, stop starting runs after this many milliseconds. Default 1,500. */
  budgetMs?: number;
  /** Called after each run with the share of planned runs done, from 0 to 1. */
  onProgress?: (fraction: number) => void;
  /**
   * Seconds of finish a plan may give up for more strategy value. Default 0: the fastest
   * plan wins and strategy only breaks ties. A setting for players who would trade a
   * little time for, say, heroes first.
   */
  toleranceSeconds?: number;
  /**
   * Runs to make after the base runs, such as the winner of another search. The item
   * search replays the no-item winner this way, so items are judged on the same order.
   */
  alsoTry?: RunParams[];
}

export type RunKind = "chain" | "target" | "variant" | "replay";

/** What makes one run differ from another: its target and the decisions it swaps. */
export interface RunParams {
  targetFinish: number;
  swaps: number[];
}

export interface SearchResult {
  plan: Plan;
  /** SHA-256 of the placed steps; equal inputs and seed give an equal hash. */
  hash: string;
  /** Which kind of run produced the plan. */
  foundBy: RunKind;
  /** The winning run's target and swaps, to replay it with other options. */
  params: RunParams;
  /** Finish of the longest-chain-first run. */
  chainFinish: number;
  /** Earliest finish of any run. Equals `plan.finish` unless a tolerance traded time. */
  fastestFinish: number;
  runs: number;
  /** True if the time budget ran out before every planned run. */
  stoppedEarly: boolean;
  seed: number;
}

/** Earlier finish wins; at the same finish, more value in the first 30 days. */
export function betterPlan(a: Plan, b: Plan): boolean {
  if (a.finish !== b.finish) return a.finish < b.finish;
  return a.valueIn30Days > b.valueIn30Days;
}

/**
 * Finds a plan for `work`. The base runs are:
 * 1. Longest chain first: every step counts as critical, so the step with the longest
 *    chain after it always goes first. On random villages this alone beats the
 *    slack-and-value scoring about four times in five.
 * 2. The LLD's target loop: aim at the lower bound, then at each run's finish, until it
 *    stops improving. Here strategy value orders the steps with slack to spare.
 * Then variants around the winning base run take the second-best step at one to three
 * random decisions. Measured on random villages, drawing those decisions from the whole
 * run did slightly better than the LLD's first 20%, so the whole run it is.
 *
 * The winner is the plan with the most early value among those within `toleranceSeconds`
 * of the fastest; with the default of 0, that is the fastest plan, ties going to value.
 */
export function searchPlan(
  work: RemainingWork,
  village: Village,
  gd: GameData,
  options: SearchOptions = {},
): SearchResult {
  const {
    seed = 0x5eed,
    variants = 64,
    targetRuns = 5,
    clock,
    budgetMs = 1500,
    onProgress,
    toleranceSeconds = 0,
    alsoTry = [],
    ...base
  } = options;
  /** Runs that may still win: within the tolerance of the fastest so far. */
  let pool: { plan: Plan; kind: RunKind; targetFinish: number; swaps: number[] }[] = [];
  let fastest = Infinity;
  const offer = (plan: Plan, kind: RunKind, targetFinish: number, swaps: number[] = []) => {
    fastest = Math.min(fastest, plan.finish);
    pool.push({ plan, kind, targetFinish, swaps });
    pool = pool.filter((c) => c.plan.finish <= fastest + toleranceSeconds);
  };
  /** Most value within the tolerance; then the earlier finish; then the earlier run. */
  const pick = () =>
    pool.reduce((a, b) =>
      b.plan.valueIn30Days > a.plan.valueIn30Days ||
      (b.plan.valueIn30Days === a.plan.valueIn30Days && b.plan.finish < a.plan.finish)
        ? b
        : a,
    );
  const startedAt = clock?.();
  const planned = 1 + targetRuns + alsoTry.length + variants;
  let runs = 0;
  let stoppedEarly = false;
  const outOfTime = () => {
    if (clock === undefined || startedAt === undefined) return false;
    if (clock() - startedAt < budgetMs) return false;
    stoppedEarly = true;
    return true;
  };
  const run = (extra: { targetFinish: number; swaps?: Set<number> }) => {
    const plan = simulate(work, village, gd, { ...base, ...extra });
    runs++;
    onProgress?.(Math.min(1, runs / planned));
    return plan;
  };

  // 1. Longest chain first. Always runs, so there is always a plan.
  const chain = run({ targetFinish: 0 });
  offer(chain, "chain", 0);

  // 2. Target loop.
  let target = work.lowerBound.seconds;
  let loopBest: Plan | undefined;
  for (let i = 0; i < targetRuns && !outOfTime(); i++) {
    const plan = run({ targetFinish: target });
    offer(plan, "target", target);
    if (loopBest && !betterPlan(plan, loopBest)) break;
    loopBest = plan;
    const finish = plan.finish - plan.start;
    if (finish <= target) break;
    target = finish;
  }

  // 3. Replays asked for by the caller. Not cut by the budget: there are only a few.
  for (const p of alsoTry) {
    const swaps = new Set(p.swaps);
    offer(run({ targetFinish: p.targetFinish, swaps }), "replay", p.targetFinish, p.swaps);
  }

  // 4. Variants around the base run that would win now.
  const base0 = pick();
  const rng = mulberry32(seed);
  const decisions = Math.max(1, base0.plan.decisions);
  for (let i = 0; i < variants && !outOfTime(); i++) {
    const swaps = new Set<number>();
    const count = rng.int(1, 3);
    for (let j = 0; j < count; j++) swaps.add(rng.int(0, decisions - 1));
    offer(run({ targetFinish: base0.targetFinish, swaps }), "variant", base0.targetFinish, [
      ...swaps,
    ]);
  }
  onProgress?.(1);
  const best = pick();

  return {
    plan: best.plan,
    hash: planHash(best.plan),
    foundBy: best.kind,
    params: { targetFinish: best.targetFinish, swaps: best.swaps },
    chainFinish: chain.finish,
    fastestFinish: fastest,
    runs,
    stoppedEarly,
    seed,
  };
}

/** SHA-256 of canonical JSON of the placed steps: id, worker, start and end. */
export function planHash(plan: Plan): string {
  return sha256(JSON.stringify(plan.steps.map((p) => [p.id, p.worker, p.start, p.end])));
}

export interface ItemSavings {
  withItems: SearchResult;
  withoutItems: SearchResult;
  /** How much sooner the plan finishes with items; what the booster page shows. Never negative. */
  savedSeconds: number;
  /** False when no plan with items beat the plan without them, so `withItems` is that plan. */
  itemsHelp: boolean;
}

/**
 * Every plan runs twice, with items and without, so the page can show both dates. The item
 * search also replays the no-item winner with items, so items are judged on the same order
 * rather than on two searches' luck. A plan with items is never reported slower than the
 * plan without them: if items cannot bring the finish forward, the plan without them stands
 * and `itemsHelp` is false.
 */
export function searchWithItems(
  work: RemainingWork,
  village: Village,
  gd: GameData,
  options: SearchOptions = {},
): ItemSavings {
  const { boosters, ...rest } = options;
  const withoutItems = searchPlan(work, village, gd, rest);
  if (!boosters)
    return { withItems: withoutItems, withoutItems, savedSeconds: 0, itemsHelp: false };
  const tried = searchPlan(work, village, gd, {
    ...options,
    alsoTry: [...(options.alsoTry ?? []), withoutItems.params],
  });
  const itemsHelp = !betterPlan(withoutItems.plan, tried.plan);
  const withItems = itemsHelp ? tried : withoutItems;
  return {
    withItems,
    withoutItems,
    savedSeconds: withoutItems.plan.finish - withItems.plan.finish,
    itemsHelp,
  };
}
