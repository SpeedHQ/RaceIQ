import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";

import type { GameId } from "../../shared/games/ids";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { FindingRecord } from "../../shared/racing/findings/types";
import { createFindingId } from "../../shared/racing/findings/identity";
import type { EligibilityDecision, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent, isEligibilityUsable } from "../../shared/racing/quality/policies";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { LapQualityResult } from "../lap-analysis/quality";
import { adaptLapInsightsToFindingBundle, type LapFindingBundle } from "./lap-adapter";
import { adaptMetricsToFindings } from "./metrics-adapter";

export type LapFindingSource = Omit<LapMeta, "gameId" | "quality"> & {
  gameId: GameId;
  quality: LapQualitySummary;
  telemetry: readonly SemanticTelemetrySample[];
};

function restrictInsightFindings(bundle: LapFindingBundle, lap: LapFindingSource, decision: EligibilityDecision | null): LapFindingBundle {
  if (!decision || isEligibilityUsable(decision)) return bundle;
  const sessionId = String(lap.sessionId);
  const lapId = String(lap.id);
  const qualityRef = {
    kind: "quality-decision" as const,
    id: `eligibility:${lapId}:${decision.policyId}:${decision.status}`,
    sessionId,
    decisionId: `eligibility:${lapId}:${decision.policyId}`,
    decision: decision.status,
  };
  const remappedIds = new Map<string, string>();
  const findings = bundle.findings.map((finding): FindingRecord => {
    if (finding.type !== "lap-insight" || finding.status !== "available") {
      return finding;
    }
    const restricted: FindingRecord = {
      ...finding,
      status: "indeterminate",
      confidence: "unknown",
      measurements: finding.measurements.map((measurement) => ({
        ...measurement,
        confidence: "unknown",
      })),
      evidenceRefs: [...finding.evidenceRefs, qualityRef],
      qualityRefs: [...finding.qualityRefs, qualityRef],
      limitations: [
        ...finding.limitations,
        {
          code: `quality-policy-${decision.policyId}-${decision.status}`,
          detail: `finalized ${decision.policyId} policy is ${decision.status}`,
          evidenceRefs: [qualityRef],
        },
      ],
      rule: {
        ...finding.rule,
        inputs: {
          ...finding.rule.inputs,
          finalizedPolicyStatus: decision.status,
        },
      },
    };
    restricted.id = createFindingId(restricted);
    remappedIds.set(finding.id, restricted.id);
    return restricted;
  });
  const remap = (id: string) => remappedIds.get(id) ?? id;
  return {
    ...bundle,
    findings,
    narratives: bundle.narratives.map((narrative) => {
      const findingIds = narrative.findingIds.map(remap);
      const remappedFindingId = remappedIds.get(narrative.findingIds[0] ?? "");
      return {
        ...narrative,
        id: remappedFindingId && narrative.id.startsWith(`${narrative.findingIds[0]}:`) ? `${remappedFindingId}:${narrative.id.slice(narrative.findingIds[0]!.length + 1)}` : narrative.id,
        findingIds,
      };
    }),
    recommendations: bundle.recommendations.map((recommendation) => ({
      ...recommendation,
      supportingFindingIds: recommendation.supportingFindingIds.map(remap),
    })),
  };
}

/** Build deterministic findings and linked prose for one authoritative lap assessment. */
export function buildDeterministicLapFindings(lap: LapFindingSource, insights: readonly LapInsight[], recordingQuality: LapQualityResult, analysisGenerationId: string): LapFindingBundle {
  const lastFrameIndex = lap.telemetry.length - 1;
  const telemetryRange =
    lastFrameIndex >= 0
      ? {
          startFrameIndex: 0,
          endFrameIndex: lastFrameIndex,
          startTimestampMs: lap.telemetry[0].observedAtMs,
          endTimestampMs: lap.telemetry[lastFrameIndex].observedAtMs,
        }
      : undefined;
  const finalizedEligibility = isEligibilitySnapshotCurrent(lap) ? lap.eligibility : undefined;
  const insightBundle = restrictInsightFindings(
    adaptLapInsightsToFindingBundle({
      gameId: lap.gameId,
      sessionId: lap.sessionId,
      narrativeCreatedAt: lap.createdAt,
      lapId: lap.id,
      insights,
      quality: recordingQuality,
      telemetryRange,
      analysisGenerationId,
    }),
    lap,
    finalizedEligibility?.["corner-trace"] ?? null,
  );

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
        finalizedPolicyDecisions: {
          "fuel-per-lap": finalizedEligibility?.["fuel-burn"],
          "tyre-wear": finalizedEligibility?.["tire-analysis"],
        },
        analysisGenerationId,
      }),
    ],
  };
}
