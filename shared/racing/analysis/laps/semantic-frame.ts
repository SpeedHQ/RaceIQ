import type { SemanticTelemetrySample } from "../../../telemetry/replay/contracts";

export const CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS = [
  "brakes.brake-temp",
  "engine.boost",
  "engine.current-engine-rpm",
  "engine.engine-max-rpm",
  "engine.power",
  "fuel.fuel",
  "inputs.accel",
  "inputs.brake",
  "inputs.gear",
  "inputs.steer",
  "motion.acceleration-x",
  "motion.angular-velocity-y",
  "motion.acceleration-z",
  "motion.position-x",
  "motion.position-z",
  "motion.speed",
  "motion.velocity-x",
  "motion.velocity-y",
  "motion.velocity-z",
  "suspension.norm-suspension-travel",
  "suspension.suspension-travel-m",
  "timing.current-lap",
  "timing.distance-traveled",
  "timing.sector.current-index",
  "timing.sector.current-lap.times",
  "timing.sector.current-lap.s1",
  "timing.sector.current-lap.s2",
  "timing.sector.current-time",
  "timing.sector.last-completed-time",
  "timing.sector.last-lap.times",
  "timing.sector.last-lap.s1",
  "timing.sector.last-lap.s2",
  "timing.sector.last-lap.s3",
  "timing.sector.lap-history.lap-time",
  "timing.sector.lap-history.s1",
  "timing.sector.lap-history.s2",
  "timing.sector.lap-history.s3",
  "timing.sector.layout.start-fractions",
  "tire.temperature.average",
  "tires.normalized-tire-slip-angle",
  "tires.tire-combined-slip",
  "tires.tire-slip-angle",
  "tires.tire-slip-ratio",
  "tires.tire-wear",
  "tires.tire-pressure",
  "tires.wheel-on-rumble-strip",
  "tires.wheel-rotation-speed",
] as const;

export type CanonicalLapAnalysisSemanticId = (typeof CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS)[number];

export type WheelChannel = readonly [number | undefined, number | undefined, number | undefined, number | undefined];
export type WheelBooleanChannel = readonly [boolean | undefined, boolean | undefined, boolean | undefined, boolean | undefined];
type FiniteWheelChannel = readonly [number, number, number, number];
type CompleteWheelBooleanChannel = readonly [boolean, boolean, boolean, boolean];

/**
 * Canonical analysis frame. Values use catalog units and remain `undefined`
 * when source evidence is unavailable; native packet names never cross this
 * boundary.
 */
export interface SemanticLapFrame {
  readonly observedAtMs: number;
  readonly throttleInput: number | undefined;
  readonly brakeInput: number | undefined;
  readonly gear: number | undefined;
  readonly steeringInput: number | undefined;
  readonly velocityMps: readonly [number | undefined, number | undefined, number | undefined];
  readonly accelerationXMps2: number | undefined;
  readonly accelerationZMps2: number | undefined;
  readonly yawRateRadPerSec: number | undefined;
  readonly positionXM: number | undefined;
  readonly positionZM: number | undefined;
  readonly speedMps: number | undefined;
  /** Simulation elapsed time within current lap, in seconds. */
  readonly lapElapsedSeconds: number | undefined;
  readonly distanceM: number | undefined;
  readonly normalizedSuspensionTravel: WheelChannel;
  readonly suspensionTravelM: WheelChannel;
  readonly engineRpm: number | undefined;
  readonly engineMaxRpm: number | undefined;
  readonly boost: number | undefined;
  readonly power: number | undefined;
  readonly fuel: number | undefined;
  readonly tireCombinedSlip: WheelChannel;
  readonly tireSlipAngleRad: WheelChannel;
  readonly tireSlipRatio: WheelChannel;
  readonly tireTemperature: WheelChannel;
  readonly tireWear: WheelChannel;
  readonly wheelRotationRadPerSec: WheelChannel;
  readonly wheelOnRumbleStrip: WheelBooleanChannel;
  readonly tirePressure: WheelChannel;
  readonly brakeTemperature: WheelChannel;
}

