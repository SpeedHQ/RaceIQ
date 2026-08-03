import type { GameAdapter } from "../types";

export const f1Adapter: GameAdapter = {
  id: "f1-2025",
  displayName: "F1 2025",
  shortName: "F1 25",
  routePrefix: "f125",
  telemetry: {
    fuel: { packetUnit: "fraction" },
    tireTemperature: { packetUnit: "celsius" },
    power: { packetUnit: "watt" },
    brakeTemperature: { packetUnit: "celsius" },
    tirePressure: { packetUnit: "psi" },
    ers: true,
    clutch: { source: "direct", freshness: "continuous" },
    weather: { source: "direct", freshness: "continuous" },
    analysis: {
      surface: {
        source: "unavailable",
        reason: "source-limitation",
      },
    },
  },
  coordSystem: "f1-2025",
  nativeSectors: false,
  appendsDelayedFinishFrame: true,
  authoritativeTrackLength: false,
  steeringCenter: 0,
  // Steer is emitted as steer(-1..1) × 127 by the parser (Forza ±127
  // convention), so the usable range is 127 — not 1. Corner detection scales
  // its steering thresholds by this; a value of 1 breaks detection entirely.
  steeringRange: 127,
  tireHealthThresholds: { green: 0.70, yellow: 0.50 },
  tireTempThresholds: { cold: 80, warm: 110, hot: 135 },
  suspensionThresholds: { values: [25, 65, 85] },

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
