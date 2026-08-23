import { GameIdSchema } from "../../games/ids";
import { canonicalJson, createFindingId } from "./identity";
import {
  FINDING_SCHEMA_VERSION,
  MAX_FINDING_EVIDENCE_REFS,
  type FindingConfidence,
  type FindingEvidenceRef,
  type FindingMeasurement,
  type FindingRecord,
  type FindingSeverity,
} from "./types";

export interface FindingValidationError {
  path: string;
  code: string;
  message: string;
}

export interface FindingValidationResult {
  valid: boolean;
  errors: FindingValidationError[];
}

const CONFIDENCES: FindingConfidence[] = ["high", "medium", "low", "unknown"];
const SEVERITIES: FindingSeverity[] = ["informational", "low", "medium", "high", "critical"];

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function addError(
  errors: FindingValidationError[],
  path: string,
  code: string,
  message: string,
): void {
  errors.push({ path, code, message });
}

function validateStringIds(
  values: readonly string[],
  path: string,
  errors: FindingValidationError[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!hasText(value)) addError(errors, `${path}[${index}]`, "invalid-id", "ID must be a non-empty canonical string");
    else if (seen.has(value)) addError(errors, `${path}[${index}]`, "duplicate-id", `Duplicate ID ${value}`);
    seen.add(value);
  });
}

function validateEvidenceRef(
  reference: FindingEvidenceRef,
  path: string,
  errors: FindingValidationError[],
): void {
  if (!hasText(reference.id)) addError(errors, `${path}.id`, "invalid-id", "Evidence ID is required");
  if (reference.semanticIds) validateStringIds(reference.semanticIds, `${path}.semanticIds`, errors);
  if (reference.sessionId !== undefined && !hasText(reference.sessionId)) {
    addError(errors, `${path}.sessionId`, "invalid-id", "Evidence session ID must be a non-empty canonical string");
  }
  if ("lapId" in reference && reference.lapId !== undefined && !hasText(reference.lapId)) {
    addError(errors, `${path}.lapId`, "invalid-id", "Evidence lap ID must be a non-empty canonical string");
  }

  const requiredByKind: Partial<Record<FindingEvidenceRef["kind"], string>> = {
    lap: "lapId",
    event: "eventId",
    stint: "stintId",
    "pace-segment": "paceSegmentId",
    corner: "cornerId",
    segment: "segmentId",
    channel: "channel",
    measurement: "measurementId",
    "quality-decision": "decisionId",
    "comparison-reference": "comparisonReferenceId",
  };
  const required = requiredByKind[reference.kind];
  if (required && !hasText((reference as unknown as Record<string, unknown>)[required])) {
    addError(errors, `${path}.${required}`, "missing-coordinate", `${reference.kind} evidence requires ${required}`);
  }

  if (reference.kind === "quality-decision" && !hasText(reference.decision)) {
    addError(errors, `${path}.decision`, "missing-decision", "Quality evidence requires a stable decision");
  }
  if (reference.kind !== "telemetry-range") return;

  const hasFrames = reference.startFrameIndex !== undefined || reference.endFrameIndex !== undefined;
  const hasTimes = reference.startTimestampMs !== undefined || reference.endTimestampMs !== undefined;
  if (!hasFrames && !hasTimes) {
    addError(errors, path, "missing-range", "Telemetry evidence requires a frame or timestamp range");
  }
  if (hasFrames) {
    const start = reference.startFrameIndex;
    const end = reference.endFrameIndex;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! < start!) {
      addError(errors, path, "invalid-frame-range", "Frame range must be ordered non-negative integers");
    }
  }
  if (hasTimes) {
    const start = reference.startTimestampMs;
    const end = reference.endTimestampMs;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end! < start!) {
      addError(errors, path, "invalid-time-range", "Timestamp range must be ordered finite numbers");
    }
  }
}

