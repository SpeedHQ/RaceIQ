import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EligibilityDecision, EligibilityPolicyId, EligibilityStatus, LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { LapBreakdown } from "../src/components/tunes/experiment/LapBreakdown";

function decision(policyId: EligibilityPolicyId, status: EligibilityStatus, reason: EligibilityDecision["reasons"][number]["code"] | null = null): EligibilityDecision {
  return {
    policyId,
    policyVersion: "1",
    status,
    confidence: { level: status === "unknown" ? "unknown" : "high", score: status === "unknown" ? null : 1 },
    reasons: reason
      ? [
          {
            code: reason,
            severity: status === "eligible_with_warning" ? "warning" : "error",
            evidenceIds: [`reason:${reason}`],
            timeRange: null,
            distanceRange: null,
            semanticIds: [],
          },
        ]
      : [],
    evidenceIds: [],
  };
}

const exactQuality = {
  lifecycleState: "exact",
  facts: [],
  channelQuality: [],
} as unknown as LapQualitySummary;

function lap(id: number, isValid: boolean, cornerDecision: EligibilityDecision = decision("corner-trace", "eligible")): LapMeta {
  return {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime: 90 + id,
    isValid,
    invalidReason: isValid ? null : "telemetry distance too short",
    experimentExcluded: false,
    eligibility: {
      "normal-pace": decision("normal-pace", "eligible"),
      "corner-trace": cornerDecision,
    },
    quality: exactQuality,
  } as unknown as LapMeta;
}

function renderBreakdown(values: LapMeta[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <LapBreakdown laps={values} bestT={null} metricsById={new Map()} />
    </QueryClientProvider>,
  );
}

describe("Tune Review lap quality presentation", () => {
  test("shows exact rejecting policy status and first decisive reason", () => {
    const markup = renderBreakdown([lap(1, true), lap(2, true), lap(3, true), lap(7, true, decision("corner-trace", "ineligible", "channel_missing"))]);

    expect(markup).toContain('data-eligibility-policy="corner-trace"');
    expect(markup).toContain('data-eligibility-status="ineligible"');
    expect(markup).toContain("Not suitable");
    expect(markup).toContain("Required telemetry channel is missing.");
    expect(markup).toContain("Corner trace — Not suitable: Required telemetry channel is missing.");

    const action = markup.match(/<button[^>]*aria-label="Exclude lap 7\.[^"]*"[^>]*>/)?.[0] ?? "";
    expect(action).not.toBe("");
    expect(action).toMatch(/\sdisabled=""/);
    expect(action).toContain("Not suitable: Required telemetry channel is missing.");
  });

  test("keeps structural validity informational when group setup policy permits action", () => {
    const markup = renderBreakdown([lap(1, true), lap(2, true), lap(3, true), lap(4, false)]);

    expect(markup).toContain('data-lap-status="invalid"');
    expect(markup).toContain('data-eligibility-policy="setup-analysis"');
    expect(markup).toContain('data-eligibility-status="eligible"');
    expect(markup).toContain("Setup analysis — Suitable");
    const action = markup.match(/<button[^>]*aria-label="Exclude lap 4"[^>]*>/)?.[0] ?? "";
    expect(action).not.toBe("");
    expect(action).not.toMatch(/\sdisabled=""/);
  });
});
