import type {
  CanonicalJson,
  FindingConfidence,
  FindingEvidenceRef,
  FindingNarrative,
  FindingRecommendation,
  FindingRecord,
  FindingSeverity,
  FindingStatus,
} from "../../shared/racing/findings/types";
import { FINDING_SCHEMA_VERSION } from "../../shared/racing/findings/types";
import { createFindingId } from "../../shared/racing/findings/identity";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { LapQualityResult } from "../lap-analysis/quality";

export interface LapTelemetryRange {
  startFrameIndex?: number;
  endFrameIndex?: number;
  startTimestampMs?: number;
  endTimestampMs?: number;
}

export interface LapInsightsFindingContext {
  sessionId: string | number;
  lapId: string | number;
  insights: readonly LapInsight[];
  quality?: LapQualityResult | null;
  telemetryRange?: LapTelemetryRange;
  narrativeCreatedAt?: string;
  analysisGenerationId?: string;
  ruleVersion?: string | number;
}

export interface LapFindingBundle {
  findings: FindingRecord[];
  narratives: FindingNarrative[];
  recommendations: FindingRecommendation[];
}

const DEFAULT_GENERATION = "lap-metrics-v1";
const RULE_ID = "lap-insight-adapter";
const QUALITY_RULE_ID = "lap-quality-adapter";
const QUALITY_REASON_CODE: Readonly<Record<string, string>> = {
  "too few telemetry packets": "too-few-packets",
  "telemetry distance too short": "distance-too-short",
  "telemetry lap time mismatch": "lap-time-mismatch",
  "starting lap": "starting-lap",
  "start/end positions too far apart": "start-end-gap",
};

function severityFor(value: LapInsight["severity"]): FindingSeverity {
  if (value === "critical") return "critical";
  if (value === "warning") return "medium";
  return "informational";
}

function confidenceFor(status: FindingStatus): FindingConfidence {
  return status === "available" ? "high" : "unknown";
}

function rangeEvidence(
  sessionId: string,
  range: LapTelemetryRange | undefined,
  id: string,
): FindingEvidenceRef[] {
  if (!range || (
    range.startFrameIndex == null &&
    range.endFrameIndex == null &&
    range.startTimestampMs == null &&
    range.endTimestampMs == null
  )) return [];
  return [{
    kind: "telemetry-range",
    id,
    sessionId,
    ...(range.startFrameIndex == null ? {} : { startFrameIndex: range.startFrameIndex }),
    ...(range.endFrameIndex == null ? {} : { endFrameIndex: range.endFrameIndex }),
    ...(range.startTimestampMs == null ? {} : { startTimestampMs: range.startTimestampMs }),
    ...(range.endTimestampMs == null ? {} : { endTimestampMs: range.endTimestampMs }),
  }];
}

export function createLapQualityEvidence(
  sessionId: string,
  lapId: string,
  quality: LapQualityResult,
): FindingEvidenceRef {
  const decision = quality.valid ? "valid" : "suppressed";
  const reasonCode = quality.reason == null ? "none" : QUALITY_REASON_CODE[quality.reason] ?? "rejected";
  const decisionId = `quality:${lapId}:${decision}:${reasonCode}`;
  return {
    kind: "quality-decision",
    id: decisionId,
    sessionId,
    decisionId,
    decision,
  };
}

