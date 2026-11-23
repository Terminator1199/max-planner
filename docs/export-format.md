# The in-game data export

In the game: Settings → More Settings → Data Export → Copy. The text is one JSON object.
Everything below was checked against nine exports that players and tool makers posted
publicly on GitHub, Town Hall 8 to 18, dated October 2025 to 3 November 2026. None of
them is copied into this repository; `fixtures/exports/real-shape.json` reproduces
their structure on the sample ids.

None was taken after the Town Hall 19 update of 16 November 2026, so sections or
fields added with it are still to be seen.

## Top level

| Key              | Shape       | What it holds                                                                                              |
| ---------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `tag`            | string      | Player tag. Kept out of git; fixtures use `#FIXTURE01` and up.                                             |
| `timestamp`      | integer     | Export time, Unix seconds. Every timer counts from it.                                                     |
| `buildings`      | rows        | Home Village buildings, including Town Hall, huts, walls.                                                  |
| `traps`          | rows        | Home Village traps.                                                                                        |
| `units`          | rows        | Troops, by research level.                                                                                 |
| `siege_machines` | rows        | Siege machines (ids in the troop range).                                                                   |
| `spells`         | rows        | Spells.                                                                                                    |
| `heroes`         | rows        | Heroes.                                                                                                    |
| `pets`           | rows        | Pets.                                                                                                      |
| `guardians`      | rows        | Town Hall 18 and up; upgradeable, with timers.                                                             |
| `helpers`        | rows        | Builder's Apprentice, Lab Assistant and newer helpers.                                                     |
| `equipment`      | rows        | Hero equipment (Blacksmith, ores; no builder time).                                                        |
| `decos`          | rows        | Decorations (`data`, `cnt`).                                                                               |
| `obstacles`      | rows        | Obstacles (`data`, `cnt`).                                                                                 |
| `house_parts`    | list of ids | Clan Capital house parts.                                                                                  |
| `skins`          | list of ids | Hero skins.                                                                                                |
| `sceneries`      | list of ids | Sceneries.                                                                                                 |
| `boosts`         | object      | `builder_boost`, `lab_boost`: seconds left on an active potion; `clocktower_cooldown`.                     |
| `…2`             | as above    | Builder Base: `buildings2`, `traps2`, `units2`, `heroes2`, `decos2`, `obstacles2`, `skins2`, `sceneries2`. |

## Rows

| Field              | Seen on                                                  | Meaning                                                       |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------- |
| `data`             | all                                                      | Id. Matches ClashKing's static data `_id`.                    |
| `lvl`              | all but decos and obstacles                              | Level.                                                        |
| `cnt`              | buildings, traps                                         | That many copies at this level, all idle.                     |
| `timer`            | buildings, traps, units, spells, heroes, pets, guardians | Seconds until the upgrade to `lvl + 1` ends.                  |
| `gear_up`          | buildings                                                | A Master Builder gear-up; the timer is not a level upgrade.   |
| `supercharge`      | buildings                                                | Supercharge tiers done; a timer belongs to the next tier.     |
| `weapon`           | Town Hall                                                | Town Hall weapon level.                                       |
| `types`            | crafted defenses                                         | Modules and their levels. These rows have no `lvl`.           |
| `extra`            | traps, units, spells                                     | A second upgrade running at once in that lane (event helper). |
| `helper_recurrent` | buildings, traps, units, spells, guardians               | The helper is assigned to this upgrade each cycle.            |
| `helper_cooldown`  | helpers                                                  | Seconds until the helpers work again; the same value on each. |
| `helper_timer`     | guardians                                                | Helper progress on a guardian upgrade.                        |

## Id ranges

| Range              | Kind          | Range               | Kind             |
| ------------------ | ------------- | ------------------- | ---------------- |
| 1000000–1000102    | buildings     | 28000000–28000007   | heroes           |
| 12000000–12000020  | traps         | 73000000–73000017   | pets             |
| 4000000–4000188    | troops, siege | 93000000–93000003   | helpers          |
| 26000000–26000123  | spells        | 107000000–107000008 | guardians        |
| 90000000–106000048 | equipment     | 18000000…, 8000000… | decos, obstacles |

## What the planner does with them

`packages/core/src/parser/sections.ts` lists every key above. Planned today: buildings,
traps, units, siege machines, spells, heroes, pets, and the helpers' levels. Reported
but not planned yet: guardians, Town Hall weapons, crafted defenses, supercharges,
gear-ups, equipment and the Builder Base. Active potions in `boosts` are read later
by the scheduler (not yet).
