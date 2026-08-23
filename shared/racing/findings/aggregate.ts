import { canonicalJson, createFindingId } from "./identity";
import { EVIDENCE_TRUNCATED_LIMITATION_CODE, MAX_FINDING_EVIDENCE_REFS } from "./types";
import type { CanonicalJson, FindingConfidence, FindingEvidenceRef, FindingLimitation, FindingMeasurement, FindingMeasurementValue, FindingRecord, FindingScope, FindingSeverity } from "./types";

export interface FindingAggregationOptions {
  targetScope: FindingScope;
  evaluatedLapIds?: string[];
  minimumOccurrences?: number;
  minimumFrequency?: number;
  numericPreference?: "lower" | "higher";
  contextInputKeys?: string[];
}

export interface FindingAggregationExamples {
  bestFindingId: string;
  worstFindingId: string;
  typicalFindingId: string;
  evidenceRefs: FindingEvidenceRef[];
}

export interface AggregatedFindingResult {
  status: "aggregated";
  finding: FindingRecord;
  contributingLapIds: string[];
  occurrenceCount: number;
  evaluatedLapCount: number;
  frequency: number;
  examples: FindingAggregationExamples;
}

export interface UnaggregatedFindingResult {
  status: "not-aggregated";
  reason:
    | "no-findings"
    | "incompatible-scope"
    | "incompatible-context"
    | "incompatible-generation"
    | "incompatible-rule"
    | "incompatible-reference"
    | "incompatible-finding"
    | "incompatible-measurements"
    | "below-persistence-threshold";
  detail: string;
}

export type FindingAggregationResult = AggregatedFindingResult | UnaggregatedFindingResult;

const DEFAULT_CONTEXT_INPUT_KEYS = ["carId", "car", "trackId", "track", "trackLayoutId", "layoutId", "contextId", "context", "gameId", "sessionType", "weather", "conditions"];
const CONFIDENCE_TIE_ORDER: FindingConfidence[] = ["unknown", "low", "medium", "high"];
const SEVERITY_TIE_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "informational"];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function majority<T extends string | boolean>(values: readonly T[], tieOrder?: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const order = tieOrder ?? [...counts.keys()].sort((left, right) => String(left).localeCompare(String(right)));
  let selected = order[0];
  let selectedCount = -1;
  for (const value of order) {
    const count = counts.get(value) ?? 0;
    if (count > selectedCount) {
      selected = value;
      selectedCount = count;
    }
  }
  return selected;
}

function aggregateValue(values: readonly FindingMeasurementValue[]): FindingMeasurementValue | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value): value is number => typeof value === "number")) return median(values);
  if (values.every((value): value is string => typeof value === "string")) return majority(values);
  if (values.every((value): value is boolean => typeof value === "boolean")) return majority(values);
  if (values.every((value): value is { min: number; max: number } => typeof value === "object" && value !== null)) {
    return { min: median(values.map((value) => value.min)), max: median(values.map((value) => value.max)) };
  }
  if (values.every((value) => value === null)) return null;
  return undefined;
}

function measurementKey(measurement: FindingMeasurement): string {
  return canonicalJson({ type: measurement.type, unit: measurement.unit, derivation: measurement.derivation });
}