function validateUniqueEvidence(
  references: readonly FindingEvidenceRef[],
  path: string,
  errors: FindingValidationError[],
): void {
  if (references.length > MAX_FINDING_EVIDENCE_REFS) {
    addError(
      errors,
      path,
      "too-many-evidence-references",
      `Finding evidence is limited to ${MAX_FINDING_EVIDENCE_REFS} references`,
    );
  }
  const seen = new Set<string>();
  references.slice(0, MAX_FINDING_EVIDENCE_REFS).forEach((reference, index) => {
    validateEvidenceRef(reference, `${path}[${index}]`, errors);
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) addError(errors, `${path}[${index}]`, "duplicate-reference", `Duplicate evidence reference ${key}`);
    seen.add(key);
  });
}

function validateMeasurement(
  measurement: FindingMeasurement,
  path: string,
  errors: FindingValidationError[],
): void {
  if (!hasText(measurement.id)) addError(errors, `${path}.id`, "invalid-id", "Measurement ID is required");
  if (!hasText(measurement.type)) addError(errors, `${path}.type`, "invalid-type", "Measurement type is required");
  if (!hasText(measurement.unit)) addError(errors, `${path}.unit`, "invalid-unit", "Canonical unit is required");
  if (!Number.isInteger(measurement.sampleCount) || measurement.sampleCount < 0) {
    addError(errors, `${path}.sampleCount`, "invalid-sample-count", "Sample count must be a non-negative integer");
  }
  if (!CONFIDENCES.includes(measurement.confidence)) {
    addError(errors, `${path}.confidence`, "invalid-confidence", "Measurement confidence is invalid");
  }
  validateStringIds(measurement.semanticIds, `${path}.semanticIds`, errors);
  if (!hasText(measurement.derivation?.id) || !hasText(measurement.derivation?.version)) {
    addError(errors, `${path}.derivation`, "invalid-derivation", "Stable derivation ID and version are required");
  }

  const value = measurement.value;
  if (typeof value === "number" && !Number.isFinite(value)) {
    addError(errors, `${path}.value`, "non-finite-value", "Numeric values must be finite");
  } else if (typeof value === "object" && value !== null) {
    if (!Number.isFinite(value.min) || !Number.isFinite(value.max) || value.max < value.min) {
      addError(errors, `${path}.value`, "invalid-range", "Numeric range must contain ordered finite bounds");
    }
  }
  if (value === null && !hasText(measurement.unavailableReason)) {
    addError(errors, `${path}.unavailableReason`, "missing-unavailable-reason", "Null measurement requires a stable unavailable reason");
  }
  if (value !== null && measurement.sampleCount < 1) {
    addError(errors, `${path}.sampleCount`, "empty-measurement", "Available measurement requires at least one sample");
  }
}

