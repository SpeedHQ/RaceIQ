import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import type { LapQualitySummary } from "../../shared/racing/quality/contracts";
import { adaptLapInsightsToFindingBundle } from "../findings/lap-adapter";
import { assessLapRecording } from "../lap-analysis/quality";
import { buildFindingsContext } from "./findings-context";

export interface CompareInsightsIdentity {
  sessionId: string | number;
  lapId: string | number;
  lapTime: number;
  quality?: LapQualitySummary | null;
}

/** Adapt authoritative LapInsight output into deterministic compare context. */
export function buildCompareInsightsBlock(
  label: string,
  packets: TelemetryPacket[],
  gameId: GameId | undefined,
  identity?: CompareInsightsIdentity,
): string {
  if (!identity) return "";
  const quality = assessLapRecording(packets, identity.lapTime);
  const qualityAbstention = quality.valid
    ? ""
    : `[ABSTENTION] ${label} recording quality rejected: ${quality.reason ?? "unknown reason"}; do not make lap-performance claims from this telemetry.`;
  if (!gameId || packets.length === 0) return qualityAbstention ? `\n${qualityAbstention}\n` : "";
  const bundle = adaptLapInsightsToFindingBundle({
    gameId,
    sessionId: identity.sessionId,
    lapId: identity.lapId,
    insights: analyzeLap(packets, gameId, identity.quality),
    quality,
  });
  const context = [
    qualityAbstention,
    buildFindingsContext(bundle.findings, {
      label,
      narratives: bundle.narratives,
      recommendations: bundle.recommendations,
    }),
  ].filter(Boolean).join("\n");
  return context ? `\n${context}\n` : "";
}
