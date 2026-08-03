import type { GameAdapter } from "../types";

export const acEvoAdapter: GameAdapter = {
  id: "ac-evo",
  displayName: "Assetto Corsa Evo",
  shortName: "AC Evo",
  routePrefix: "ac-evo",
  telemetry: {
    fuel: { packetUnit: "litre" },
    tireTemperature: { packetUnit: "celsius" },
    brakeTemperature: { packetUnit: "celsius" },
    tirePressure: { packetUnit: "psi" },
    weather: { source: "direct", freshness: "static" },
    pitStatus: { source: "direct", freshness: "continuous" },
    analysis: {
      suspensionTravel: {
        source: "direct",
        freshness: "continuous",
        display: "millimeters",
      },
    },
  },
  coordSystem: "standard-xyz",
  nativeSectors: false,
  appendsDelayedFinishFrame: true,
  authoritativeTrackLength: false,
  steeringCenter: 0,
  // Steer is emitted as steerAngle(-1..1) × 127 by the parser (Forza ±127
  // convention), so the usable range is 127 — not 1. Corner detection scales
  // its steering thresholds by this; a value of 1 breaks detection entirely.
  steeringRange: 127,
  tireHealthThresholds: { green: 0.85, yellow: 0.70 },
  tireTempThresholds: { cold: 70, warm: 100, hot: 120 },
  suspensionThresholds: { values: [25, 65, 85] },
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

  getSharedTrackName(_ordinal: number): string | undefined {
    return undefined;
  },

  carForwardOffset(yaw) { return [Math.sin(yaw), Math.cos(yaw)]; },
  followViewRotation(yaw) { return Math.PI - yaw; },
};
