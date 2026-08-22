import type { GameId } from "../../shared/games/ids";
import type { EligibilityDecision } from "../../shared/racing/quality/contracts";
import { isEligibilityUsable } from "../../shared/racing/quality/policies";

import { INPUT_VAR_THRESHOLD, LINE_SPREAD_THRESHOLD_M, type LapConsistencyDelta, type LineSpreadTrace } from "../lap-analysis/consistency";
import type { SegmentStat } from "../lap-analysis/metrics";
import type { LapQualityResult } from "../lap-analysis/quality";
import { createLapQualityEvidence } from "./lap-adapter";
import type { CanonicalJson, FindingConfidence, FindingEvidenceRef, FindingLimitation, FindingMeasurement, FindingRecord, FindingStatus } from "../../shared/racing/findings/types";
import { FINDING_SCHEMA_VERSION } from "../../shared/racing/findings/types";
import { createFindingId } from "../../shared/racing/findings/identity";

export interface MetricsFindingContext {
  gameId: GameId;
  sessionId: string | number;
  lapId: string | number;
  selectedLapIds?: readonly (string | number)[];
  segmentStats?: readonly SegmentStat[];
  fuelPerLap?: number | null;
  tyreWear?: number | null;
  quality: LapQualityResult;
  consistency?: LineSpreadTrace | LapConsistencyDelta | null;
  fallbackReasons?: readonly string[];
  lowTrustReasons?: readonly string[];
  finalizedPolicyDecisions?: Partial<Record<"fuel-per-lap" | "tyre-wear", EligibilityDecision>>;
  analysisGenerationId?: string;
  ruleVersion?: string | number;
  segmentAlgorithmVersion?: string | number;
}

const RULE_ID = "lap-metrics-adapter";
const DEFAULT_GENERATION = "lap-metrics-v1";

function confidenceFor(status: FindingStatus, lowTrust: boolean): FindingConfidence {
  if (status !== "available") return "unknown";
  return lowTrust ? "low" : "high";
}

function lapEvidence(sessionId: string, lapIds: readonly string[]): FindingEvidenceRef[] {
  return lapIds.map((lapId) => ({ kind: "lap", id: `lap:${lapId}`, lapId, sessionId }));
}

function reasonLimitations(prefix: "fallback-source" | "low-trust", reasons: readonly string[]): FindingLimitation[] {
  const byCode = new Map<string, FindingLimitation>();
  for (const detail of [...new Set(reasons)].sort((left, right) => left.localeCompare(right))) {
    const suffix =
      detail
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "unspecified";
    byCode.set(`${prefix}:${suffix}`, { code: `${prefix}:${suffix}`, detail });
  }
  return [...byCode.values()];
}

function limitationsFor(fallbackReasons: readonly string[], lowTrustReasons: readonly string[]): FindingLimitation[] {
  return [...reasonLimitations("fallback-source", fallbackReasons), ...reasonLimitations("low-trust", lowTrustReasons)];
}

function finishRecord(record: Omit<FindingRecord, "id">): FindingRecord {
  return {
    ...record,
    id: createFindingId({
      type: record.type,
      scope: record.scope,
      evidenceRefs: record.evidenceRefs,
      analysisGenerationId: record.analysisGenerationId,
      ruleVersion: record.rule.version,
      comparisonReferenceId: record.comparisonReference?.id,
    }),
  };
}

