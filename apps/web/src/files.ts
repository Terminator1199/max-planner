// The data files, bundled into the page.
import gamedata from "@max-planner/gamedata/files/gamedata.json" with { type: "json" };
import items from "@max-planner/gamedata/files/magic-items.json" with { type: "json" };
import events from "@max-planner/gamedata/files/events.json" with { type: "json" };
import seasons from "@max-planner/gamedata/files/seasons.json" with { type: "json" };
import type { Files } from "./context.ts";

export const FILES: Files = { gamedata, items, events, seasons };
