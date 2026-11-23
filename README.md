# Max Planner

A static web app that answers one question for a Clash of Clans player: **how many days until my village is maxed, and what changes that date?**

The player pastes the in-game data export (Settings → More Settings → Data Export → Copy). Everything after that runs in the browser: parsing, the remaining-work calculation, and an upgrade schedule that keeps every builder, the Laboratory and the Pet House busy. Nothing is sent to a server.

What it does:

- Days to max for the current Town Hall or any higher target, with a date per hall on the way.
- An upgrade order per worker that respects the player's offline hours and time zone.
- The Builder's Apprentice and Lab Assistant from the export, and the Gold Pass.
- Magic items (potions, books, hammers) in stock and expected each month, and the time they save.
- Announced events such as Hammer Jam applied to the plan; estimated ones can be switched on.
- Comparison of two exports: every level gained and how the days to max moved.
- Exports and settings are kept in the browser only, so a player can come back and compare.

## Status

Work arrives as a stack of pull requests, each one reviewable on its own:

| PR  | Scope                                                      |
| --- | ---------------------------------------------------------- |
| 1   | Monorepo scaffold, TypeScript, tests, CI                   |
| 2   | Data file schemas, validators and hand-written data files  |
| 3   | Export parser and import report                            |
| 4   | Remaining-work calculator, critical path and lower bound   |
| 5   | Scheduler: one simulation run, time rules, invariants      |
| 6   | Plan search, plan hash, golden plans                       |
| 7   | Magic items and events in the plan                         |
| 9   | Preview page: the real planner on a made-up demo village   |
| 11  | Real game data from ClashKing, merges, helpers             |
| 12  | The website: paste, plan, boosters, compare, saved exports |

## Layout

```text
packages/
  core/       parser, calculator, scheduler (pure TypeScript, no DOM or network)
  gamedata/   schemas, validators, loaders and the data files
apps/
  web/        the website (no framework, no dependencies)
tools/
  web-build/       bundles the website, and its planner worker, into one HTML file
  gamedata-build/  converts ClashKing's static data into gamedata.json
fixtures/     sample game data, anonymised exports, golden plan hashes
```

## The website

One self-contained HTML file: the app, the planner (run in a Web Worker, or on the page if the
browser blocks workers) and the game data are all inside it. It makes no network requests.

- From a CI run: open the latest run under the repository's Actions tab, download the `website`
  artifact, then open `index.html`.
- Locally: `pnpm install && pnpm web:build`, then open `dist/web/index.html`. It works straight
  from disk.
- Any static host: upload that one file.

Pages: **Start** (paste an export, or try a made-up demo village), **Plan** (days to max, the
timeline, the upgrade order and why each step is where it is), **Boosters** (helpers, Gold Pass,
magic items, events), **Compare** and **About**.

## Game data

`packages/gamedata/files/gamedata.json` is built from [ClashKing](https://github.com/ClashKingInc/ClashKingAssets)'s
static data at a pinned commit, by `pnpm gamedata:build`. That data is GPL-3.0; its licence text
is in `packages/gamedata/files/COPYING.gamedata` and the conversion rules are in that folder's
README. Keep both with the file wherever it is copied.

## Development

Requires Node 22.18 or newer and pnpm 10.

```sh
pnpm install
pnpm check        # typecheck, test, format check
pnpm test         # node:test, runs the TypeScript sources directly
pnpm typecheck
pnpm web:build       # dist/web/index.html
pnpm gamedata:build  # rebuild gamedata.json from the pinned ClashKing commit
```

Engineering choices worth knowing:

- **No build step for the core packages.** Node 22.18+ strips TypeScript types natively, so tests and tools run the `.ts` sources directly. The code uses erasable syntax only (no enums, namespaces or parameter properties), which `tsconfig.json` enforces.
- **Node's built-in test runner** (`node:test`) instead of Vitest, so the core has zero runtime and test dependencies.
- **Hand-written validators** for the data files instead of Zod, for the same reason. They are small and fully tested.

## Disclaimer

This material is unofficial and is not endorsed by Supercell. For more information see Supercell's Fan Content Policy: www.supercell.com/fan-content-policy.
