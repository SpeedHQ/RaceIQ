export interface LiveSectorData {
  sectorCount: number;
  currentSector: number;
  currentSectorTime: number;
  currentTimes: number[];
  lastTimes: number[];
  bestTimes: number[];
  lastLapTime: number;
  bestLapTime: number;
  estimatedLap: number;
  deltaToBest: number;
  deltaToLast: number;
}

export interface LivePitData {
  fuelPerLap: number;
  fuelLapsRemaining: number | null;
  currentLapFuelUsed: number;
  /** Laps until worst tire hits the game's "bad health" threshold (yellow). */
  tireLapsToBad: number | null;
  /** Laps until worst tire hits 20% health (critical / near-dead). */
  tireLapsToCritical: number | null;
  /** Per-tire laps to cliff and to dead, and wear rate per lap. */
  tireEstimates: {
    toCliff: [number | null, number | null, number | null, number | null]; // FL, FR, RL, RR
    toDead: [number | null, number | null, number | null, number | null];
    wearPerLap: [number, number, number, number];
  };
  /** Wear per lap from last completed lap (worst tire). */
  tireWearPerLap: number;
  pitInLaps: number | null;
  limitedBy: "fuel" | "tires" | null;
  trackLength: number;
  /** Whether estimates are from historical data or current session laps. */
  estimateSource: "history" | "session" | null;
  /** Health threshold percentages used for cliff and dead. */
  cliffPct: number;
  deadPct: number;
  // Deprecated — use tireLapsToBad
  tireLapsRemaining: number | null;
}
