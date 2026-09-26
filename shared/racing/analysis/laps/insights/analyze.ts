import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import { runInsightScan } from "./scan";
import type { LapAnalysisContext, LapInsight } from "./types";

/** Analyze prepared lap frames. Callers own any game-specific frame preparation. */
export function analyzeLap(telemetry: TelemetryPacket[], gameId: GameId, context?: LapAnalysisContext): LapInsight[] {
  return runInsightScan(telemetry, gameId, context);
}
