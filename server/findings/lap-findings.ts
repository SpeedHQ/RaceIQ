import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { LapQualityResult } from "../lap-analysis/quality";
import {
  adaptLapInsightsToFindingBundle,
  type LapFindingBundle,
} from "./lap-adapter";
import { adaptMetricsToFindings } from "./metrics-adapter";

export const DETERMINISTIC_LAP_FINDINGS_SOURCE_ID = "lap-metrics-v1";
export type LapFindingSource = LapMeta & {
  telemetry: ReadonlyArray<{ TimestampMS: number }>;
};

/** Build deterministic findings and linked prose for one authoritative lap assessment. */
export function buildDeterministicLapFindings(
  lap: LapFindingSource,
  insights: readonly LapInsight[],
  quality: LapQualityResult,
): LapFindingBundle {
  const lastFrameIndex = lap.telemetry.length - 1;
  const telemetryRange = lastFrameIndex >= 0
    ? {
        startFrameIndex: 0,
        endFrameIndex: lastFrameIndex,
        startTimestampMs: lap.telemetry[0].TimestampMS,
        endTimestampMs: lap.telemetry[lastFrameIndex].TimestampMS,
      }
    : undefined;
  const insightBundle = adaptLapInsightsToFindingBundle({
    sessionId: lap.sessionId,
    narrativeCreatedAt: lap.createdAt,
    lapId: lap.id,
    insights,
    quality,
    telemetryRange,
  });

  return {
    ...insightBundle,
    findings: [
      ...insightBundle.findings,
      ...adaptMetricsToFindings({
        sessionId: lap.sessionId,
        lapId: lap.id,
        fuelPerLap: lap.fuelPerLap,
        tyreWear: lap.tyreWear,
        quality,
      }),
    ],
  };
}
