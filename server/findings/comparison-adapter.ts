import type { GameId } from "../../shared/games/ids";

import type { ComparisonResult } from "../lap-analysis/comparison";
import type {
  ComparisonReference,
  FindingEvidenceRef,
  FindingRecord,
  FindingStatus,
} from "../../shared/racing/findings/types";
import { FINDING_SCHEMA_VERSION } from "../../shared/racing/findings/types";
import { createFindingId } from "../../shared/racing/findings/identity";

export interface ComparisonFindingContext {
  gameId: GameId;
  sessionId: string | number;
  sessionAId?: string | number;
  sessionBId?: string | number;
  lapAId: string | number;
  lapBId: string | number;
  result: ComparisonResult;
  referenceId?: string;
  referenceKind?: string;
  referenceSelectionReason?: string;
  analysisGenerationId?: string;
  ruleVersion?: string | number;
}

const RULE_ID = "lap-comparison-adapter";
const DEFAULT_GENERATION = "lap-comparison-v1";

function traceRangeEvidence(
  sessionId: string,
  lapId: string,
  startFrameIndex: number | null,
  endFrameIndex: number | null,
  suffix: string,
): FindingEvidenceRef[] {
  if (
    !Number.isInteger(startFrameIndex)
    || !Number.isInteger(endFrameIndex)
    || startFrameIndex! < 0
    || endFrameIndex! < 0
  ) return [];
  return [{
    kind: "telemetry-range",
    id: `range:${lapId}:${suffix}`,
    sessionId,
    lapId,
    startFrameIndex: Math.min(startFrameIndex!, endFrameIndex!),
    endFrameIndex: Math.max(startFrameIndex!, endFrameIndex!),
  }];
}

