# Max Planner

A static web app that answers one question for a Clash of Clans player: **how many days until my village is maxed, and what changes that date?**

The player pastes the in-game data export (Settings → More Settings → Data Export → Copy). Everything after that runs in the browser: parsing, the remaining-work calculation, and an upgrade schedule that keeps every builder, the Laboratory and the Pet House busy. Nothing is sent to a server.

Planned features, from the design docs:

- Days to max for the current Town Hall or any higher target, with a date per hall on the way.
- An upgrade order per worker that respects the player's offline hours.
- Magic items (potions, books, hammers) in stock and expected each month, and the days they save.
- Announced events such as Hammer Jam applied to the plan.
- Comparison of two exports.

## Status

Early development. Work arrives as a stack of pull requests, each one reviewable on its own:

| PR  | Scope                                                      |
| --- | ---------------------------------------------------------- |
| 1   | Monorepo scaffold, TypeScript, tests, CI                   |
| 2   | Data file schemas, validators and hand-written data files  |
| 3   | Export parser and import report                            |
| 4   | Remaining-work calculator, critical path and lower bound   |
| 5   | Scheduler: one simulation run, time rules, invariants      |
| …   | Plan search, boosters and events, web app, game data build |

## Layout

```text
packages/
  core/       parser, calculator, scheduler (pure TypeScript, no DOM or network)
  gamedata/   schemas, validators, loaders and the data files
apps/         web app (later)
tools/        game data build (later)
fixtures/     anonymised exports and golden plans (later)
```

## Development

Requires Node 22.18 or newer and pnpm 10.

```sh
pnpm install
pnpm check        # typecheck, test, format check
pnpm test         # node:test, runs the TypeScript sources directly
pnpm typecheck
```

Engineering choices worth knowing:

- **No build step for the core packages.** Node 22.18+ strips TypeScript types natively, so tests and tools run the `.ts` sources directly. The code uses erasable syntax only (no enums, namespaces or parameter properties), which `tsconfig.json` enforces.
- **Node's built-in test runner** (`node:test`) instead of Vitest, so the core has zero runtime and test dependencies.
- **Hand-written validators** for the data files instead of Zod, for the same reason. They are small and fully tested.

## Disclaimer

This material is unofficial and is not endorsed by Supercell. For more information see Supercell's Fan Content Policy: www.supercell.com/fan-content-policy.
