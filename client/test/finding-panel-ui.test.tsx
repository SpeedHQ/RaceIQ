import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FINDING_SCHEMA_VERSION, type FindingNarrative, type FindingRecord } from "../../shared/racing/findings/types";
import { FindingPanel } from "../src/components/FindingPanel";

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "finding-1",
    type: "corner.time-loss",
    category: "driving",
    scope: { kind: "lap", gameId: "acc", sessionId: "session-1", lapId: "17" },
    status: "available",
    severity: "medium",
    confidence: "high",
    measurements: [],
    evidenceRefs: [],
    qualityRefs: [],
    limitations: [],
    rule: { id: "corner-time-loss", version: "1", inputs: {} },
    analysisGenerationId: "generation-1",
    title: "Corner time loss",
    ...overrides,
  };
}

describe("FindingPanel", () => {
  test("renders typed measurements, evidence, and exact frame navigation", () => {
    const markup = renderToStaticMarkup(
      createElement(FindingPanel, {
        findings: [finding({
          measurements: [{
            id: "time-loss",
            type: "time-loss",
            value: { min: 0.18, max: 0.24 },
            unit: "s",
            sampleCount: 4,
            confidence: "high",
            semanticIds: ["timing.current-lap"],
            derivation: { id: "existing-insight", version: "1" },
          }],
          evidenceRefs: [
            { kind: "lap", id: "lap-17", lapId: "17" },
            { kind: "telemetry-range", id: "event-1", lapId: "17", startFrameIndex: 12, endFrameIndex: 18, channel: "inputs.brake" },
            { kind: "telemetry-range", id: "event-2", lapId: "17", startFrameIndex: 31, endFrameIndex: 31, channel: "inputs.brake" },
          ],
          qualityRefs: [{ kind: "quality-decision", id: "quality-1", decisionId: "clean-lap", decision: "accepted" }],
        })],
        onEvidenceSelect: () => {},
      }),
    );

    expect(markup).toContain("Corner time loss");
    expect(markup).toContain("Driving");
    expect(markup).toContain("Available");
    expect(markup).toContain("Medium severity");
    expect(markup).toContain("High confidence");
    expect(markup).toContain("0.18–0.24 s");
    expect(markup).toContain("4 samples");
    expect(markup).toContain("frames 12–18");
    expect(markup).toContain('data-frame-index="12"');
    expect(markup).toContain("1/2");
    expect(markup).toContain("quality-1");
  });

  test("renders only valid narratives linked to each finding", () => {
    const narratives = [
      {
        id: "narrative-1",
        findingIds: ["finding-1"],
        text: "Release brake fully before applying throttle.",
        generator: "lap-insight-adapter",
        generationId: "generation-1",
      },
      {
        id: "narrative-unlinked",
        findingIds: ["other-finding"],
        text: "Unlinked guidance must stay hidden.",
        generator: "lap-insight-adapter",
        generationId: "generation-1",
      },
      {
        id: "narrative-malformed",
        findingIds: "finding-1",
        text: "Malformed guidance must stay hidden.",
        generator: "lap-insight-adapter",
        generationId: "generation-1",
      },
    ] as unknown as FindingNarrative[];
    const markup = renderToStaticMarkup(createElement(FindingPanel, {
      findings: [finding()],
      narratives,
      onEvidenceSelect: () => {},
    }));

    expect(markup).toContain("Guidance");
    expect(markup).toContain("Release brake fully before applying throttle.");
    expect(markup).not.toContain("Unlinked guidance must stay hidden.");
    expect(markup).not.toContain("Malformed guidance must stay hidden.");
  });

  test("renders comparison reference selection and evidence", () => {
    const markup = renderToStaticMarkup(createElement(FindingPanel, {
      findings: [finding({
        comparisonReference: {
          id: "lap:52",
          kind: "reference-lap",
          selectionReason: "Selected fastest valid lap",
          evidenceRefs: [{ kind: "telemetry-range", id: "reference-range", lapId: "52", startFrameIndex: 20, endFrameIndex: 35 }],
        },
      })],
      onEvidenceSelect: () => {},
    }));

    expect(markup).toContain("Comparison reference");
    expect(markup).toContain("lap:52");
    expect(markup).toContain("Selected fastest valid lap");
    expect(markup).toContain("reference-range");
  });

  test("explains unavailable and indeterminate findings without inventing zero values", () => {
    const markup = renderToStaticMarkup(
      createElement(FindingPanel, {
        findings: [
          finding({
            id: "unavailable",
            type: "fuel.use",
            title: "Fuel use",
            category: "strategy",
            status: "unavailable",
            severity: "informational",
            confidence: "unknown",
            measurements: [{
              id: "fuel-use",
              type: "fuel-use",
              value: null,
              unit: "L/lap",
              sampleCount: 0,
              confidence: "unknown",
              semanticIds: ["fuel.fuel"],
              derivation: { id: "fuel-model", version: "1" },
              unavailableReason: "Fuel channel was not recorded",
            }],
            limitations: [{ code: "missing-fuel-channel", detail: "Fuel channel was not recorded" }],
          }),
          finding({
            id: "indeterminate",
            type: "corner.balance",
            title: "Corner balance",
            status: "indeterminate",
            severity: "high",
            confidence: "low",
            limitations: [{ code: "insufficient-samples", detail: "Two samples cannot establish a pattern" }],
          }),
        ],
        onEvidenceSelect: () => {},
      }),
    );

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Fuel channel was not recorded");
    expect(markup).toContain("Indeterminate");
    expect(markup).toContain("Two samples cannot establish a pattern");
    expect(markup).toContain("Low confidence");
    expect(markup).not.toContain("0 L/lap");
  });

  test("renders evidence-backed empty state", () => {
    const markup = renderToStaticMarkup(createElement(FindingPanel, { findings: [], onEvidenceSelect: () => {} }));

    expect(markup).toContain('role="status"');
    expect(markup).toContain("No deterministic findings");
    expect(markup).toContain("no evidence-backed issues");
  });
});
