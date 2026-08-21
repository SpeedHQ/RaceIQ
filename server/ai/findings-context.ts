import type {
  FindingConfidence,
  FindingNarrative,
  FindingRecord,
  FindingRecommendation,
  FindingStatus,
} from "../../shared/racing/findings/types";

export interface FindingsContextOptions {
  label?: string;
  narratives?: readonly FindingNarrative[];
  recommendations?: readonly FindingRecommendation[];
}

interface FindingLike {
  schemaVersion?: unknown;
  id?: unknown;
  type?: unknown;
  category?: unknown;
  scope?: unknown;
  status?: unknown;
  severity?: unknown;
  confidence?: unknown;
  title?: unknown;
  measurements?: unknown;
  evidenceRefs?: unknown;
  qualityRefs?: unknown;
  limitations?: unknown;
  rule?: unknown;
  analysisGenerationId?: unknown;
}

const VALID_STATUS = new Set<FindingStatus>(["available", "unavailable", "indeterminate"]);
const VALID_CONFIDENCE = new Set<FindingConfidence>(["high", "medium", "low", "unknown"]);
const VALID_SEVERITY = new Set(["informational", "low", "medium", "high", "critical"]);
const VALID_SCOPE = new Set(["session", "participant", "stint", "pace-segment", "lap", "corner", "segment", "comparison"]);
const VALID_EVIDENCE = new Set([
  "lap",
  "event",
  "stint",
  "pace-segment",
  "corner",
  "segment",
  "telemetry-range",
  "channel",
  "measurement",
  "quality-decision",
  "comparison-reference",
]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeasurement(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.derivation)) return false;
  return (
    text(value.id) !== null &&
    text(value.type) !== null &&
    text(value.unit) !== null &&
    typeof value.sampleCount === "number" &&
    Number.isInteger(value.sampleCount) &&
    value.sampleCount >= 0 &&
    VALID_CONFIDENCE.has(value.confidence as FindingConfidence) &&
    Array.isArray(value.semanticIds) &&
    value.semanticIds.every((semanticId) => text(semanticId) !== null) &&
    text(value.derivation.id) !== null &&
    text(value.derivation.version) !== null
  );
}

function isEvidenceRef(value: unknown): boolean {
  return isRecord(value) && VALID_EVIDENCE.has(String(value.kind)) && text(value.id) !== null;
}

/** Strict structural guard for cache/request boundaries. */
export function isFindingRecord(value: unknown): value is FindingRecord {
  if (!isRecord(value)) return false;
  const finding = value as FindingLike;
  const scope = isRecord(finding.scope) ? finding.scope : null;
  const rule = isRecord(finding.rule) ? finding.rule : null;
  const measurements = Array.isArray(finding.measurements) ? finding.measurements : [];
  const evidenceRefs = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : [];
  const limitations = Array.isArray(finding.limitations) ? finding.limitations : [];
  const status = finding.status as FindingStatus;
  return (
    finding.schemaVersion === "1" &&
    text(finding.id) !== null &&
    text(finding.type) !== null &&
    text(finding.category) !== null &&
    scope !== null &&
    VALID_SCOPE.has(String(scope.kind)) &&
    text(scope.sessionId) !== null &&
    VALID_STATUS.has(status) &&
    VALID_SEVERITY.has(String(finding.severity)) &&
    VALID_CONFIDENCE.has(finding.confidence as FindingConfidence) &&
    measurements.every(isMeasurement) &&
    evidenceRefs.every(isEvidenceRef) &&
    Array.isArray(finding.qualityRefs) &&
    finding.qualityRefs.every(isEvidenceRef) &&
    limitations.every((limitation) => isRecord(limitation) && text(limitation.code) !== null) &&
    rule !== null &&
    text(rule.id) !== null &&
    text(rule.version) !== null &&
    isRecord(rule.inputs) &&
    text(finding.analysisGenerationId) !== null &&
    (status !== "available" || (measurements.length > 0 && evidenceRefs.length > 0)) &&
    (status === "available" || limitations.length > 0)
  );
}

/** Parse structured finding cache payloads. Malformed JSON and raw prose return no evidence. */
export function parseCachedFindings(value: unknown): FindingRecord[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.findings)
      ? parsed.findings
      : [];
  return rows.filter(isFindingRecord);
}

function scopeIds(scope: unknown): string[] {
  if (!isRecord(scope)) return [];
  return ["sessionId", "participantId", "stintId", "paceSegmentId", "lapId", "cornerId", "segmentId"].flatMap(
    (key) => {
      const value = text(scope[key]);
      return value ? [`${key}=${value}`] : [];
    },
  );
}

