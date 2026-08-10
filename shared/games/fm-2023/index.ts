import type { GameAdapter } from "../types";

export const forzaAdapter: GameAdapter = {
  id: "fm-2023",
  displayName: "Forza Motorsport 2023",
  shortName: "Forza",
  routePrefix: "fm23",
  telemetry: {
    fuel: { packetUnit: "fraction", binding: { kind: "value", semanticId: "fuel.fuel" } },
    tireTemperature: { packetUnit: "fahrenheit", binding: { kind: "value", semanticId: "tire.temperature.average" } },
    boost: { packetUnit: "psi", binding: { kind: "value", semanticId: "engine.boost" } },
    power: { packetUnit: "watt", binding: { kind: "value", semanticId: "engine.power" } },
    torque: { packetUnit: "newton-metre", binding: { kind: "value", semanticId: "engine.torque" } },
    clutch: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "inputs.clutch" } },
    handBrake: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "brakes.hand-brake" } },
    analysis: {
      balance: { source: "unavailable", reason: "missing-model" },
      gForce: { source: "unavailable", reason: "missing-model" },
      gripDemand: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-combined-slip" } },
      traction: { source: "unavailable", reason: "missing-model" },
      tireTemperature: { source: "unavailable", reason: "source-limitation" },
      surface: { source: "unavailable", reason: "source-limitation" },
      slipRatio: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-slip-ratio" } },
      slipAngle: { source: "unavailable", reason: "source-limitation" },
      lateralSlip: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.normalized-tire-slip-angle" } },
      wheelRotation: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.wheel-rotation-speed" } },
      tireHealth: { source: "unavailable", reason: "source-limitation" },
      tireWearRate: { source: "unavailable", reason: "source-limitation" },
      tirePressure: { source: "unavailable", reason: "source-limitation" },
      suspensionTravel: { source: "direct", freshness: "continuous", display: "normalized", binding: { kind: "value", semanticId: "suspension.norm-suspension-travel" } },
      suspensionCompressionBias: { source: "unavailable", reason: "missing-model" },
    },
  },
  coordSystem: "forza",
  nativeSectors: false,
  appendsDelayedFinishFrame: true,
  authoritativeTrackLength: false,
  steeringCenter: 127,
  steeringRange: 127,
  tireHealthThresholds: { green: 0.70, yellow: 0.40 },
  tireTempThresholds: { cold: 75, warm: 115, hot: 150 },
  suspensionThresholds: { values: [25, 65, 85] },

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

  carForwardOffset(yaw) { return [Math.sin(yaw), Math.cos(yaw)]; },
  followViewRotation(yaw) { return Math.PI - yaw; },
};
