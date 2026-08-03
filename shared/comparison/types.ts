import type { LapMeta } from "../sessions/types";
import type { TelemetryPacket } from "../telemetry/types";
export interface AlignedTrace {
  distance: number[];
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
  timeA: number; // section time for lap A in seconds
  timeB: number; // section time for lap B in seconds
}

export interface ComparisonData {
  lapA: LapMeta;
  lapB: LapMeta;
  traces: AlignedTrace;
  timeDelta: number[]; // cumulative time gain/loss at each distance point
  corners: CornerDelta[];
  telemetryA: TelemetryPacket[];
  telemetryB: TelemetryPacket[];
}
