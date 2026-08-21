import type { FindingEvidenceRef, FindingMeasurement, FindingRecommendation, FindingRecord, FindingScope } from "./types";

function renderScope(scope: FindingScope): string {
  const ids = [
    `session=${scope.sessionId}`,
    scope.participantId && `participant=${scope.participantId}`,
    scope.stintId && `stint=${scope.stintId}`,
    scope.paceSegmentId && `pace-segment=${scope.paceSegmentId}`,
    scope.lapId && `lap=${scope.lapId}`,
    scope.cornerId && `corner=${scope.cornerId}`,
    scope.segmentId && `segment=${scope.segmentId}`,
  ].filter((value): value is string => Boolean(value));
  return `${scope.kind} (${ids.join(", ")})`;
}

function renderValue(measurement: FindingMeasurement): string {
  if (measurement.value === null) return `unavailable: ${measurement.unavailableReason ?? "reason not supplied"}`;
  if (typeof measurement.value === "object") return `${measurement.value.min}–${measurement.value.max}`;
  return String(measurement.value);
}

function renderEvidence(reference: FindingEvidenceRef): string {
  const details: string[] = [];
  if (reference.kind === "lap") details.push(`lap=${reference.lapId}`);
  else if (reference.kind === "event") details.push(`event=${reference.eventId}`);
  else if (reference.kind === "stint") details.push(`stint=${reference.stintId}`);
  else if (reference.kind === "pace-segment") details.push(`pace-segment=${reference.paceSegmentId}`);
  else if (reference.kind === "corner") details.push(`corner=${reference.cornerId}`, ...(reference.lapId ? [`lap=${reference.lapId}`] : []));
  else if (reference.kind === "segment") details.push(`segment=${reference.segmentId}`, ...(reference.lapId ? [`lap=${reference.lapId}`] : []));
  else if (reference.kind === "channel") details.push(`channel=${reference.channel}`);
  else if (reference.kind === "measurement") details.push(`measurement=${reference.measurementId}`);
  else if (reference.kind === "quality-decision") details.push(`decision=${reference.decisionId}`, `value=${reference.decision}`);
  else if (reference.kind === "comparison-reference") details.push(`reference=${reference.comparisonReferenceId}`);
  else if (reference.kind === "telemetry-range") {
    if (reference.startFrameIndex !== undefined && reference.endFrameIndex !== undefined) details.push(`frames=${reference.startFrameIndex}–${reference.endFrameIndex}`);
    if (reference.startTimestampMs !== undefined && reference.endTimestampMs !== undefined) details.push(`timestamps-ms=${reference.startTimestampMs}–${reference.endTimestampMs}`);
    if (reference.channel) details.push(`channel=${reference.channel}`);
  }
  if (reference.semanticIds?.length) details.push(`semantics=${[...reference.semanticIds].sort().join(",")}`);
  return `${reference.kind}:${reference.id}${details.length ? ` (${details.join("; ")})` : ""}`;
}

export function renderFinding(record: FindingRecord): string {
  const lines = [
    `## ${record.title ?? record.type}`,
    `- ID: ${record.id}`,
    `- Type: ${record.type}`,
    `- Category: ${record.category}`,
    `- Scope: ${renderScope(record.scope)}`,
    `- Status: ${record.status}`,
    `- Severity: ${record.severity}`,
    `- Confidence: ${record.confidence}`,
  ];
  if (record.status !== "available") {
    for (const limitation of [...record.limitations].sort((left, right) => left.code.localeCompare(right.code))) {
      lines.push(`- Reason: ${limitation.code}${limitation.detail ? ` — ${limitation.detail}` : ""}`);
    }
  }
  if (record.measurements.length) {
    lines.push("- Measurements:");
    for (const measurement of [...record.measurements].sort((left, right) => left.id.localeCompare(right.id))) {
      lines.push(`  - ${measurement.type} [${measurement.id}]: ${renderValue(measurement)} ${measurement.unit} (samples=${measurement.sampleCount}; confidence=${measurement.confidence})`);
    }
  }
  if (record.limitations.length) {
    lines.push("- Limitations:");
    for (const limitation of [...record.limitations].sort((left, right) => left.code.localeCompare(right.code))) {
      lines.push(`  - ${limitation.code}${limitation.detail ? `: ${limitation.detail}` : ""}`);
      for (const reference of [...(limitation.evidenceRefs ?? [])].sort((left, right) => renderEvidence(left).localeCompare(renderEvidence(right)))) {
        lines.push(`    - Evidence: ${renderEvidence(reference)}`);
      }
    }
  }
  if (record.comparisonReference) {
    lines.push(`- Comparison reference: ${record.comparisonReference.kind}:${record.comparisonReference.id}`);
    lines.push(`  - Selection reason: ${record.comparisonReference.selectionReason}`);
    for (const reference of [...record.comparisonReference.evidenceRefs].sort((left, right) => renderEvidence(left).localeCompare(renderEvidence(right)))) {
      lines.push(`  - Evidence: ${renderEvidence(reference)}`);
    }
  }
  lines.push("- Evidence:");
  for (const reference of [...record.evidenceRefs].sort((left, right) => renderEvidence(left).localeCompare(renderEvidence(right)))) {
    lines.push(`  - ${renderEvidence(reference)}`);
  }
  if (record.qualityRefs.length) {
    lines.push("- Quality evidence:");
    for (const reference of [...record.qualityRefs].sort((left, right) => renderEvidence(left).localeCompare(renderEvidence(right)))) lines.push(`  - ${renderEvidence(reference)}`);
  }
  return lines.join("\n");
}

export function renderFindingsReport(findings: readonly FindingRecord[], recommendations: readonly FindingRecommendation[] = []): string {
  const sections = ["# Findings report"];
  const ordered = [...findings].sort((left, right) => left.scope.sessionId.localeCompare(right.scope.sessionId) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  sections.push(...(ordered.length ? ordered.map(renderFinding) : ["No findings."]));
  if (recommendations.length) {
    sections.push("# Recommendations");
    for (const recommendation of [...recommendations].sort((left, right) => left.id.localeCompare(right.id))) {
      sections.push(`## ${recommendation.kind} [${recommendation.id}]\n- Confidence: ${recommendation.confidence}\n- Recommendation: ${recommendation.text}\n- Supporting findings: ${[...recommendation.supportingFindingIds].sort().join(", ") || "none"}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}