function number(sample: SemanticTelemetrySample, id: CanonicalLapAnalysisSemanticId): number | undefined {
  const value = sample.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const unavailableWheels: WheelChannel = [undefined, undefined, undefined, undefined];
const unavailableWheelBooleans: WheelBooleanChannel = [undefined, undefined, undefined, undefined];

function wheelNumbers(sample: SemanticTelemetrySample, id: CanonicalLapAnalysisSemanticId): WheelChannel {
  const value = sample.values[id];
  if (!Array.isArray(value) || value.length !== 4) return unavailableWheels;
  const [fl, fr, rl, rr] = value;
  if (
    typeof fl !== "number" ||
    !Number.isFinite(fl) ||
    typeof fr !== "number" ||
    !Number.isFinite(fr) ||
    typeof rl !== "number" ||
    !Number.isFinite(rl) ||
    typeof rr !== "number" ||
    !Number.isFinite(rr)
  )
    return unavailableWheels;
  const complete: FiniteWheelChannel = [fl, fr, rl, rr];
  return complete;
}

function wheelBooleans(sample: SemanticTelemetrySample): WheelBooleanChannel {
  const value = sample.values["tires.wheel-on-rumble-strip"];
  if (!Array.isArray(value) || value.length !== 4) return unavailableWheelBooleans;
  const [fl, fr, rl, rr] = value;
  if (typeof fl !== "boolean" || typeof fr !== "boolean" || typeof rl !== "boolean" || typeof rr !== "boolean") return unavailableWheelBooleans;
  const complete: CompleteWheelBooleanChannel = [fl, fr, rl, rr];
  return complete;
}

export function semanticLapFrame(sample: SemanticTelemetrySample): SemanticLapFrame {
  const slipAngles = wheelNumbers(sample, "tires.tire-slip-angle");
  const tireSlipAngleRad = slipAngles.every((value) => value === undefined) ? wheelNumbers(sample, "tires.normalized-tire-slip-angle") : slipAngles;
  return {
    observedAtMs: sample.observedAtMs,
    throttleInput: number(sample, "inputs.accel"),
    brakeInput: number(sample, "inputs.brake"),
    gear: number(sample, "inputs.gear"),
    steeringInput: number(sample, "inputs.steer"),
    velocityMps: [number(sample, "motion.velocity-x"), number(sample, "motion.velocity-y"), number(sample, "motion.velocity-z")],
    accelerationXMps2: number(sample, "motion.acceleration-x"),
    accelerationZMps2: number(sample, "motion.acceleration-z"),
    yawRateRadPerSec: number(sample, "motion.angular-velocity-y"),
    positionXM: number(sample, "motion.position-x"),
    positionZM: number(sample, "motion.position-z"),
    speedMps: number(sample, "motion.speed"),
    lapElapsedSeconds: number(sample, "timing.current-lap"),
    distanceM: number(sample, "timing.distance-traveled"),
    normalizedSuspensionTravel: wheelNumbers(sample, "suspension.norm-suspension-travel"),
    suspensionTravelM: wheelNumbers(sample, "suspension.suspension-travel-m"),
    engineRpm: number(sample, "engine.current-engine-rpm"),
    engineMaxRpm: number(sample, "engine.engine-max-rpm"),
    boost: number(sample, "engine.boost"),
    power: number(sample, "engine.power"),
    fuel: number(sample, "fuel.fuel"),
    tireCombinedSlip: wheelNumbers(sample, "tires.tire-combined-slip"),
    tireSlipAngleRad,
    tireSlipRatio: wheelNumbers(sample, "tires.tire-slip-ratio"),
    tireTemperature: wheelNumbers(sample, "tire.temperature.average"),
    tireWear: wheelNumbers(sample, "tires.tire-wear"),
    wheelRotationRadPerSec: wheelNumbers(sample, "tires.wheel-rotation-speed"),
    wheelOnRumbleStrip: wheelBooleans(sample),
    tirePressure: wheelNumbers(sample, "tires.tire-pressure"),
    brakeTemperature: wheelNumbers(sample, "brakes.brake-temp"),
  };
}

export function semanticLapFrames(samples: readonly SemanticTelemetrySample[]): SemanticLapFrame[] {
  return samples.map(semanticLapFrame);
}
