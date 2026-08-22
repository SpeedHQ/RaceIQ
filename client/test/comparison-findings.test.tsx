import { describe, expect, test } from "bun:test";
import type { ComparisonData } from "../../shared/racing/comparison/types";
import { FINDING_SCHEMA_VERSION, type FindingRecord } from "../../shared/racing/findings/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonFindings } from "../src/components/comparison/ComparisonCharts";
import { telemetryForFindingEvidence } from "../src/components/comparison/LapComparison";

const serverFinding: FindingRecord = {
  schemaVersion: FINDING_SCHEMA_VERSION,
  id: "comparison-turn-1",
  type: "corner-time-comparison",
  category: "pace",
  scope: { kind: "comparison", gameId: "acc", sessionId: "7", cornerId: "Turn 1" },
  status: "available",
  severity: "medium",
  confidence: "high",
  measurements: [{
    id: "comparison:41:52:Turn 1:delta",
    type: "lap-a-minus-lap-b-time-delta",
    value: -0.25,
    unit: "s",
    sampleCount: 7,
    confidence: "high",
    semanticIds: ["timing.current-lap"],
    derivation: { id: "lap-comparison-adapter", version: "1" },
  }],
  evidenceRefs: [
    { kind: "telemetry-range", id: "range:41:Turn 1:0:comparison-a", lapId: "41", sessionId: "7", startFrameIndex: 12, endFrameIndex: 18 },
    { kind: "telemetry-range", id: "range:52:Turn 1:0:comparison-b", lapId: "52", sessionId: "9", startFrameIndex: 20, endFrameIndex: 27 },
  ],
  qualityRefs: [],
  limitations: [],
  rule: { id: "lap-comparison-adapter", version: "1", inputs: { signConvention: "lap-a-minus-lap-b" } },
  analysisGenerationId: "comparison:41:52",
  comparisonReference: {
    id: "lap:52",
    kind: "lap",
    selectionReason: "selected fastest valid reference lap",
    evidenceRefs: [{ kind: "lap", id: "lap:52", lapId: "52", sessionId: "9" }],
  },
  title: "Turn 1 A-minus-B time delta",
};

describe("ComparisonFindings", () => {
  test("renders server finding fields without recomputing comparison result", () => {
    const response: Pick<ComparisonData, "findings"> = { findings: [serverFinding] };
    const markup = renderToStaticMarkup(createElement(ComparisonFindings, {
      comparison: response,
      onEvidenceSelect: () => {},
    }));

    expect(markup).toContain("Turn 1 A-minus-B time delta");
    expect(markup).toContain("Pace");
    expect(markup).toContain("Available");
    expect(markup).toContain("High confidence");
    expect(markup).toContain("-0.25 s");
    expect(markup).toContain("7 samples");
    expect(markup).toContain("selected fastest valid reference lap");
    expect(markup).toContain("frames 12–18");
    expect(markup).toContain("frames 20–27");
    expect(markup).not.toContain("+0.25 s");
  });

  test("routes telemetry evidence to evidence lap rather than always using lap A", () => {
    const comparison: Pick<ComparisonData, "lapA" | "lapB" | "telemetryA" | "telemetryB"> = {
      lapA: { id: 41, sessionId: 7, lapNumber: 1, lapTime: 92, isValid: true, trackOrdinal: 11, carOrdinal: 1 },
      lapB: { id: 52, sessionId: 9, lapNumber: 2, lapTime: 91, isValid: true, trackOrdinal: 11, carOrdinal: 2 },
      telemetryA: [{ sequence: "a-0", observedAtMs: 0, values: { "timing.distance-traveled": 100 } }],
      telemetryB: [{ sequence: "b-0", observedAtMs: 0, values: { "timing.distance-traveled": 200 } }],
    };

    expect(telemetryForFindingEvidence(comparison, serverFinding.evidenceRefs[0]!)).toBe(comparison.telemetryA);
    expect(telemetryForFindingEvidence(comparison, serverFinding.evidenceRefs[1]!)).toBe(comparison.telemetryB);
  });
});