function evidenceLabel(ref: unknown): string | null {
  if (!isRecord(ref)) return null;
  const kind = text(ref.kind);
  const refId = text(ref.id);
  if (!kind && !refId) return null;
  const fields = Object.entries(ref)
    .filter(([key, value]) => key !== "kind" && key !== "id" && value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return [kind ?? "evidence", refId, ...fields].filter(Boolean).join(":");
}

function limitationText(finding: FindingLike): string[] {
  if (!Array.isArray(finding.limitations)) return [];
  return finding.limitations.flatMap((limitation) => {
    if (!isRecord(limitation)) return [];
    const code = text(limitation.code);
    const detail = text(limitation.detail);
    const rendered = [code, detail].filter(Boolean).join(": ");
    return rendered ? [rendered] : [];
  });
}

function renderMeasurement(measurement: unknown): string | null {
  if (!isRecord(measurement)) return null;
  const measurementId = text(measurement.id) ?? "measurement";
  const type = text(measurement.type) ?? "value";
  const value = measurement.value === null || measurement.value === undefined
    ? "unavailable"
    : typeof measurement.value === "object"
      ? JSON.stringify(measurement.value)
      : String(measurement.value);
  const unit = text(measurement.unit);
  const samples = typeof measurement.sampleCount === "number" ? `, n=${measurement.sampleCount}` : "";
  return `${measurementId}/${type}=${value}${unit ? ` ${unit}` : ""}${samples}`;
}

function renderFinding(finding: FindingLike): string | null {
  const findingId = text(finding.id);
  const status = finding.status as FindingStatus;
  if (!findingId || !VALID_STATUS.has(status)) return null;

  const limitations = limitationText(finding);
  if (status !== "available") {
    return `[ABSTENTION] ${findingId}: ${status}${limitations.length ? ` (${limitations.join("; ")})` : " (reason unavailable)"}`;
  }

  const evidence = Array.isArray(finding.evidenceRefs)
    ? finding.evidenceRefs.map(evidenceLabel).filter((value): value is string => value !== null)
    : [];
  const measurements = Array.isArray(finding.measurements)
    ? finding.measurements.map(renderMeasurement).filter((value): value is string => value !== null)
    : [];
  if (evidence.length === 0 || measurements.length === 0) {
    return `[ABSTENTION] ${findingId}: available finding lacks required evidence or measurement; no claim permitted`;
  }

  const confidence = text(finding.confidence) ?? "unknown";
  const confidenceRule = confidence === "high" || confidence === "medium" ? "" : "; do not state as certain";
  const scope = scopeIds(finding.scope);
  const name = text(finding.title) ?? `${text(finding.type) ?? "finding"}/${text(finding.category) ?? "uncategorized"}`;
  return [
    `[FINDING ${findingId}] ${name}`,
    "status=available",
    `confidence=${confidence}${confidenceRule}`,
    text(finding.severity) ? `severity=${text(finding.severity)}` : null,
    scope.length ? `scope=${scope.join(",")}` : null,
    `measurements=${measurements.join(" | ")}`,
    `evidence=${evidence.join(", ")}`,
    limitations.length ? `limitations=${limitations.join("; ")}` : null,
    "association is not causation",
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
}

function renderNarratives(
  narratives: readonly FindingNarrative[] | undefined,
  suppliedIds: ReadonlySet<string>,
): string[] {
  if (!narratives?.length) return [];
  return narratives
    .flatMap((narrative) => {
      if (!isRecord(narrative)) return [];
      const row = narrative;
      const narrativeId = text(row.id);
      const detail = text(row.text);
      const generator = text(row.generator);
      const generationId = text(row.generationId);
      if (
        !narrativeId
        || !detail
        || !generator
        || !generationId
        || !Array.isArray(row.findingIds)
        || !row.findingIds.every((findingId) => text(findingId) !== null)
        || (row.createdAt !== undefined && text(row.createdAt) === null)
      ) return [];
      const linkedIds = row.findingIds
        .map(text)
        .filter((value): value is string => value !== null && suppliedIds.has(value))
        .sort();
      return linkedIds.length === 0
        ? []
        : [`[NARRATIVE wording-only; findings=${linkedIds.join(",")}] wording=${JSON.stringify(detail)}`];
    })
    .sort();
}

function renderRecommendations(
  recommendations: readonly FindingRecommendation[] | undefined,
  availableIds: ReadonlySet<string>,
): string[] {
  if (!recommendations?.length) return [];
  return recommendations
    .map((recommendation) => {
      const row = recommendation as unknown as Record<string, unknown>;
      const supports = Array.isArray(row.supportingFindingIds)
        ? row.supportingFindingIds
            .map(text)
            .filter((value): value is string => value !== null && availableIds.has(value))
        : [];
      if (supports.length === 0) return null;
      const detail = text(row.text);
      return detail ? `[RECOMMENDATION] ${detail}; supporting findings=${supports.join(", ")}` : null;
    })
    .filter((value): value is string => value !== null)
    .sort();
}

/** Structured evidence plus explicitly labelled wording from supplied finding IDs. */
export function buildFindingsContext(
  findings: readonly FindingRecord[],
  options: FindingsContextOptions = {},
): string {
  const supplied = findings.filter(isFindingRecord).sort((a, b) => a.id.localeCompare(b.id));
  if (supplied.length === 0) return "";
  const availableIds = new Set(
    supplied.filter((finding) => finding.status === "available").map((finding) => finding.id),
  );
  const suppliedIds = new Set(supplied.map((finding) => finding.id));
  const heading = options.label ? `--- ${options.label} DETERMINISTIC FINDINGS ---` : "--- DETERMINISTIC FINDINGS ---";
  return [
    heading,
    "Only supplied finding records are evidence. Unavailable or indeterminate findings are abstentions. Low-confidence findings cannot be stated as certain. Cite only IDs shown below. Correlation or association cannot be upgraded to causation. Narratives are wording attached to supplied finding IDs, never evidence or new findings. Recommendations require supporting finding IDs.",
    ...supplied.map(renderFinding).filter((value): value is string => value !== null),
    ...renderNarratives(options.narratives, suppliedIds),
    ...renderRecommendations(options.recommendations, availableIds),
  ].join("\n");
}

export const renderFindingsContext = buildFindingsContext;