function aggregateMeasurements(records: readonly FindingRecord[]): FindingMeasurement[] | undefined {
  const byKey = new Map<string, FindingMeasurement[]>();
  let expectedKeys: ReadonlySet<string> | undefined;
  for (const record of records) {
    const recordKeys = new Set<string>();
    for (const measurement of record.measurements) {
      const key = measurementKey(measurement);
      if (recordKeys.has(key) || (expectedKeys && !expectedKeys.has(key))) return undefined;
      recordKeys.add(key);
      const group = byKey.get(key) ?? [];
      group.push(measurement);
      byKey.set(key, group);
    }
    if (expectedKeys && recordKeys.size !== expectedKeys.size) return undefined;
    expectedKeys = expectedKeys ?? recordKeys;
  }
  const aggregated: FindingMeasurement[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const measurements = byKey.get(key)!;
    const template = measurements[0];
    const value = aggregateValue(measurements.map((measurement) => measurement.value));
    if (value === undefined) return undefined;
    const semanticIds = [...new Set(measurements.flatMap((measurement) => measurement.semanticIds))].sort();
    const uncertainties = measurements.map((measurement) => measurement.uncertainty).filter((entry): entry is number | { min: number; max: number } => entry !== undefined && entry !== null);
    const uncertainty = aggregateValue(uncertainties);
    const unavailableReasons = measurements.map((measurement) => measurement.unavailableReason).filter((reason): reason is string => reason !== undefined);
    aggregated.push({
      id: `aggregate:${template.type}:${template.unit}:${template.derivation.id}:${template.derivation.version}`,
      type: template.type,
      value,
      unit: template.unit,
      sampleCount: measurements.reduce((sum, measurement) => sum + measurement.sampleCount, 0),
      confidence: majority(
        measurements.map((measurement) => measurement.confidence),
        CONFIDENCE_TIE_ORDER,
      ),
      semanticIds,
      derivation: template.derivation,
      ...(typeof uncertainty === "number" || (typeof uncertainty === "object" && uncertainty !== null) ? { uncertainty } : {}),
      ...(value === null ? { unavailableReason: majority(unavailableReasons.length ? unavailableReasons : ["unavailable"]) } : {}),
    });
  }
  return aggregated;
}