export function adaptLapInsightsToFindingBundle(context: LapInsightsFindingContext): LapFindingBundle {
  const sessionId = String(context.sessionId);
  const lapId = String(context.lapId);
  const generation = context.analysisGenerationId ?? DEFAULT_GENERATION;
  const ruleVersion = String(context.ruleVersion ?? "1");
  const lapEvidence: FindingEvidenceRef = { kind: "lap", id: `lap:${lapId}`, lapId, sessionId };
  const qualityRef = context.quality && !context.quality.valid
    ? createLapQualityEvidence(sessionId, lapId, context.quality)
    : undefined;
  const output: FindingRecord[] = [];
  const narratives: FindingNarrative[] = [];

  for (const insight of context.insights) {
    const frameIndices = [...new Set(insight.frameIndices.filter((frame) => Number.isInteger(frame) && frame >= 0))];
    const eventId = `event:${lapId}:${insight.id}`;
    const evidenceRefs: FindingEvidenceRef[] = [lapEvidence, {
      kind: "event",
      id: eventId,
      eventId,
      sessionId,
      semanticIds: [`finding.lap-insight.${insight.id}`],
    }];
    if (frameIndices.length > 0) {
      for (const frameIndex of frameIndices) {
        evidenceRefs.push(...rangeEvidence(
          sessionId,
          { startFrameIndex: frameIndex, endFrameIndex: frameIndex },
          `range:${eventId}:frame:${frameIndex}`,
        ));
      }
    } else {
      evidenceRefs.push(...rangeEvidence(sessionId, context.telemetryRange, `range:${eventId}`));
    }
    if (qualityRef) evidenceRefs.push(qualityRef);

    const suppressed = context.quality != null && !context.quality.valid;
    const status: FindingStatus = suppressed ? "indeterminate" : "available";
    const limitations = suppressed
      ? [{
          code: "quality-suppressed",
          detail: context.quality?.reason ?? "lap recording quality rejected",
          evidenceRefs: qualityRef ? [qualityRef] : undefined,
        }]
      : [];
    const occurrenceCount = Math.max(1, frameIndices.length);
    const measurements = [{
      id: `${eventId}:occurrence-count`,
      type: "occurrence-count",
      value: occurrenceCount,
      unit: "count",
      sampleCount: occurrenceCount,
      confidence: confidenceFor(status),
      semanticIds: [`finding.lap-insight.${insight.id}`],
      derivation: { id: RULE_ID, version: ruleVersion },
    }, ...(insight.timeLossS == null ? [] : [{
      id: `${eventId}:time-loss`,
      type: "time-loss",
      value: insight.timeLossS,
      unit: "s",
      sampleCount: occurrenceCount,
      confidence: confidenceFor(status),
      semanticIds: ["timing.time-loss"],
      derivation: { id: RULE_ID, version: ruleVersion },
    }])];
    const inputs: Record<string, CanonicalJson> = {
      insightId: insight.id,
      detectorCategory: insight.category,
      source: "LapInsight",
    };
    if (suppressed) inputs.qualityValid = false;
    const recordBase: Omit<FindingRecord, "id"> = {
      schemaVersion: FINDING_SCHEMA_VERSION,
      type: "lap-insight",
      category: insight.category,
      scope: { kind: "lap", sessionId, lapId },
      status,
      severity: severityFor(insight.severity),
      confidence: confidenceFor(status),
      measurements,
      evidenceRefs,
      qualityRefs: qualityRef ? [qualityRef] : [],
      limitations,
      rule: { id: RULE_ID, version: ruleVersion, inputs },
      analysisGenerationId: generation,
      title: insight.label,
    };
    const finding: FindingRecord = {
      ...recordBase,
      id: createFindingId({
        type: recordBase.type,
        scope: recordBase.scope,
        evidenceRefs,
        analysisGenerationId: generation,
        ruleVersion,
      }),
    };
    output.push(finding);
    narratives.push({
      id: `${finding.id}:lap-insight-detail`,
      findingIds: [finding.id],
      text: insight.detail,
      generator: RULE_ID,
      generationId: generation,
      ...(context.narrativeCreatedAt == null ? {} : { createdAt: context.narrativeCreatedAt }),
    });
  }

  if (context.quality && !context.quality.valid && qualityRef) {
    const evidenceRefs: FindingEvidenceRef[] = [lapEvidence, qualityRef];
    const recordBase: Omit<FindingRecord, "id"> = {
      schemaVersion: FINDING_SCHEMA_VERSION,
      type: "lap-quality",
      category: "quality",
      scope: { kind: "lap", sessionId, lapId },
      status: "available",
      severity: "high",
      confidence: "high",
      measurements: [{
        id: `quality:${lapId}:valid`,
        type: "quality-valid",
        value: false,
        unit: "boolean",
        sampleCount: 1,
        confidence: "high",
        semanticIds: ["quality.lap-recording"],
        derivation: { id: QUALITY_RULE_ID, version: ruleVersion },
      }],
      evidenceRefs,
      qualityRefs: [qualityRef],
      limitations: [{ code: "quality-rejected", detail: context.quality.reason ?? "lap recording quality rejected" }],
      rule: { id: QUALITY_RULE_ID, version: ruleVersion, inputs: { source: "LapQualityResult" } },
      analysisGenerationId: generation,
      title: "Lap recording quality rejected",
    };
    output.push({
      ...recordBase,
      id: createFindingId({
        type: recordBase.type,
        scope: recordBase.scope,
        evidenceRefs,
        analysisGenerationId: generation,
        ruleVersion,
      }),
    });
  }

  return { findings: output, narratives, recommendations: [] };
}

export function adaptLapInsightsToFindings(context: LapInsightsFindingContext): FindingRecord[] {
  return adaptLapInsightsToFindingBundle(context).findings;
}
