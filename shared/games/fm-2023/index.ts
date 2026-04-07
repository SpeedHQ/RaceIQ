import type { GameAdapter } from "../types";

export const forzaAdapter: GameAdapter = {
  id: "fm-2023",
  displayName: "Forza Motorsport 2023",
  shortName: "Forza",
  routePrefix: "fm23",
  coordSystem: "forza",
  steeringCenter: 127,
  steeringRange: 127,
  tireHealthThresholds: { green: 0.70, yellow: 0.40 },

  // Stubs — server adapter overrides with real CSV-backed lookups
  getCarName(ordinal) {
    return `Car #${ordinal}`;
  },

  getTrackName(ordinal) {
    return `Track #${ordinal}`;
  },

  getSharedTrackName() {
    return undefined;
  },

  carClassNames: {
    0: "D",
    1: "C",
    2: "B",
    3: "A",
    4: "S",
    5: "R",
    6: "P",
    7: "X",
  },

  drivetrainNames: {
    0: "FWD",
    1: "RWD",
    2: "AWD",
  },
};
