import type { GameAdapter } from "../types";

export const accAdapter: GameAdapter = {
  id: "acc",
  displayName: "Assetto Corsa Competizione",
  shortName: "ACC",
  routePrefix: "acc",
  coordSystem: "standard-xyz",
  steeringCenter: 0,
  steeringRange: 1,
  tireHealthThresholds: { green: 0.85, yellow: 0.70 },
  tireTempThresholds: { cold: 70, warm: 100, hot: 120 },
  tirePressureOptimal: { min: 26, max: 27.2 },
  brakeTempThresholds: {
    front: { warm: 650, hot: 700 },
    rear:  { warm: 450, hot: 500 },
  },

  // Stubs — server adapter overrides with real CSV-backed lookups
  getCarName(ordinal: number): string {
    return `Car #${ordinal}`;
  },

  getTrackName(ordinal: number): string {
    return `Track #${ordinal}`;
  },

  getSharedTrackName(): string | undefined {
    return undefined;
  },

  // ACC heading = atan2(-z, x): heading=0 means facing +X
  carForwardOffset(yaw) { return [Math.cos(yaw), -Math.sin(yaw)]; },
  followViewRotation(yaw) { return Math.PI / 2 - yaw; },
};
