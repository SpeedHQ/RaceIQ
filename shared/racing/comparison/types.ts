import type { TelemetryVariableId } from "../../telemetry/catalog/generated/telemetry-catalog.types";
import type { LapMeta } from "../sessions/types";

export interface AlignedTrace {
  distance: number[];
  sourceIndicesA: number[];
  sourceIndicesB: number[];
  speedA: number[];
  speedB: number[];
  throttleA: number[];
  throttleB: number[];
  brakeA: number[];
  brakeB: number[];
  rpmA: number[];
  rpmB: number[];
  tireWearA?: number[];
  tireWearB?: number[];
}

export interface CornerDelta {
  label: string;
  deltaSeconds: number;
  timeA: number;
  timeB: number;
}

/** Canonical semantic values consumed by comparison/map UI. */
export interface SemanticTelemetrySample {
  values: Partial<Readonly<Record<TelemetryVariableId, number | boolean | string | null | readonly unknown[]>>>;
  sequence: string;
  observedAtMs: number;
}

export interface ComparisonData {
  lapA: LapMeta;
  lapB: LapMeta;
  traces: AlignedTrace;
  timeDelta: number[];
  corners: CornerDelta[];
  telemetryA: SemanticTelemetrySample[];
  telemetryB: SemanticTelemetrySample[];
}
