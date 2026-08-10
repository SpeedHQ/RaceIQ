import type { AnalysisTelemetryMetric } from "../../games/types";
import type { SemanticValueBinding } from "../../games/metric-contracts";
import type { WheelState } from "./laps/physics/vehicle";
import { frictionCircleUtil, steerBalanceFromSignals } from "./laps/physics/vehicle";
import type { SteerBalance } from "./laps/physics/vehicle";

export interface SemanticMetricFrame {
  readonly values: Readonly<Record<string, unknown>>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function wheelValues(frame: SemanticMetricFrame, id: string): readonly [number | null, number | null, number | null, number | null] {
  const raw = frame.values[id];
  if (!Array.isArray(raw)) return [null, null, null, null];
  return [0, 1, 2, 3].map((i) => finite(raw[i]) ? raw[i] : null) as [number | null, number | null, number | null, number | null];
}

export function resolveWheelMetric(frame: SemanticMetricFrame, binding: SemanticValueBinding): readonly [number | null, number | null, number | null, number | null] {
  return wheelValues(frame, binding.semanticId);
}

export function resolveGripDemand(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): readonly [number | null, number | null, number | null, number | null] {
  if (metric.source === "unavailable" || !metric.binding) return [null, null, null, null];
  if (metric.binding.kind === "value") return resolveWheelMetric(frame, metric.binding);
  if (metric.binding.kind !== "derived" || metric.binding.derivation !== "friction-circle-v1") return [null, null, null, null];
  const ratio = wheelValues(frame, "tires.tire-slip-ratio");
  const angle = wheelValues(frame, "tires.tire-slip-angle");
  return ratio.map((r, i) => r == null || angle[i] == null ? null : frictionCircleUtil(r, angle[i]!)) as [number | null, number | null, number | null, number | null];
}

export function resolveWheelStates(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): readonly [WheelState | null, WheelState | null, WheelState | null, WheelState | null] {
  if (metric.source === "unavailable" || !metric.binding || metric.binding.kind !== "derived" || metric.binding.derivation !== "traction-v1") return [null, null, null, null];
  const ratio = wheelValues(frame, "tires.tire-slip-ratio");
  return ratio.map((r) => r == null ? null : ({ state: r < -0.2 ? "lockup" : r > 0.1 ? "spin" : "grip", slipRatio: r })) as [WheelState | null, WheelState | null, WheelState | null, WheelState | null];
}

export function resolveBalance(frame: SemanticMetricFrame, metric: AnalysisTelemetryMetric): SteerBalance | null {
  if (metric.source === "unavailable" || !metric.binding || metric.binding.kind !== "derived" || metric.binding.derivation !== "physical-balance-v1") return null;
  const angles = wheelValues(frame, "tires.tire-slip-angle");
  const speed = frame.values["motion.speed-mps"];
  const accelerationX = frame.values["motion.acceleration-x"];
  const yawRate = frame.values["motion.angular-velocity-y"];
  if (!angles.every(finite) || !finite(speed) || !finite(accelerationX) || !finite(yawRate)) return null;
  return steerBalanceFromSignals({ speedMps: speed, accelerationX, yawRate, slipAngles: angles as [number, number, number, number] });
}
