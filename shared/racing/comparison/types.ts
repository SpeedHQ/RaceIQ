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
  steerA: number[];
  steerB: number[];
  gearA: number[];
  gearB: number[];
  rpmA: number[];
  rpmB: number[];
  positionXA: number[];
  positionXB: number[];
  positionZA: number[];
  positionZB: number[];
  yawA: number[];
  yawB: number[];
  elapsedTimeA: number[];
  elapsedTimeB: number[];
  tireWearA?: number[];
  tireWearB?: number[];
}

export interface CornerDelta {
  label: string;
  deltaSeconds: number;
  timeA: number;
  timeB: number;
}

export interface ComparisonData {
  lapA: LapMeta;
  lapB: LapMeta;
  traces: AlignedTrace;
  timeDelta: number[];
  corners: CornerDelta[];
  gameId?: string;
}

export interface ComparisonRangeData {
  distanceStart: number;
  distanceEnd: number;
  stepMeters: number;
  traces: AlignedTrace;
  timeDelta: number[];
}
