import type { GameAdapter } from "../types";

export const f1Adapter: GameAdapter = {
  id: "f1-2025",
  displayName: "F1 2025",
  shortName: "F1 25",
  routePrefix: "f125",
  coordSystem: "f1-2025",
  steeringCenter: 0,
  steeringRange: 1,
  tireHealthThresholds: { green: 0.70, yellow: 0.50 },
  tireTempThresholds: { cold: 80, warm: 110, hot: 135 },

  // Stubs — server adapter overrides with real lookups
  getCarName(ordinal) {
    return `Car #${ordinal}`;
  },

  getTrackName(ordinal) {
    return `Track #${ordinal}`;
  },

  getSharedTrackName() {
    return undefined;
  },

  carForwardOffset(yaw) { return [Math.sin(yaw), Math.cos(yaw)]; },
  followViewRotation(yaw) { return Math.PI - yaw; },
};
