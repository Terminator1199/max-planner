// Player-state types shared by the parser, calculator and scheduler.
// Times are Unix seconds; durations are seconds.

export interface Instance {
  entityId: number;
  /**
   * Position among this entity's instances: upgrading ones first, then by level
   * from highest to lowest. Step ids use it, so it must be stable for one export.
   */
  index: number;
  level: number;
  /** Set while the instance is upgrading from `level` to `level + 1`. */
  finishesAt?: number;
}

export interface WallCount {
  entityId: number;
  level: number;
  count: number;
}

export interface HelperState {
  /** The export's id for the helper (Builder's Apprentice, Lab Assistant, ...). */
  dataId: number;
  level: number;
  cooldownSeconds?: number;
}

export interface Village {
  tag: string;
  exportedAt: number;
  townHall: number;
  builders: number;
  instances: Instance[];
  walls: WallCount[];
  helpers: HelperState[];
}
