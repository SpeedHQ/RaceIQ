import { describe, expect, test } from "bun:test";
import type { EligibilityDecision, EligibilityPolicyId, EligibilityReason } from "../../shared/racing/quality/contracts";
import { resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import { diagnosticReasons, formatReasonRange, mergeQualityDialogDecisions } from "../src/components/LapQualityBadge";
import { getLocale, overwriteGetLocale, type Locale } from "../src/paraglide/runtime";

function decision(policyId: EligibilityPolicyId, reasons: EligibilityReason[] = []): EligibilityDecision {
  return {
    policyId,
    policyVersion: "1",
    status: reasons.length > 0 ? "unknown" : "eligible",
    confidence: { level: reasons.length > 0 ? "unknown" : "high", score: reasons.length > 0 ? null : 1 },
    reasons,
    evidenceIds: reasons.flatMap((reason) => reason.evidenceIds),
  };
}

function reason(startMs: number, endMs: number): EligibilityReason {
  return {
    code: "telemetry_gap_major",
    severity: "error",
    evidenceIds: [],
    timeRange: { startMs, endMs },
    distanceRange: null,
    semanticIds: [],
  };
}

describe("lap quality dialog decisions", () => {
  test("includes resolved fallback decision for selected missing policy", () => {
    const persisted = decision("setup-analysis");
    const fallback = resolveEligibilityDecision({}, "corner-trace");

    const merged = mergeQualityDialogDecisions([persisted], "corner-trace", fallback);

    expect(merged.map((item) => item.policyId)).toEqual(["setup-analysis", "corner-trace"]);
    expect(diagnosticReasons(null, merged).map((item) => item.code)).toContain("quality_not_rebuilt");
  });

  test("assigns stable unique keys to repeated reason codes at different ranges", () => {
    const repeated = decision("corner-trace", [reason(100, 200), reason(300, 400)]);

    const first = diagnosticReasons(null, [repeated]);
    const second = diagnosticReasons(null, [repeated]);

    expect(first).toHaveLength(2);
    expect(new Set(first.map((item) => item.key)).size).toBe(2);
    expect(first.map((item) => item.key)).toEqual(second.map((item) => item.key));
  });

  test("formats German diagnostic time and distance ranges with Intl", () => {
    const previousLocale = getLocale();
    overwriteGetLocale(() => "de" as Locale);
    try {
      expect(formatReasonRange({ ...reason(1_250, 2_500), key: "time", eventIds: [] })).toContain("1,25–2,5 s");
      expect(
        formatReasonRange({
          ...reason(0, 0),
          key: "distance",
          eventIds: [],
          distanceRange: { startFraction: 0.125, endFraction: 0.5 },
        }),
      ).toContain("12,5 %–50 %");
    } finally {
      overwriteGetLocale(() => previousLocale);
    }
  });
});