function metricRecord(
  context: {
    gameId: GameId;
    sessionId: string;
    lapId: string;
    generation: string;
    ruleVersion: string;
    evidenceRefs: FindingEvidenceRef[];
    limitations: FindingLimitation[];
    lowTrust: boolean;
    quality: LapQualityResult;
    legacyQualityRef?: FindingEvidenceRef;
    finalizedPolicyDecisions?: Partial<Record<"fuel-per-lap" | "tyre-wear", EligibilityDecision>>;
  },
  metric: {
    type: "fuel-per-lap" | "tyre-wear";
    category: "fuel" | "tires";
    value: number | null | undefined;
    unit: "L" | "%";
    semanticIds: string[];
    title: string;
  },
): FindingRecord {
  const available = typeof metric.value === "number" && Number.isFinite(metric.value);
  const policyDecision = context.finalizedPolicyDecisions?.[metric.type];
  const legacyRejected = !context.quality.valid;
  const policyRejected = policyDecision != null && !isEligibilityUsable(policyDecision);
  const policyQualityRef = policyRejected
    ? {
        kind: "quality-decision" as const,
        id: `eligibility:${context.lapId}:${policyDecision!.policyId}:${policyDecision!.status}`,
        sessionId: context.sessionId,
        decisionId: `eligibility:${context.lapId}:${policyDecision!.policyId}`,
        decision: policyDecision!.status,
      }
    : undefined;
  const qualityRefs = [...(context.legacyQualityRef ? [context.legacyQualityRef] : []), ...(policyQualityRef ? [policyQualityRef] : [])];
  const restricted = legacyRejected || policyRejected;
  const status: FindingStatus = !available ? "unavailable" : restricted ? "indeterminate" : "available";
  const unavailableReason = metric.type === "fuel-per-lap" ? "fuel-per-lap-source-unavailable" : "tyre-wear-source-unavailable";
  const limitations = [
    ...(legacyRejected
      ? [
          {
            code: "quality-rejected",
            detail: context.quality?.reason ?? "lap recording quality rejected",
            evidenceRefs: qualityRefs,
          },
        ]
      : []),
    ...(policyRejected
      ? [
          {
            code: `quality-policy-${policyDecision!.policyId}-${policyDecision!.status}`,
            detail: `finalized ${policyDecision!.policyId} policy is ${policyDecision!.status}`,
            evidenceRefs: qualityRefs,
          },
        ]
      : []),
    ...(available ? [] : [{ code: unavailableReason, detail: "source aggregate was undefined" }]),
    ...context.limitations,
  ];
  const measurement: FindingMeasurement = {
    id: `${metric.type}:${context.lapId}`,
    type: metric.type,
    value: available ? (metric.value as number) : null,
    unit: metric.unit,
    sampleCount: available ? 1 : 0,
    confidence: confidenceFor(status, context.lowTrust),
    semanticIds: metric.semanticIds,
    derivation: { id: RULE_ID, version: context.ruleVersion },
    ...(available ? {} : { unavailableReason }),
  };
  const inputs: Record<string, CanonicalJson> = {
    source: metric.type === "fuel-per-lap" ? "LapMetric.fuelPerLap" : "LapMetric.tyreWear",
  };
  if (legacyRejected) inputs.qualityValid = false;
  if (policyRejected) inputs.finalizedPolicyStatus = policyDecision!.status;
  return finishRecord({
    schemaVersion: FINDING_SCHEMA_VERSION,
    type: metric.type,
    category: metric.category,
    scope: { kind: "lap", gameId: context.gameId, sessionId: context.sessionId, lapId: context.lapId },
    status,
    severity: "informational",
    confidence: confidenceFor(status, context.lowTrust),
    measurements: [measurement],
    evidenceRefs: [...context.evidenceRefs, ...qualityRefs],
    qualityRefs,
    limitations,
    rule: {
      id: RULE_ID,
      version: context.ruleVersion,
      inputs,
    },
    analysisGenerationId: context.generation,
    title: metric.title,
  });
}

function segmentMeasurements(segment: SegmentStat, version: string, segmentId: string): FindingMeasurement[] {
  const definitions: Array<[string, number | null, string, string[]]> = [
    ["segment-time", segment.timeSec, "s", ["timing.current-lap"]],
    ["minimum-speed", segment.stats.minSpeed, "km/h", ["motion.speed"]],
    ["maximum-speed", segment.stats.maxSpeed, "km/h", ["motion.speed"]],
    ["average-throttle", segment.stats.throttleAvg, "ratio", ["inputs.accel"]],
    ["average-brake", segment.stats.brakeAvg, "ratio", ["inputs.brake"]],
    ["brake-applications", segment.stats.brakeApplications, "count", ["inputs.brake"]],
    ["steering-smoothness", segment.stats.steeringSmoothness, "ratio", ["inputs.steer"]],
  ];
  return definitions.map(([type, value, unit, semanticIds]) => ({
    id: `segment:${segmentId}:${type}`,
    type,
    value,
    unit,
    sampleCount: 1,
    confidence: "high",
    semanticIds,
    derivation: { id: RULE_ID, version },
  }));
}

