import type { GameAdapter } from "../types";

export const accAdapter: GameAdapter = {
  id: "acc",
  displayName: "Assetto Corsa Competizione",
  shortName: "ACC",
  routePrefix: "acc",
  telemetry: {
    fuel: { packetUnit: "litre", binding: { kind: "value", semanticId: "fuel.remaining-volume" } },
    tireTemperature: { packetUnit: "celsius", binding: { kind: "value", semanticId: "tire.temperature.average" } },
    brakeTemperature: { packetUnit: "celsius", binding: { kind: "value", semanticId: "brakes.brake-temp" } },
    tirePressure: { packetUnit: "psi", binding: { kind: "value", semanticId: "tires.tire-pressure" } },
    pitStatus: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "race.pit-status" } },
    analysis: {
      balance: { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.tire-slip-angle"] } },
      gForce: { source: "derived", confidence: "exact", binding: { kind: "derived", derivation: "g-force-v1", requires: ["motion.acceleration-x", "motion.acceleration-z"] } },
      gripDemand: { source: "derived", confidence: "high", display: "per-wheel", binding: { kind: "derived", derivation: "friction-circle-v1", requires: ["motion.speed", "tires.wheel-rotation-speed", "tires.tire-slip-angle"] } },
      traction: { source: "derived", confidence: "exact", display: "per-wheel", binding: { kind: "derived", derivation: "traction-v1", requires: ["motion.speed", "inputs.steering", "tires.wheel-rotation-speed"] } },
      tireTemperature: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tire.temperature.average" } },
      surface: { source: "unavailable", reason: "source-limitation" },
      slipRatio: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-slip-ratio" } },
      slipAngle: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-slip-angle" } },
      lateralSlip: { source: "unavailable", reason: "source-limitation" },
      wheelRotation: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.wheel-rotation-speed" } },
      tireHealth: { source: "unavailable", reason: "source-limitation" },
      tireWearRate: { source: "unavailable", reason: "source-limitation" },
      tirePressure: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-pressure" } },
      suspensionTravel: { source: "direct", freshness: "continuous", display: "normalized", binding: { kind: "value", semanticId: "suspension.norm-suspension-travel" } },
      suspensionCompressionBias: { source: "derived", confidence: "exact", display: "compression-bias", binding: { kind: "derived", derivation: "compression-bias-v1", requires: ["suspension.norm-suspension-travel"] } },
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
