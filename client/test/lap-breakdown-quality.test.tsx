import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecision,
  type EligibilityPolicyId,
  type EligibilityStatus,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { LapBreakdown } from "../src/components/tunes/experiment/LapBreakdown";
import { getLocale, overwriteGetLocale, type Locale } from "../src/paraglide/runtime";

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

const qualityGeneration = `sha256:${"f".repeat(64)}`;
const exactQuality = {
  lifecycleState: "exact",
  facts: [],
  channelQuality: [],
  provenance: {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    configurationVersion: QUALITY_CONFIG_VERSION,
    sourceGeneration: `sha256:${"a".repeat(64)}`,
    outputGeneration: qualityGeneration,
  },
} as unknown as LapQualitySummary;

function lap(id: number, isValid: boolean, cornerDecision: EligibilityDecision = decision("corner-trace", "eligible"), experimentExcluded = false): LapMeta {
  return {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime: 90 + id,
    isValid,
    invalidReason: isValid ? null : "telemetry distance too short",
    experimentExcluded,
    eligibility: {
      "normal-pace": decision("normal-pace", "eligible"),
      "corner-trace": cornerDecision,
    },
    quality: exactQuality,
    qualityGeneration,
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
  } as unknown as LapMeta;
}

function renderBreakdown(values: LapMeta[], locale: Locale = "en"): string {
  const previousLocale = getLocale();
  overwriteGetLocale(() => locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LapBreakdown laps={values} bestT={null} metricsById={new Map()} experimentId={1} />
      </QueryClientProvider>,
    );
  } finally {
    overwriteGetLocale(() => previousLocale);
  }
}

describe("Tune Review lap quality presentation", () => {
  test("shows exact rejecting policy status without blocking manual exclusion", () => {
    const markup = renderBreakdown([lap(1, true), lap(2, true), lap(3, true), lap(7, true, decision("corner-trace", "ineligible", "channel_missing"))]);

    expect(markup).toContain('data-eligibility-policy="corner-trace"');
    expect(markup).toContain('data-eligibility-status="ineligible"');
    expect(markup).toContain("Not suitable");
    expect(markup).toContain("Required telemetry channel is missing.");
    expect(markup).toContain("Corner trace — Not suitable: Required telemetry channel is missing.");

    const action = markup.match(/<button[^>]*aria-label="Exclude lap 7"[^>]*>/)?.[0] ?? "";
    expect(action).not.toBe("");
    expect(action).not.toMatch(/\sdisabled=""/);
    expect(action).not.toContain("Required telemetry channel is missing.");
  });

  test("lets excluded laps return to an otherwise ineligible sample pool", () => {
    const markup = renderBreakdown([lap(1, true), lap(2, true), lap(3, true), lap(7, true, decision("corner-trace", "ineligible", "channel_missing"), true)]);

    const action = markup.match(/<button[^>]*aria-label="Include lap 7"[^>]*>/)?.[0] ?? "";
    expect(action).not.toBe("");
    expect(action).not.toMatch(/\sdisabled=""/);
    expect(action).toContain("Include this lap in tuning aggregate again");
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

  test("localizes Tune Review quality controls and empty state in German", () => {
    const markup = renderBreakdown([lap(7, true, decision("corner-trace", "ineligible", "channel_missing"))], "de");
    const empty = renderBreakdown([], "de");

    expect(markup).toContain('title="Nach Runde sortieren"');
    expect(markup).toContain("Nach Qualitätsstatus der Kandidaten filtern.");
    expect(markup).toContain('aria-label="Runde 7 ausschließen"');
    expect(markup).toContain(">Ausschließen<");
    expect(markup).not.toContain("Exclude this lap");
    expect(empty).toContain("Für diese Version wurden noch keine Runden aufgezeichnet.");
  });
});
