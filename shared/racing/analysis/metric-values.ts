import type { AnalysisTelemetryMetric } from "../../games/types";
import type { SemanticValueBinding } from "../../games/metric-contracts";
import type { SteerBalance, WheelState } from "./laps/physics/vehicle";
import { frictionCircleUtil, steerBalanceFromSignals, wheelDynamicsFrame } from "./laps/physics/vehicle";

export interface SemanticMetricFrame {
  readonly values: Readonly<Record<string, unknown>>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
type NullableWheelValues = readonly [number | null, number | null, number | null, number | null];
type FiniteWheelValues = readonly [number, number, number, number];

function wheelValues(frame: SemanticMetricFrame, id: string): NullableWheelValues {
  const raw = frame.values[id];
  if (!Array.isArray(raw) || raw.length !== 4) return [null, null, null, null];
  const [fl, fr, rl, rr] = raw;
  return [finite(fl) ? fl : null, finite(fr) ? fr : null, finite(rl) ? rl : null, finite(rr) ? rr : null];
}

function finiteWheelValues(values: NullableWheelValues): FiniteWheelValues | null {
  const [fl, fr, rl, rr] = values;
  if (fl == null || fr == null || rl == null || rr == null) return null;
  return [fl, fr, rl, rr];
}

function physicalWheelStates(frame: SemanticMetricFrame): readonly [WheelState | null, WheelState | null, WheelState | null, WheelState | null] {
  const speed = frame.values["motion.speed"];
  const steer = frame.values["inputs.steer"];
  const rotation = finiteWheelValues(wheelValues(frame, "tires.wheel-rotation-speed"));
  if (!finite(speed) || !finite(steer) || rotation === null) return [null, null, null, null];

  const radii = finiteWheelValues(wheelValues(frame, "tires.tire-radius"));
  const wheelRadius =
    radii !== null && radii.every((value) => value > 0)
      ? (radii[0] + radii[1] + radii[2] + radii[3]) / 4
      : (() => {
          const fl = Math.abs(rotation[0]);
          const fr = Math.abs(rotation[1]);
          const rl = Math.abs(rotation[2]);
          const rr = Math.abs(rotation[3]);
          const baseRotation = (fl + fr + rl + rr - Math.min(fl, fr, rl, rr) - Math.max(fl, fr, rl, rr)) / 2;
          return baseRotation > 5 && speed > 3 ? speed / baseRotation : null;
        })();
  if (wheelRadius === null || !Number.isFinite(wheelRadius) || wheelRadius <= 0) return [null, null, null, null];
  const states = wheelDynamicsFrame({
    speedMps: speed,
    steer,
    wheelRotationRadS: { fl: rotation[0], fr: rotation[1], rl: rotation[2], rr: rotation[3] },
    wheelRadiusM: wheelRadius,
  });
  return [states.fl, states.fr, states.rl, states.rr];
}

export function resolveWheelMetric(frame: SemanticMetricFrame, binding: SemanticValueBinding): readonly [number | null, number | null, number | null, number | null] {
  return wheelValues(frame, binding.semanticId);
}

export function resolveGripDemand(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): NullableWheelValues {
  if (metric.source === "unavailable" || !metric.binding) return [null, null, null, null];
  if (metric.binding.kind === "value") return resolveWheelMetric(frame, metric.binding);
  if (metric.binding.kind !== "derived" || metric.binding.derivation !== "friction-circle-v1") return [null, null, null, null];
  const states = physicalWheelStates(frame);
  const angles = wheelValues(frame, "tires.tire-slip-angle");
  const output: [number | null, number | null, number | null, number | null] = [null, null, null, null];
  for (let index = 0; index < 4; index++) {
    const state = states[index];
    const angle = angles[index];
    if (state !== null && angle !== null) output[index] = frictionCircleUtil(state.slipRatio, angle);
  }
  return output;
}

export function resolveWheelStates(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): readonly [WheelState | null, WheelState | null, WheelState | null, WheelState | null] {
  if (metric.source === "unavailable" || !metric.binding || metric.binding.kind !== "derived" || metric.binding.derivation !== "traction-v1") return [null, null, null, null];
  return physicalWheelStates(frame);
}

export function resolveBalance(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): SteerBalance | null {
  if (metric.source === "unavailable" || !metric.binding || metric.binding.kind !== "derived" || metric.binding.derivation !== "physical-balance-v1") return null;
  const slipAngleId = metric.binding.requires.find((id) => id === "tires.tire-slip-angle" || id === "tires.normalized-tire-slip-angle");
  const angles: NullableWheelValues = slipAngleId ? wheelValues(frame, slipAngleId) : [null, null, null, null];
  const speed = frame.values["motion.speed"];
  const accelerationX = frame.values["motion.acceleration-x"];
  const yawRate = frame.values["motion.angular-velocity-y"];
  if (!finite(speed) || !finite(accelerationX) || !finite(yawRate)) return null;
  const slipAngles = finiteWheelValues(angles) ?? undefined;
  return steerBalanceFromSignals({ speedMps: speed, accelerationX, yawRate, slipAngles });
}
