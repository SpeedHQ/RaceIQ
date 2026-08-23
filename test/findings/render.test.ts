import { describe, expect, test } from "bun:test";
import { createFindingId } from "../../shared/racing/findings/identity";
import { renderFindingsReport } from "../../shared/racing/findings/render";
import { FINDING_SCHEMA_VERSION, type FindingRecommendation, type FindingRecord } from "../../shared/racing/findings/types";

function finding(type: string, status: FindingRecord["status"]): FindingRecord {
  const record: FindingRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "pending",
    type,
    category: "pace",
    scope: { kind: "lap", gameId: "f1-2025", sessionId: "session-1", lapId: `lap-${type}` },
    status,
    severity: "medium",
    confidence: "low",
    measurements: status === "available"
      ? [{ id: "loss", type: "time-loss", value: 0.125, unit: "s", sampleCount: 12, confidence: "low", semanticIds: ["speed"], derivation: { id: "comparison", version: "1" } }]
      : [{ id: "fuel", type: "fuel-use", value: null, unit: "L/lap", sampleCount: 0, confidence: "unknown", semanticIds: ["fuel"], derivation: { id: "fuel", version: "1" }, unavailableReason: "fuel-channel-missing" }],
    evidenceRefs: [{ kind: "telemetry-range", id: `range-${type}`, lapId: `lap-${type}`, startFrameIndex: 12, endFrameIndex: 34, startTimestampMs: 1200, endTimestampMs: 3400, channel: "speed" }],
    qualityRefs: [],
    limitations: status === "available" ? [] : [{ code: "insufficient-clean-laps", detail: "No clean reference lap" }],
    rule: { id: "report-rule", version: "1", inputs: {} },
    analysisGenerationId: "generation-1",
  };
  record.id = createFindingId(record);
  return record;
}

const recommendation: FindingRecommendation = {
  id: "recommendation-1",
  kind: "practice",
  text: "Review braking trace.",
  supportingFindingIds: ["finding-z", "finding-a"],
  confidence: "low",
};

describe("deterministic findings report", () => {
  test("is stable across finding, evidence, and recommendation insertion order", () => {
    const first = finding("z-finding", "available");
    const second = finding("a-finding", "indeterminate");
    const reorderedFirst = { ...first, evidenceRefs: [...first.evidenceRefs].reverse() };
    expect(renderFindingsReport([first, second], [recommendation])).toBe(renderFindingsReport([second, reorderedFirst], [{ ...recommendation, supportingFindingIds: [...recommendation.supportingFindingIds].reverse() }]));
  });

  test("renders exact status, reason, confidence, measurements, units, samples, and evidence ranges", () => {
    const report = renderFindingsReport([finding("fuel-usage", "unavailable")]);
    expect(report).toContain("- Scope: lap (game=f1-2025, session=session-1, lap=lap-fuel-usage)");
    expect(report).toContain("- Status: unavailable");
    expect(report).toContain("- Confidence: low");
    expect(report).toContain("- Reason: insufficient-clean-laps — No clean reference lap");
    expect(report).toContain("fuel-use [fuel]: unavailable: fuel-channel-missing L/lap (samples=0; confidence=unknown)");
    expect(report).toContain("lap=lap-fuel-usage; frames=12–34; timestamps-ms=1200–3400; channel=speed");
  });

  test("renders recommendations separately and never invents explanation", () => {
    const report = renderFindingsReport([finding("time-loss", "available")], [recommendation]);
    expect(report).toContain("# Recommendations");
    expect(report).toContain("- Supporting findings: finding-a, finding-z");
    expect(report).not.toContain("because");
    expect(report).not.toContain("caused");
  });
});