export function adaptComparisonToFindings(context: ComparisonFindingContext): FindingRecord[] {
  const sessionId = String(context.sessionAId ?? context.sessionId);
  const sessionBId = String(context.sessionBId ?? context.sessionId ?? context.sessionAId);
  const lapAId = String(context.lapAId);
  const lapBId = String(context.lapBId);
  const generation = context.analysisGenerationId ?? DEFAULT_GENERATION;
  const ruleVersion = String(context.ruleVersion ?? "1");
  const referenceId = context.referenceId ?? `lap:${lapBId}`;
  const lapAEvidence: FindingEvidenceRef = { kind: "lap", id: `lap:${lapAId}`, lapId: lapAId, sessionId };
  const lapBEvidence: FindingEvidenceRef = { kind: "lap", id: `lap:${lapBId}`, lapId: lapBId, sessionId: sessionBId };
  const referenceEvidence: FindingEvidenceRef = {
    kind: "comparison-reference",
    id: `comparison-reference:${referenceId}`,
    sessionId,
    comparisonReferenceId: referenceId,
  };
  const comparisonReference: ComparisonReference = {
    id: referenceId,
    kind: context.referenceKind ?? "lap",
    selectionReason: context.referenceSelectionReason ?? "explicit lap B reference for A-minus-B comparison",
    evidenceRefs: [lapBEvidence, referenceEvidence],
  };
  const commonEvidence = [
    lapAEvidence,
    lapBEvidence,
    referenceEvidence,
  ];
  const corners = context.result.cornerDeltas.length > 0
    ? context.result.cornerDeltas
    : [{
        label: "comparison",
        deltaSeconds: Number.NaN,
        timeA: Number.NaN,
        timeB: Number.NaN,
        distanceStart: 0,
        distanceEnd: 0,
        alignedStartIndex: null,
        alignedEndIndex: null,
        sourceStartIndexA: null,
        sourceEndIndexA: null,
        sourceStartIndexB: null,
        sourceEndIndexB: null,
      }];

  return corners.map((corner, index) => {
    const cornerId = corner.label || `corner-${index + 1}`;
    const cornerEvidence: FindingEvidenceRef = {
      kind: "corner",
      id: `corner:${cornerId}`,
      cornerId,
      sessionId,
    };
    const rangeSuffix = `${cornerId}:${index}`;
    const evidenceRefs = [
      ...commonEvidence,
      ...traceRangeEvidence(sessionId, lapAId, corner.sourceStartIndexA, corner.sourceEndIndexA, `${rangeSuffix}:comparison-a`),
      ...traceRangeEvidence(sessionBId, lapBId, corner.sourceStartIndexB, corner.sourceEndIndexB, `${rangeSuffix}:comparison-b`),
      cornerEvidence,
    ];
    const hasAlignedRange = Number.isInteger(corner.alignedStartIndex)
      && Number.isInteger(corner.alignedEndIndex)
      && corner.alignedStartIndex! >= 0
      && corner.alignedEndIndex! >= corner.alignedStartIndex!;
    const hasSourceRanges = Number.isInteger(corner.sourceStartIndexA)
      && Number.isInteger(corner.sourceEndIndexA)
      && Number.isInteger(corner.sourceStartIndexB)
      && Number.isInteger(corner.sourceEndIndexB)
      && corner.sourceStartIndexA! >= 0
      && corner.sourceEndIndexA! >= corner.sourceStartIndexA!
      && corner.sourceStartIndexB! >= 0
      && corner.sourceEndIndexB! >= corner.sourceStartIndexB!;
    const hasEvidence = hasAlignedRange && hasSourceRanges
      && Number.isFinite(corner.deltaSeconds) && Number.isFinite(corner.timeA) && Number.isFinite(corner.timeB)
      && corner.timeA > 0 && corner.timeB > 0;
    const status: FindingStatus = hasEvidence ? "available" : "indeterminate";
    const limitations = hasEvidence ? [] : [{
      code: "insufficient-comparison-evidence",
      detail: "corner timing evidence was unavailable or did not span a complete corner",
      evidenceRefs: [cornerEvidence, referenceEvidence],
    }];
    const measurementSampleCount = hasEvidence ? corner.alignedEndIndex! - corner.alignedStartIndex! + 1 : 0;
    const measurements = [{
      id: `comparison:${lapAId}:${lapBId}:${cornerId}:delta`,
      type: "lap-a-minus-lap-b-time-delta",
      value: hasEvidence ? corner.deltaSeconds : null,
      unit: "s",
      sampleCount: measurementSampleCount,
      confidence: hasEvidence ? "high" as const : "unknown" as const,
      semanticIds: ["timing.current-lap"],
      derivation: { id: RULE_ID, version: ruleVersion },
      ...(hasEvidence ? {} : { unavailableReason: "insufficient-comparison-evidence" }),
    }, {
      id: `comparison:${lapAId}:${lapBId}:${cornerId}:time-a`,
      type: "lap-a-corner-time",
      value: hasEvidence ? corner.timeA : null,
      unit: "s",
      sampleCount: measurementSampleCount,
      confidence: hasEvidence ? "high" as const : "unknown" as const,
      semanticIds: ["timing.current-lap"],
      derivation: { id: RULE_ID, version: ruleVersion },
      ...(hasEvidence ? {} : { unavailableReason: "insufficient-comparison-evidence" }),
    }, {
      id: `comparison:${lapAId}:${lapBId}:${cornerId}:time-b`,
      type: "lap-b-corner-time",
      value: hasEvidence ? corner.timeB : null,
      unit: "s",
      sampleCount: measurementSampleCount,
      confidence: hasEvidence ? "high" as const : "unknown" as const,
      semanticIds: ["timing.current-lap"],
      derivation: { id: RULE_ID, version: ruleVersion },
      ...(hasEvidence ? {} : { unavailableReason: "insufficient-comparison-evidence" }),
    }];
    const rule = {
      id: RULE_ID,
      version: ruleVersion,
      inputs: {
        signConvention: "lap-a-minus-lap-b",
        source: "ComparisonResult.cornerDeltas",
        referenceLapId: lapBId,
      },
    } as const;
    const recordBase = {
      schemaVersion: FINDING_SCHEMA_VERSION,
      type: "corner-time-comparison",
      category: "pace",
      scope: { kind: "comparison" as const, gameId: context.gameId, sessionId, cornerId },
      status,
      severity: hasEvidence && corner.deltaSeconds > 0 ? "medium" as const : "informational" as const,
      confidence: hasEvidence ? "high" as const : "unknown" as const,
      measurements,
      evidenceRefs,
      qualityRefs: [],
      limitations,
      rule,
      analysisGenerationId: generation,
      comparisonReference,
      title: hasEvidence ? `${cornerId} A-minus-B time delta` : `${cornerId} comparison unavailable`,
    };
    return {
      ...recordBase,
      id: createFindingId({
        type: recordBase.type,
        scope: recordBase.scope,
        evidenceRefs,
        analysisGenerationId: generation,
        ruleVersion,
        comparisonReferenceId: referenceId,
      }),
    } satisfies FindingRecord;
  });
}
