import type { AnalysisTelemetryMetric } from "../../games/types";
import type { SemanticValueBinding } from "../../games/metric-contracts";
import type { SteerBalance, WheelState } from "./laps/physics/vehicle";
import { frictionCircleUtil, steerBalanceFromSignals, wheelDynamicsFrame } from "./laps/physics/vehicle";

export interface SemanticMetricFrame {
  readonly values: Readonly<Record<string, unknown>>;
  readonly states?: Readonly<Record<string, string | undefined>>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function wheelValues(frame: SemanticMetricFrame, id: string): readonly [number | null, number | null, number | null, number | null] {
  const raw = frame.values[id];
  if (!Array.isArray(raw)) return [null, null, null, null];
  return [0, 1, 2, 3].map((i) => finite(raw[i]) ? raw[i] : null) as [number | null, number | null, number | null, number | null];
}

function physicalWheelStates(frame: SemanticMetricFrame): readonly [WheelState | null, WheelState | null, WheelState | null, WheelState | null] {
  const speed = frame.values["motion.speed"];
  const steer = frame.values["inputs.steer"];
  const rotation = wheelValues(frame, "tires.wheel-rotation-speed");
  if (!finite(speed) || !rotation.every((value): value is number => value != null)) {
    return [null, null, null, null];
  }
  const radii = wheelValues(frame, "tires.tire-radius");
  const rotationValues = rotation.map((value) => value!) as [number, number, number, number];
  const wheelRadius = radii.every((value): value is number => value != null && value > 0)
    ? (radii[0]! + radii[1]! + radii[2]! + radii[3]!) / 4
    : (() => {
        const sorted = rotationValues.map((value) => Math.abs(value)).sort((a, b) => a - b);
        const baseRotation = (sorted[0] + sorted[1]) / 2;
        return baseRotation > 5 && speed > 3 ? speed / baseRotation : 0.33;
      })();
  const states = wheelDynamicsFrame({
    speedMps: speed,
    steer: finite(steer) ? steer : 0,
    wheelRotationRadS: { fl: rotationValues[0], fr: rotationValues[1], rl: rotationValues[2], rr: rotationValues[3] },
    wheelRadiusM: wheelRadius,
  });
  return [states.fl, states.fr, states.rl, states.rr];
}

export function resolveWheelMetric(frame: SemanticMetricFrame, binding: SemanticValueBinding): readonly [number | null, number | null, number | null, number | null] {
  return wheelValues(frame, binding.semanticId);
}

export function resolveGripDemand(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): readonly [number | null, number | null, number | null, number | null] {
  if (metric.source === "unavailable" || !metric.binding) return [null, null, null, null];
  if (metric.binding.kind === "value") return resolveWheelMetric(frame, metric.binding);
  if (metric.binding.kind !== "derived" || metric.binding.derivation !== "friction-circle-v1") return [null, null, null, null];
  const states = physicalWheelStates(frame);
  const angle = wheelValues(frame, "tires.tire-slip-angle");
  return states.map((state, i) => state == null || angle[i] == null ? null : frictionCircleUtil(state.slipRatio, angle[i]!)) as [number | null, number | null, number | null, number | null];
}

export function resolveWheelStates(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): readonly [WheelState | null, WheelState | null, WheelState | null, WheelState | null] {
  if (metric.source === "unavailable" || !metric.binding || metric.binding.kind !== "derived" || metric.binding.derivation !== "traction-v1") return [null, null, null, null];
  return physicalWheelStates(frame);
}

function requiredBalanceSignalsAvailable(frame: SemanticMetricFrame, requires: readonly string[]): boolean {
  return requires.every((id) => {
    const state = frame.states?.[id];
    if (state !== undefined && state !== "ok") return false;
    const value = frame.values[id];
    if (Array.isArray(value)) return value.length >= 4 && value.slice(0, 4).every(finite);
    return finite(value);
  });
}

export function resolveBalance(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): SteerBalance | null {
  if (metric.source === "unavailable" || !metric.binding || metric.binding.kind !== "derived" || metric.binding.derivation !== "physical-balance-v1") return null;
  if (!requiredBalanceSignalsAvailable(frame, metric.binding.requires)) return null;
  const slipAngleId = metric.binding.requires.find((id) =>
    id === "tires.tire-slip-angle" || id === "tires.normalized-tire-slip-angle",
  );
  const angles = slipAngleId ? wheelValues(frame, slipAngleId) : [null, null, null, null] as const;
  const speed = frame.values["motion.speed"];
  const accelerationX = frame.values["motion.acceleration-x"];
  const yawRate = frame.values["motion.angular-velocity-y"];
  if (!finite(speed) || !finite(accelerationX) || !finite(yawRate)) return null;
  const slipAngles = angles.every((angle): angle is number => angle != null)
    ? angles as [number, number, number, number]
    : undefined;
  return steerBalanceFromSignals({ speedMps: speed, accelerationX, yawRate, slipAngles });
}
