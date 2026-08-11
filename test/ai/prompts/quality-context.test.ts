import { describe, expect, test } from "bun:test";
import type { EligibilityDecisionSet } from "../../../shared/racing/quality/contracts";
import { buildQualityPromptContext } from "../../../server/ai/quality-context";

function decisions(): Partial<EligibilityDecisionSet> {
  return {
    "corner-trace": {
      policyId: "corner-trace",
      policyVersion: "1",
      status: "eligible_with_warning",
      confidence: { level: "medium", score: 0.81 },
      reasons: [
        {
          code: "telemetry_gap_minor",
          severity: "warning",
          evidenceIds: ["gap:turn-5"],
          timeRange: { startMs: 12_000, endMs: 12_200 },
          distanceRange: { startFraction: 0.4, endFraction: 0.45 },
          semanticIds: ["motion.speed", "inputs.brake"],
        },
      ],
      evidenceIds: ["gap:turn-5"],
    },
  };
}

describe("AI quality prompt context", () => {
  test("includes persisted decision, reason code, affected range, and generation", () => {
    const context = buildQualityPromptContext(
      { eligibility: decisions(), qualityGeneration: "sha256:quality-generation" },
      ["corner-trace"],
    );

    expect(context).toContain("corner-trace: eligible_with_warning; confidence=medium");
    expect(context).toContain("telemetry_gap_minor: Telemetry contains a short gap. (40-45% of lap)");
    expect(context).toContain("quality-generation: sha256:quality-generation");
    expect(context).toContain("avoid claims inside affected ranges");
  });

  test("marks missing policy evidence unknown instead of silently allowing it", () => {
    const context = buildQualityPromptContext({}, ["transient-event"]);

    expect(context).toContain("transient-event: unknown");
    expect(context).toContain("quality_not_rebuilt");
    expect(context).toContain("quality-generation: unknown");
  });
});
