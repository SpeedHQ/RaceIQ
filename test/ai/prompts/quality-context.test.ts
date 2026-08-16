import { describe, expect, test } from "bun:test";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../../shared/racing/quality/contracts";
import { buildQualityPromptContext, formatQualityPromptReason } from "../../../server/ai/quality-context";
import { qualityReasonText } from "../../../shared/racing/quality/display";

function decisions(): Partial<EligibilityDecisionSet> {
  return {
    "corner-trace": {
      policyId: "corner-trace",
      policyVersion: ELIGIBILITY_POLICY_VERSION,
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

function quality(generation: string): LapQualitySummary {
  return {
    provenance: {
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: "sha256:quality-source",
      outputGeneration: generation,
    },
  } as LapQualitySummary;
}

describe("AI quality prompt context", () => {
  test("includes persisted decision, reason code, affected range, and generation", () => {
    const generation = "sha256:quality-generation";
    const context = buildQualityPromptContext({ quality: quality(generation), eligibility: decisions(), qualityGeneration: generation }, ["corner-trace"]);

    expect(context).toContain("corner-trace: eligible_with_warning; confidence=medium");
    expect(context).toContain(
      'code=telemetry_gap_minor; evidenceIds=["gap:turn-5"]; semanticIds=["motion.speed","inputs.brake"]; timeRange={"startMs":12000,"endMs":12200}; distanceRange={"startFraction":0.4,"endFraction":0.45}; message=Telemetry contains a short gap. (12.0-12.2s, 40-45% of lap)',
    );
    expect(context).toContain("quality-generation: sha256:quality-generation");
    expect(context).toContain("avoid claims inside affected ranges");
  });

  test("serializes complete reason provenance without changing ids, ranges, or precision", () => {
    expect(
      formatQualityPromptReason({
        code: "traffic_context",
        evidenceIds: ["event:z", "event:a"],
        semanticIds: ["motion.speed", "inputs.brake"],
        timeRange: { startMs: 12000.125, endMs: 12200.875 },
        distanceRange: { startFraction: 0.40001, endFraction: 0.45009 },
      }),
    ).toBe(
      'code=traffic_context; evidenceIds=["event:z","event:a"]; semanticIds=["motion.speed","inputs.brake"]; timeRange={"startMs":12000.125,"endMs":12200.875}; distanceRange={"startFraction":0.40001,"endFraction":0.45009}; message=Traffic evidence affects this range. (12.0-12.2s, 40-45% of lap)',
    );
    expect(formatQualityPromptReason({ code: "traffic_context", timeRange: { startMs: 1000, endMs: 2500 } })).toBe(
      'code=traffic_context; evidenceIds=[]; semanticIds=[]; timeRange={"startMs":1000,"endMs":2500}; distanceRange=null; message=Traffic evidence affects this range. (1.0-2.5s)',
    );
    expect(formatQualityPromptReason({ code: "traffic_context", distanceRange: { startFraction: 0.1, endFraction: 0.2 } })).toBe(
      'code=traffic_context; evidenceIds=[]; semanticIds=[]; timeRange=null; distanceRange={"startFraction":0.1,"endFraction":0.2}; message=Traffic evidence affects this range. (10-20% of lap)',
    );
    expect(formatQualityPromptReason({ code: "traffic_context" })).toBe(
      "code=traffic_context; evidenceIds=[]; semanticIds=[]; timeRange=null; distanceRange=null; message=Traffic evidence affects this range.",
    );
    expect(qualityReasonText("traffic_context", { startMs: 1000, endMs: 2500 }, { startFraction: 0.1, endFraction: 0.2 })).toBe("Traffic evidence affects this range. (1.0-2.5s, 10-20% of lap)");
  });
  test("marks missing policy evidence unknown instead of silently allowing it", () => {
    const context = buildQualityPromptContext({}, ["transient-event"]);

    expect(context).toContain("transient-event: unknown");
    expect(context).toContain("quality_not_rebuilt");
    expect(context).toContain("quality-generation: unknown");
  });
});
