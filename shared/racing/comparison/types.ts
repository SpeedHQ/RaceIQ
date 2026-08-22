import type { GameId } from "../../games/ids";
import type { TelemetryVariableId } from "../../telemetry/catalog/generated/telemetry-catalog.types";
import type { LapMeta } from "../sessions/types";
import type { FindingGenerationReceipt, FindingRecord } from "../findings/types";

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
  /** Exact aligned-grid bounds used to calculate this corner delta. */
  distanceStart: number;
  distanceEnd: number;
  alignedStartIndex: number | null;
  alignedEndIndex: number | null;
  /** Exact source-frame bounds corresponding to aligned-grid bounds. */
  sourceStartIndexA: number | null;
  sourceEndIndexA: number | null;
  sourceStartIndexB: number | null;
  sourceEndIndexB: number | null;
}

/** Canonical semantic values consumed by comparison/map UI. */
export interface SemanticTelemetrySample {
  values: Partial<Readonly<Record<TelemetryVariableId, number | boolean | string | null | readonly unknown[]>>>;
  sequence: string;
  observedAtMs: number;
}

export type ComparisonLap = Pick<LapMeta, "id" | "sessionId" | "lapNumber" | "lapTime" | "isValid" | "trackOrdinal" | "carOrdinal">;

export type ComparisonFindingReceipt = Pick<FindingGenerationReceipt, "generationId" | "contentHash" | "status">;

export interface ComparisonFindingReceipts {
  lapA: ComparisonFindingReceipt;
  lapB: ComparisonFindingReceipt;
}

export interface ComparisonData {
  lapA: ComparisonLap;
  lapB: ComparisonLap;
  traces: AlignedTrace;
  timeDelta: number[];
  corners: CornerDelta[];
  telemetryA: SemanticTelemetrySample[];
  telemetryB: SemanticTelemetrySample[];
  findings: FindingRecord[];
  findingReceipts: ComparisonFindingReceipts;
  gameId: GameId;
}