export function validateFinding(record: FindingRecord): FindingValidationResult {
  const errors: FindingValidationError[] = [];
  if (record.schemaVersion !== FINDING_SCHEMA_VERSION) {
    addError(errors, "schemaVersion", "unsupported-schema", `Expected schema version ${FINDING_SCHEMA_VERSION}`);
  }
  for (const [path, value] of [
    ["id", record.id],
    ["type", record.type],
    ["category", record.category],
    ["scope.gameId", record.scope?.gameId],
    ["scope.sessionId", record.scope?.sessionId],
    ["rule.id", record.rule?.id],
    ["rule.version", record.rule?.version],
    ["analysisGenerationId", record.analysisGenerationId],
  ] as const) {
    if (!hasText(value)) addError(errors, path, "required", `${path} is required`);
  }
  if (hasText(record.scope?.gameId) && !GameIdSchema.safeParse(record.scope.gameId).success) {
    addError(errors, "scope.gameId", "invalid-game", "Scope game ID is not registered");
  }
  if (!SEVERITIES.includes(record.severity)) addError(errors, "severity", "invalid-severity", "Finding severity is invalid");
  if (!CONFIDENCES.includes(record.confidence)) addError(errors, "confidence", "invalid-confidence", "Finding confidence is invalid");

  const requiredScopeId: Partial<Record<FindingRecord["scope"]["kind"], keyof FindingRecord["scope"]>> = {
    participant: "participantId",
    stint: "stintId",
    "pace-segment": "paceSegmentId",
    lap: "lapId",
    corner: "cornerId",
    segment: "segmentId",
  };
  const scopeCoordinate = requiredScopeId[record.scope.kind];
  if (scopeCoordinate && !hasText(record.scope[scopeCoordinate])) {
    addError(errors, `scope.${scopeCoordinate}`, "missing-scope-coordinate", `${record.scope.kind} scope requires ${scopeCoordinate}`);
  }

  const measurementIds = new Set<string>();
  record.measurements.forEach((measurement, index) => {
    validateMeasurement(measurement, `measurements[${index}]`, errors);
    if (measurementIds.has(measurement.id)) {
      addError(errors, `measurements[${index}].id`, "duplicate-measurement", `Duplicate measurement ${measurement.id}`);
    }
    measurementIds.add(measurement.id);
  });
  validateUniqueEvidence(record.evidenceRefs, "evidenceRefs", errors);
  validateUniqueEvidence(record.qualityRefs, "qualityRefs", errors);

  const limitationCodes = new Set<string>();
  record.limitations.forEach((limitation, index) => {
    if (!hasText(limitation.code)) addError(errors, `limitations[${index}].code`, "invalid-limitation", "Stable limitation code is required");
    if (limitationCodes.has(limitation.code)) addError(errors, `limitations[${index}].code`, "duplicate-limitation", `Duplicate limitation ${limitation.code}`);
    limitationCodes.add(limitation.code);
    if (limitation.evidenceRefs) validateUniqueEvidence(limitation.evidenceRefs, `limitations[${index}].evidenceRefs`, errors);
  });

  if (record.status === "available") {
    if (record.evidenceRefs.length === 0) addError(errors, "evidenceRefs", "missing-evidence", "Available finding requires typed evidence");
    if (record.measurements.length === 0 || record.measurements.every((measurement) => measurement.value === null)) {
      addError(errors, "measurements", "missing-measurement", "Available finding requires at least one available measurement");
    }
  } else if (record.status === "unavailable" || record.status === "indeterminate") {
    if (record.limitations.length === 0) {
      addError(errors, "limitations", "missing-limitation", `${record.status} finding requires a stable limitation`);
    }
  } else {
    addError(errors, "status", "invalid-status", "Finding status is invalid");
  }

  if (record.comparisonReference) {
    if (!hasText(record.comparisonReference.id) || !hasText(record.comparisonReference.kind)) {
      addError(errors, "comparisonReference", "invalid-comparison-reference", "Comparison reference ID and kind are required");
    }
    if (!hasText(record.comparisonReference.selectionReason)) {
      addError(errors, "comparisonReference.selectionReason", "missing-selection-reason", "Comparison selection reason is required");
    }
    if (record.comparisonReference.evidenceRefs.length === 0) {
      addError(errors, "comparisonReference.evidenceRefs", "missing-reference-evidence", "Comparison reference requires evidence");
    }
    validateUniqueEvidence(record.comparisonReference.evidenceRefs, "comparisonReference.evidenceRefs", errors);
  }
  if (record.scope.kind === "comparison" && !record.comparisonReference) {
    addError(errors, "comparisonReference", "missing-comparison-reference", "Comparison scope requires a comparison reference");
  }

  try {
    canonicalJson(record.rule.inputs);
  } catch (error) {
    addError(errors, "rule.inputs", "non-canonical-input", error instanceof Error ? error.message : "Rule inputs are not canonical JSON");
  }
  if (hasText(record.id) && record.id !== createFindingId(record)) {
    addError(errors, "id", "identity-mismatch", "Finding ID does not match structured identity coordinates");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidFinding(record: FindingRecord): void {
  const result = validateFinding(record);
  if (result.valid) return;
  throw new Error(result.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
}
