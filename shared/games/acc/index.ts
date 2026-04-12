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
  // Pressure optimal is class-aware — resolved server-side via the
  // /api/acc/cars/:ordinal/pressure-optimal endpoint.
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

  // Stub — server adapter overrides with real CSV-backed lookup
  getSharedTrackName(_ordinal: number): string | undefined {
    return undefined;
  },

  carForwardOffset(yaw) { return [Math.sin(yaw), Math.cos(yaw)]; },
  followViewRotation(yaw) { return Math.PI - yaw; },
};