function isLineSpreadTrace(value: LineSpreadTrace | LapConsistencyDelta): value is LineSpreadTrace {
  return "lapCount" in value;
}

export function adaptMetricsToFindings(context: MetricsFindingContext): FindingRecord[] {
  const sessionId = String(context.sessionId);
  const lapId = String(context.lapId);
  const selectedLapIds = [...new Set((context.selectedLapIds ?? [lapId]).map(String))];
  if (!selectedLapIds.includes(lapId)) selectedLapIds.push(lapId);
  selectedLapIds.sort((left, right) => left.localeCompare(right));
  const evidenceRefs = lapEvidence(sessionId, selectedLapIds);
  const fallbackReasons = context.fallbackReasons ?? [];
  const lowTrustReasons = context.lowTrustReasons ?? [];
  const sharedLimitations = limitationsFor(fallbackReasons, lowTrustReasons);
  const lowTrust = lowTrustReasons.length > 0;
  const generation = context.analysisGenerationId ?? DEFAULT_GENERATION;
  const ruleVersion = String(context.ruleVersion ?? context.segmentAlgorithmVersion ?? "1");
  const legacyQualityRef = !context.quality.valid ? createLapQualityEvidence(sessionId, lapId, context.quality) : undefined;
  const common = {
    gameId: context.gameId,
    sessionId,
    lapId,
    generation,
    ruleVersion,
    evidenceRefs,
    limitations: sharedLimitations,
    lowTrust,
    quality: context.quality,
    legacyQualityRef,
    finalizedPolicyDecisions: context.finalizedPolicyDecisions,
  };
  const output: FindingRecord[] = [
    metricRecord(common, {
      type: "fuel-per-lap",
      category: "fuel",
      value: context.fuelPerLap,
      unit: "L",
      semanticIds: ["fuel.fuel"],
      title: "Fuel used per lap",
    }),
    metricRecord(common, {
      type: "tyre-wear",
      category: "tires",
      value: context.tyreWear,
      unit: "%",
      semanticIds: ["tires.tire-wear"],
      title: "Worst tyre wear",
    }),
  ];

  for (const [index, segment] of (context.segmentStats ?? []).entries()) {
    const segmentId = `${lapId}:${segment.number ?? (segment.name || index + 1)}`;
    const segmentEvidence: FindingEvidenceRef = {
      kind: "segment",
      id: `segment:${segmentId}`,
      segmentId,
      lapId,
      sessionId,
    };
    const segmentEvidenceRefs = [...evidenceRefs, segmentEvidence];
    const inputs: Record<string, CanonicalJson> = {
      source: "SegmentStat",
      startFraction: segment.startFrac,
      endFraction: segment.endFrac,
      algorithmVersion: context.segmentAlgorithmVersion == null ? ruleVersion : String(context.segmentAlgorithmVersion),
    };
    if (segment.number != null) inputs.segmentNumber = segment.number;
    if (segment.covers) inputs.coveredCorners = segment.covers;
    output.push(
      finishRecord({
        schemaVersion: FINDING_SCHEMA_VERSION,
        type: "segment-performance",
        category: "driving",
        scope: { kind: "segment", gameId: context.gameId, sessionId, lapId, segmentId },
        status: "available",
        severity: "informational",
        confidence: confidenceFor("available", lowTrust),
        measurements: segmentMeasurements(segment, ruleVersion, segmentId),
        evidenceRefs: segmentEvidenceRefs,
        qualityRefs: [],
        limitations: sharedLimitations,
        rule: { id: RULE_ID, version: ruleVersion, inputs },
        analysisGenerationId: generation,
        title: `${segment.name} segment metrics`,
      }),
    );
  }

  if (context.consistency) {
    const trace = context.consistency;
    const aggregate = isLineSpreadTrace(trace)
      ? {
          lateralSpreadM: trace.overallSpreadM,
          lowTrust: trace.lowTrust,
          sampleCount: trace.lapCount,
          consistencyScore: trace.consistencyScore,
          brakeVar: null,
          throttleVar: null,
        }
      : {
          lateralSpreadM: trace.overall.lateralSpreadM,
          lowTrust: trace.overall.lowTrust,
          sampleCount: selectedLapIds.length,
          consistencyScore: null,
          brakeVar: trace.overall.brakeVar,
          throttleVar: trace.overall.throttleVar,
        };
    const consistencyLimitations = aggregate.lowTrust ? [{ code: "low-trust-consistency", detail: "source consistency aggregate marked low trust" }, ...sharedLimitations] : sharedLimitations;
    const consistencyEvidence: FindingEvidenceRef = {
      kind: "measurement",
      id: `consistency:${selectedLapIds.join(",")}`,
      measurementId: "lap-consistency",
      sessionId,
    };
    const consistencyEvidenceRefs = [...evidenceRefs, consistencyEvidence];
    const measurements: FindingMeasurement[] = [
      {
        id: `consistency:${lapId}:lateral-spread`,
        type: "lateral-line-spread",
        value: aggregate.lateralSpreadM,
        unit: "m",
        sampleCount: aggregate.sampleCount,
        confidence: aggregate.lowTrust ? "low" : "high",
        semanticIds: ["motion.position-x", "motion.position-z"],
        derivation: { id: RULE_ID, version: ruleVersion },
      },
    ];
    if (aggregate.consistencyScore != null)
      measurements.push({
        id: `consistency:${lapId}:score`,
        type: "line-consistency-score",
        value: aggregate.consistencyScore,
        unit: "score-0-100",
        sampleCount: aggregate.sampleCount,
        confidence: aggregate.lowTrust ? "low" : "high",
        semanticIds: ["motion.position-x", "motion.position-z"],
        derivation: { id: RULE_ID, version: ruleVersion },
      });
    if (aggregate.brakeVar != null)
      measurements.push({
        id: `consistency:${lapId}:brake-variance`,
        type: "brake-variance",
        value: aggregate.brakeVar,
        unit: "variance",
        sampleCount: aggregate.sampleCount,
        confidence: aggregate.lowTrust ? "low" : "high",
        semanticIds: ["inputs.brake"],
        derivation: { id: RULE_ID, version: ruleVersion },
      });
    if (aggregate.throttleVar != null)
      measurements.push({
        id: `consistency:${lapId}:throttle-variance`,
        type: "throttle-variance",
        value: aggregate.throttleVar,
        unit: "variance",
        sampleCount: aggregate.sampleCount,
        confidence: aggregate.lowTrust ? "low" : "high",
        semanticIds: ["inputs.accel"],
        derivation: { id: RULE_ID, version: ruleVersion },
      });
    output.push(
      finishRecord({
        schemaVersion: FINDING_SCHEMA_VERSION,
        type: "lap-consistency",
        category: "consistency",
        scope: { kind: "lap", gameId: context.gameId, sessionId, lapId },
        status: "available",
        severity: aggregate.lowTrust ? "low" : "informational",
        confidence: aggregate.lowTrust ? "low" : "high",
        measurements,
        evidenceRefs: consistencyEvidenceRefs,
        qualityRefs: [],
        limitations: consistencyLimitations,
        rule: {
          id: RULE_ID,
          version: ruleVersion,
          inputs: {
            source: isLineSpreadTrace(trace) ? "LineSpreadTrace" : "LapConsistencyDelta",
            selectedLapIds,
            lineSpreadThresholdM: LINE_SPREAD_THRESHOLD_M,
            inputVarianceThreshold: INPUT_VAR_THRESHOLD,
          },
        },
        analysisGenerationId: generation,
        title: "Lap consistency",
      }),
    );
  }

  return output;
}
