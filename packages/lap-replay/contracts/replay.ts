import type { LmuLiveContextWire } from "@raceiq/shared/telemetry/lmu-context";
import type { LapDetectorCoverage, LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";

export interface SemanticReplayFrame {
  sequence: number;
  observedAt: { domain: string; milliseconds: number };
  receivedAt: { domain: string; milliseconds: number };
  simulator: string;
  values: Array<{ semanticId: string; value: unknown; unit?: string | null; state?: string; freshness?: string }>;
  lmu?: LmuLiveContextWire;
}
export interface SemanticLapTelemetry {
  lapId: number;
  requestedSemanticIds: readonly string[];
  sectorTimes?: number[] | null;
  sectorStarts?: number[] | null;
  insights?: LapInsight[];
  detectorCoverage?: LapDetectorCoverage[];
  parseError?: string | null;
  envelopes: SemanticReplayFrame[];
}
