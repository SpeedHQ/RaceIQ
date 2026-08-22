import type { GameId } from "../../shared/games/ids";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { LapQualityResult } from "../lap-analysis/quality";
import {
  adaptLapInsightsToFindingBundle,
  type LapFindingBundle,
} from "./lap-adapter";
import { adaptMetricsToFindings } from "./metrics-adapter";

export type LapFindingSource = Omit<LapMeta, "gameId"> & {
  gameId: GameId;
  telemetry: ReadonlyArray<{ TimestampMS: number }>;
};

/** Build deterministic findings and linked prose for one authoritative lap assessment. */
export function buildDeterministicLapFindings(
  lap: LapFindingSource,
  insights: readonly LapInsight[],
  recordingQuality: LapQualityResult,
  analysisGenerationId: string,
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
    gameId: lap.gameId,
    sessionId: lap.sessionId,
    narrativeCreatedAt: lap.createdAt,
    lapId: lap.id,
    insights,
    quality: recordingQuality,
    telemetryRange,
    analysisGenerationId,
  });

  return {
    ...insightBundle,
    findings: [
      ...insightBundle.findings,
      ...adaptMetricsToFindings({
        gameId: lap.gameId,
        sessionId: lap.sessionId,
        lapId: lap.id,
        fuelPerLap: lap.fuelPerLap,
        tyreWear: lap.tyreWear,
        quality: recordingQuality,
        analysisGenerationId,
      }),
    ],
  };
}
