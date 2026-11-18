import { GAMEDATA_PACKAGE } from "@max-planner/gamedata";

// Parser, calculator and scheduler land in later PRs.
export const CORE_PACKAGE = "@max-planner/core";
export const DEPENDS_ON = [GAMEDATA_PACKAGE] as const;
