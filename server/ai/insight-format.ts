import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import type { LapQualitySummary } from "../../shared/racing/quality/contracts";
import { adaptLapInsightsToFindingBundle } from "../findings/lap-adapter";
import { buildFindingsContext } from "./findings-context";

export interface CompareInsightsIdentity {
  sessionId: string | number;
  lapId: string | number;
  lapTime: number;
  quality?: LapQualitySummary | null;
}

function finiteNumber(sample: SemanticTelemetrySample, semanticId: keyof SemanticTelemetrySample["values"]): number | null {
  const value = sample.values[semanticId];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function assessSemanticAnalysisInput(samples: readonly SemanticTelemetrySample[], gameId: GameId | undefined, lapTime: number): { valid: boolean; reason: string | null } {
  if (samples.length < 30) return { valid: false, reason: "too few telemetry packets" };

  const first = samples[0]!;
  const last = samples.at(-1)!;
  const firstDistance = finiteNumber(first, "timing.distance-traveled");
  const lastDistance = finiteNumber(last, "timing.distance-traveled");
  const lapDistance = firstDistance === null || lastDistance === null ? null : lastDistance - firstDistance;
  if (lapDistance !== null && lapDistance < 100) return { valid: false, reason: "telemetry distance too short" };

  let peakLapTime: number | null = null;
  for (const sample of samples) {
    const lapTimeValue = finiteNumber(sample, "timing.current-lap");
    if (lapTimeValue !== null && (peakLapTime === null || lapTimeValue > peakLapTime)) peakLapTime = lapTimeValue;
  }
  if (peakLapTime !== null && peakLapTime > 0 && Math.abs(peakLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }

  if (gameId === "acc" && finiteNumber(first, "timing.lap-number") === 0 && lapTime < 30) {
    return { valid: false, reason: "starting lap" };
  }

  const firstX = finiteNumber(first, "motion.position-x");
  const firstZ = finiteNumber(first, "motion.position-z");
  const lastX = finiteNumber(last, "motion.position-x");
  const lastZ = finiteNumber(last, "motion.position-z");
  if (gameId !== "acc" && lapDistance !== null && firstX !== null && firstZ !== null && lastX !== null && lastZ !== null) {
    const gap = Math.hypot(lastX - firstX, lastZ - firstZ);
    if (gap > lapDistance * 0.15 && gap > 100) return { valid: false, reason: "start/end positions too far apart" };
  }

  return { valid: true, reason: null };
}

/** Adapt authoritative LapInsight output into deterministic compare context. */
export function buildCompareInsightsBlock(
  label: string,
  samples: readonly SemanticTelemetrySample[],
  gameId: GameId | undefined,
  identity?: CompareInsightsIdentity,
  analyze: typeof analyzeLap = analyzeLap,
): string {
  if (!identity) return "";
  const quality = assessSemanticAnalysisInput(samples, gameId, identity.lapTime);
  const qualityAbstention = quality.valid ? "" : `[ABSTENTION] ${label} recording quality rejected: ${quality.reason ?? "unknown reason"}; do not make lap-performance claims from this telemetry.`;
  if (!gameId || samples.length === 0) return qualityAbstention ? `\n${qualityAbstention}\n` : "";
  const bundle = adaptLapInsightsToFindingBundle({
    gameId,
    sessionId: identity.sessionId,
    lapId: identity.lapId,
    insights: analyze(samples, gameId, identity.quality),
    quality,
  });
  const context = [
    qualityAbstention,
    buildFindingsContext(bundle.findings, {
      label,
      narratives: bundle.narratives,
      recommendations: bundle.recommendations,
    }),
  ]
    .filter(Boolean)
    .join("\n");
  return context ? `\n${context}\n` : "";
}
