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
    // Gear 0 = neutral, gear 11 = reverse; out-of-race frames carry no
    // usable power telemetry.
    gearing: { neutralGear: 0, reverseGear: 11, requireRaceOn: true },
    analysis: {
      balance: {
        source: "derived",
        confidence: "high",
        binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.normalized-tire-slip-angle"] },
      },
      gForce: { source: "derived", confidence: "exact", binding: { kind: "derived", derivation: "g-force-v1", requires: ["motion.acceleration-x", "motion.acceleration-z"] } },
      gripDemand: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-combined-slip" } },
      traction: {
        source: "derived",
        confidence: "exact",
        display: "per-wheel",
        binding: { kind: "derived", derivation: "traction-v1", requires: ["motion.speed", "inputs.steer", "tires.wheel-rotation-speed"] },
      },
      tireTemperature: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tire.temperature.average" } },
      surface: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "group", required: ["tires.wheel-on-rumble-strip", "tires.wheel-in-puddle-depth"] } },
      slipRatio: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-slip-ratio" } },
      slipAngle: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.normalized-tire-slip-angle" } },
      lateralSlip: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.normalized-tire-slip-angle" } },
      wheelRotation: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.wheel-rotation-speed" } },
      tireHealth: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-wear" } },
      tireWearRate: { source: "derived", confidence: "high", display: "per-wheel", binding: { kind: "derived", derivation: "wear-rate-v1", requires: ["tires.tire-wear"] } },
      tirePressure: { source: "unavailable", reason: "source-limitation" },
      suspensionTravel: { source: "direct", freshness: "continuous", display: "normalized", binding: { kind: "value", semanticId: "suspension.norm-suspension-travel" } },
      suspensionCompressionBias: {
        source: "derived",
        confidence: "exact",
        display: "compression-bias",
        binding: { kind: "derived", derivation: "compression-bias-v1", requires: ["suspension.norm-suspension-travel"] },
      },
    },
  },
  coordSystem: "forza",
  nativeSectors: false,
  appendsDelayedFinishFrame: true,
  authoritativeTrackLength: false,
  steeringCenter: 127,
  steeringRange: 127,
  tireHealthThresholds: { green: 0.7, yellow: 0.4 },
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

  carForwardOffset(yaw) {
    return [Math.sin(yaw), Math.cos(yaw)];
  },
  followViewRotation(yaw) {
    return Math.PI - yaw;
  },
};
