import type { GameAdapter } from "../types";

export const f1Adapter: GameAdapter = {
  id: "f1-2025",
  displayName: "F1 2025",
  shortName: "F1 25",
  routePrefix: "f125",
  telemetry: {
    fuel: { packetUnit: "fraction", binding: { kind: "value", semanticId: "fuel.fuel" } },
    tireTemperature: { packetUnit: "celsius", binding: { kind: "value", semanticId: "tire.temperature.average" } },
    power: { packetUnit: "watt", binding: { kind: "value", semanticId: "engine.power" } },
    brakeTemperature: { packetUnit: "celsius", binding: { kind: "value", semanticId: "brakes.brake-temp" } },
    tirePressure: { packetUnit: "psi", binding: { kind: "value", semanticId: "tires.tire-pressure" } },
    ers: { source: "direct", freshness: "continuous", binding: { kind: "group", required: ["fuel.ers-store-energy"] } },
    clutch: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "inputs.clutch" } },
    weather: { source: "direct", freshness: "continuous", binding: { kind: "group", required: ["weather.air-temp"] } },
    analysis: {
      balance: { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.tire-slip-angle"] } },
      gForce: { source: "derived", confidence: "exact", binding: { kind: "derived", derivation: "g-force-v1", requires: ["motion.acceleration-x", "motion.acceleration-z"] } },
      gripDemand: { source: "derived", confidence: "high", display: "per-wheel", binding: { kind: "derived", derivation: "friction-circle-v1", requires: ["tires.tire-slip-angle", "tires.tire-slip-ratio"] } },
      tireTemperature: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tire.temperature.average" } },
      surface: { source: "unavailable", reason: "source-limitation" },
      slipRatio: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-slip-ratio" } },
      slipAngle: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-slip-angle" } },
      lateralSlip: { source: "unavailable", reason: "source-limitation" },
      wheelRotation: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.wheel-rotation-speed" } },
      tireHealth: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-wear" } },
      tireWearRate: { source: "derived", confidence: "high", display: "per-wheel", binding: { kind: "derived", derivation: "wear-rate-v1", requires: ["tires.tire-wear"] } },
      tirePressure: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-pressure" } },
      suspensionTravel: { source: "direct", freshness: "continuous", display: "millimeters", binding: { kind: "value", semanticId: "suspension.suspension-travel-m" } },
      suspensionCompressionBias: { source: "unavailable", reason: "source-limitation" },
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