function uniqueEvidence(references: readonly FindingEvidenceRef[]): FindingEvidenceRef[] {
  const byCoordinate = new Map<string, FindingEvidenceRef>();
  for (const reference of references) {
    const key = `${reference.kind}:${reference.id}`;
    const previous = byCoordinate.get(key);
    if (!previous || canonicalJson(reference) < canonicalJson(previous)) byCoordinate.set(key, reference);
  }
  return [...byCoordinate.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}
function boundAggregatedEvidence(references: readonly FindingEvidenceRef[], cohortReference: FindingEvidenceRef): { references: FindingEvidenceRef[]; omitted: number } {
  const ordered = uniqueEvidence(references);
  if (ordered.length <= MAX_FINDING_EVIDENCE_REFS) return { references: ordered, omitted: 0 };
  return {
    references: [cohortReference, ...ordered.slice(0, MAX_FINDING_EVIDENCE_REFS - 1)].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
    omitted: ordered.length - (MAX_FINDING_EVIDENCE_REFS - 1),
  };
}

function compatibleScope(records: readonly FindingRecord[], target: FindingScope): boolean {
  if (target.kind === "lap" || target.kind === "comparison") return false;
  if (records.some((record) => record.scope.kind !== "lap" || record.scope.gameId !== target.gameId || record.scope.sessionId !== target.sessionId)) return false;
  const stableKeys = ["participantId", "stintId", "paceSegmentId", "cornerId", "segmentId"] as const;
  for (const key of stableKeys) {
    const values = new Set(records.map((record) => record.scope[key] ?? null));
    if (values.size > 1) return false;
    if (target[key] !== undefined && records[0].scope[key] !== target[key]) return false;
  }
  const requirement: Partial<Record<FindingScope["kind"], keyof FindingScope>> = {
    participant: "participantId",
    stint: "stintId",
    "pace-segment": "paceSegmentId",
    corner: "cornerId",
    segment: "segmentId",
  };
  const required = requirement[target.kind];
  return required === undefined || typeof target[required] === "string";
}

function contextSignature(record: FindingRecord, keys: readonly string[]): string {
  const context: Record<string, CanonicalJson> = {};
  for (const key of keys) if (record.rule.inputs[key] !== undefined) context[key] = record.rule.inputs[key];
  return canonicalJson(context);
}

function uniqueLimitations(records: readonly FindingRecord[]): FindingLimitation[] {
  const byContent = new Map<string, FindingLimitation>();
  for (const limitation of records.flatMap((record) => record.limitations)) byContent.set(canonicalJson(limitation), limitation);
  return [...byContent.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function representativeScore(record: FindingRecord): number | string {
  for (const measurement of record.measurements) {
    if (typeof measurement.value === "number") return measurement.value;
    if (typeof measurement.value === "object" && measurement.value !== null) return (measurement.value.min + measurement.value.max) / 2;
  }
  return canonicalJson(record.measurements.map((measurement) => measurement.value));
}

function selectExamples(records: readonly FindingRecord[], numericPreference: "lower" | "higher"): FindingAggregationExamples {
  const ranked = [...records].sort((left, right) => {
    const leftScore = representativeScore(left);
    const rightScore = representativeScore(right);
    const comparison = typeof leftScore === "number" && typeof rightScore === "number" ? leftScore - rightScore : String(leftScore).localeCompare(String(rightScore));
    return comparison || left.id.localeCompare(right.id);
  });
  if (numericPreference === "higher") ranked.reverse();
  const numericScores = ranked.map(representativeScore).filter((score): score is number => typeof score === "number");
  const typical =
    numericScores.length === ranked.length
      ? ranked.reduce((best, candidate) => {
          const centre = median(numericScores);
          return Math.abs(Number(representativeScore(candidate)) - centre) < Math.abs(Number(representativeScore(best)) - centre) ? candidate : best;
        }, ranked[0])
      : ranked[Math.floor((ranked.length - 1) / 2)];
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  return {
    bestFindingId: best.id,
    worstFindingId: worst.id,
    typicalFindingId: typical.id,
    evidenceRefs: uniqueEvidence([...best.evidenceRefs, ...worst.evidenceRefs, ...typical.evidenceRefs]),
  };
}

export function aggregateFindings(findings: readonly FindingRecord[], options: FindingAggregationOptions): FindingAggregationResult {
  if (findings.length === 0) return { status: "not-aggregated", reason: "no-findings", detail: "No findings supplied" };
  const records = [...findings].sort((left, right) => left.id.localeCompare(right.id));
  if (!compatibleScope(records, options.targetScope)) {
    return { status: "not-aggregated", reason: "incompatible-scope", detail: "Lap or target scopes are incompatible" };
  }
  const first = records[0];
  if (records.some((record) => record.type !== first.type || record.category !== first.category || record.status !== first.status)) {
    return { status: "not-aggregated", reason: "incompatible-finding", detail: "Finding type, category, and status must match" };
  }
  if (records.some((record) => record.analysisGenerationId !== first.analysisGenerationId)) {
    return { status: "not-aggregated", reason: "incompatible-generation", detail: "Analysis generations must match" };
  }
  if (records.some((record) => record.rule.id !== first.rule.id || record.rule.version !== first.rule.version)) {
    return { status: "not-aggregated", reason: "incompatible-rule", detail: "Rule IDs and versions must match" };
  }
  const referenceId = first.comparisonReference?.id ?? null;
  if (records.some((record) => (record.comparisonReference?.id ?? null) !== referenceId)) {
    return { status: "not-aggregated", reason: "incompatible-reference", detail: "Comparison references must match" };
  }
  const contextKeys = options.contextInputKeys ?? DEFAULT_CONTEXT_INPUT_KEYS;
  const context = contextSignature(first, contextKeys);
  if (records.some((record) => contextSignature(record, contextKeys) !== context)) {
    return { status: "not-aggregated", reason: "incompatible-context", detail: "Car, track, or context must match" };
  }
  const contributingLapIds = [...new Set(records.map((record) => record.scope.lapId!))].sort();
  if (contributingLapIds.length !== records.length) {
    return { status: "not-aggregated", reason: "incompatible-scope", detail: "Each occurrence must identify a distinct lap" };
  }
  const evaluatedLapIds = options.evaluatedLapIds ? [...new Set(options.evaluatedLapIds)].sort() : contributingLapIds;
  if (contributingLapIds.some((lapId) => !evaluatedLapIds.includes(lapId))) {
    return { status: "not-aggregated", reason: "incompatible-scope", detail: "Evaluated laps must include every contributing lap" };
  }
  const frequency = evaluatedLapIds.length === 0 ? 0 : contributingLapIds.length / evaluatedLapIds.length;
  const minimumOccurrences = options.minimumOccurrences ?? 2;
  const minimumFrequency = options.minimumFrequency ?? 0.5;
  if (contributingLapIds.length < minimumOccurrences || frequency < minimumFrequency) {
    return { status: "not-aggregated", reason: "below-persistence-threshold", detail: "Persistence threshold not met" };
  }
  const measurements = aggregateMeasurements(records);
  if (!measurements) return { status: "not-aggregated", reason: "incompatible-measurements", detail: "Measurement groups or value types are incompatible" };
  const aggregateConfidence = majority(
    records.map((record) => record.confidence),
    CONFIDENCE_TIE_ORDER,
  );
  measurements.push(
    {
      id: "aggregation:occurrence-count",
      type: "occurrence-count",
      value: contributingLapIds.length,
      unit: "count",
      sampleCount: evaluatedLapIds.length,
      confidence: aggregateConfidence,
      semanticIds: [],
      derivation: { id: "finding-frequency", version: "1" },
    },
    {
      id: "aggregation:occurrence-frequency",
      type: "occurrence-frequency",
      value: frequency,
      unit: "ratio",
      sampleCount: evaluatedLapIds.length,
      confidence: aggregateConfidence,
      semanticIds: [],
      derivation: { id: "finding-frequency", version: "1" },
    },
  );
  measurements.sort((left, right) => left.id.localeCompare(right.id));
  const examples = selectExamples(records, options.numericPreference ?? "lower");
  const fullEvidenceRefs = uniqueEvidence(records.flatMap((record) => record.evidenceRefs));
  const evidenceCohortRef: FindingEvidenceRef = {
    kind: "measurement",
    id: `aggregate-evidence-cohort:${createFindingId({
      type: "aggregate-evidence-cohort",
      scope: options.targetScope,
      evidenceRefs: fullEvidenceRefs,
      analysisGenerationId: first.analysisGenerationId,
      ruleVersion: first.rule.version,
    })}`,
    measurementId: "aggregate-evidence-cohort",
    sessionId: options.targetScope.sessionId,
  };
  const evidence = boundAggregatedEvidence(fullEvidenceRefs, evidenceCohortRef);
  const fullQualityRefs = uniqueEvidence(records.flatMap((record) => record.qualityRefs));
  const qualityCohortRef: FindingEvidenceRef = {
    kind: "measurement",
    id: `aggregate-quality-cohort:${createFindingId({
      type: "aggregate-quality-cohort",
      scope: options.targetScope,
      evidenceRefs: fullQualityRefs,
      analysisGenerationId: first.analysisGenerationId,
      ruleVersion: first.rule.version,
    })}`,
    measurementId: "aggregate-quality-cohort",
    sessionId: options.targetScope.sessionId,
  };
  const quality = boundAggregatedEvidence(fullQualityRefs, qualityCohortRef);
  const omittedEvidence = evidence.omitted + quality.omitted;
  const finding: FindingRecord = {
    schemaVersion: first.schemaVersion,
    id: "pending",
    type: first.type,
    category: first.category,
    scope: options.targetScope,
    status: first.status,
    severity: majority(
      records.map((record) => record.severity),
      SEVERITY_TIE_ORDER,
    ),
    confidence: aggregateConfidence,
    measurements,
    evidenceRefs: evidence.references,
    qualityRefs: quality.references,
    limitations: [
      ...uniqueLimitations(records),
      ...(omittedEvidence === 0
        ? []
        : [
            {
              code: EVIDENCE_TRUNCATED_LIMITATION_CODE,
              detail: `Retained bounded representative evidence; ${omittedEvidence} typed references omitted.`,
            },
          ]),
    ],
    rule: {
      id: first.rule.id,
      version: first.rule.version,
      inputs: {
        ...first.rule.inputs,
        aggregation: {
          method: "median-majority-frequency",
          contributingLapIds,
          evaluatedLapIds,
          minimumOccurrences,
          minimumFrequency,
          bestFindingId: examples.bestFindingId,
          worstFindingId: examples.worstFindingId,
          typicalFindingId: examples.typicalFindingId,
        },
      },
    },
    analysisGenerationId: first.analysisGenerationId,
    ...(first.comparisonReference ? { comparisonReference: first.comparisonReference } : {}),
  };
  finding.id = createFindingId(finding);
  return {
    status: "aggregated",
    finding,
    contributingLapIds,
    occurrenceCount: contributingLapIds.length,
    evaluatedLapCount: evaluatedLapIds.length,
    frequency,
    examples,
  };
}
