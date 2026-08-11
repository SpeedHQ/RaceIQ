import { describe, expect, test } from "bun:test";
import type { EligibilityDecision, LapQualitySummary, QualityFact } from "../../shared/racing/quality/contracts";
import { diagnosticReasons, localizedEligibilityDecisionPresentation, localizedEligibilityDecisionText, resolveLapQualityLevel } from "../../client/src/components/LapQualityBadge";

function quality(lifecycleState: LapQualitySummary["lifecycleState"]): LapQualitySummary {
  return { lifecycleState } as unknown as LapQualitySummary;
}

function decision(status: EligibilityDecision["status"]): EligibilityDecision {
  return {
    policyId: "corner-trace",
    policyVersion: "1",
    status,
    confidence: { level: status === "unknown" ? "unknown" : "high", score: status === "unknown" ? null : 1 },
    reasons: [],
    evidenceIds: [],
  };
}

describe("lap quality badge state", () => {
  test("distinguishes clean, limited, unsuitable, and unknown evidence", () => {
    expect(resolveLapQualityLevel(quality("exact"), decision("eligible"))).toBe("good");
    expect(resolveLapQualityLevel(quality("minor_gaps"), decision("eligible"))).toBe("degraded");
    expect(resolveLapQualityLevel(quality("exact"), decision("eligible_with_warning"))).toBe("degraded");
    expect(resolveLapQualityLevel(quality("exact"), decision("ineligible"))).toBe("unsuitable");
    expect(resolveLapQualityLevel(quality("exact"), decision("unknown"))).toBe("unknown");
    expect(resolveLapQualityLevel(null, null)).toBe("unknown");
  });

  test("exposes persisted status and first decisive localized reason for blocked actions", () => {
    const blocked = decision("ineligible");
    blocked.reasons = [
      {
        code: "channel_missing",
        severity: "error",
        evidenceIds: ["channel:motion.speed"],
        timeRange: { startMs: 1_000, endMs: 2_000 },
        distanceRange: { startFraction: 0.2, endFraction: 0.3 },
        semanticIds: ["motion.speed"],
      },
      {
        code: "partial_track_coverage",
        severity: "error",
        evidenceIds: ["coverage"],
        timeRange: null,
        distanceRange: null,
        semanticIds: [],
      },
    ];

    expect(localizedEligibilityDecisionPresentation(blocked)).toEqual({
      status: "Not suitable",
      firstReason: "Required telemetry channel is missing.",
      text: "Not suitable: Required telemetry channel is missing.",
    });
    expect(localizedEligibilityDecisionText(blocked)).toBe("Not suitable: Required telemetry channel is missing.");
  });

  test("preserves exact persisted warning and unknown statuses without invented limits", () => {
    expect(localizedEligibilityDecisionPresentation(decision("eligible_with_warning"))).toEqual({
      status: "Suitable with limits",
      firstReason: null,
      text: "Suitable with limits",
    });
    expect(localizedEligibilityDecisionText(undefined)).toBe("Unknown");
  });

  test("keeps disjoint quality ranges separate in diagnostics", () => {
    const measured = quality("minor_gaps");
    const provenance = {
      schemaVersion: "1",
      policyVersion: "1",
      configurationVersion: "1",
      sourceGeneration: "sha256:source",
      outputGeneration: "sha256:output",
    };
    const gap = (id: string, startFraction: number, endFraction: number): QualityFact => ({
      id,
      code: "telemetry_gap_minor",
      severity: "warning",
      timeRange: null,
      distanceRange: { startFraction, endFraction },
      semanticIds: [],
      channelFamilies: [],
      provenance,
      eventIds: [],
    });
    measured.facts = [gap("gap:one", 0.1, 0.2), gap("gap:two", 0.8, 0.9)];

    expect(
      diagnosticReasons(measured, [])
        .filter(({ code }) => code === "telemetry_gap_minor")
        .map(({ distanceRange }) => distanceRange),
    ).toEqual([
      { startFraction: 0.1, endFraction: 0.2 },
      { startFraction: 0.8, endFraction: 0.9 },
    ]);
  });
});
