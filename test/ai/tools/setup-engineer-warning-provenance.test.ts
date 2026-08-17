import { describe, expect, test } from "bun:test";
import { buildSetupEngineerLapSummaries } from "../../../mastra/tools/setup-engineer";
import { renderSetupEngineerQualityProvenance } from "../../../mastra/workflows/setup-engineer-turn";
import { selectCleanLaps } from "../../../server/experiments/lap-evidence/aggregate";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import { ELIGIBILITY_POLICY_VERSION, type EligibilityReason } from "../../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../../shared/racing/quality/policies";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";
import { finalizeLapQualityGeneration } from "../../../server/lap-analysis/quality-generation";

const warning: EligibilityReason = {
  code: "channel_simplified",
  severity: "warning",
  evidenceIds: ["source-channel-profile:steering"],
  timeRange: null,
  distanceRange: null,
  semanticIds: ["inputs.steer"],
};

function lapEvidence(id: number, lapTime: number, warned = false): LapMeta {
  const generated = finalizeLapQualityGeneration(summarize(qualityPackets(100)), `sha256:${"b".repeat(64)}`, {
    lapNumber: id,
    rawByteOffset: null,
    rawFrameCount: 100,
  });
  const quality = generated.quality;
  const eligibility = generated.eligibility;
  for (const policyId of ["normal-pace", "corner-trace"] as const) {
    eligibility[policyId] = {
      ...eligibility[policyId],
      status: "eligible",
      confidence: { level: "high", score: 1 },
      reasons: [],
      evidenceIds: [],
    };
  }
  if (warned) {
    eligibility["corner-trace"] = {
      ...eligibility["corner-trace"],
      status: "eligible_with_warning",
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      reasons: [warning],
      evidenceIds: warning.evidenceIds,
    };
  }
  return {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime,
    isValid: true,
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
    createdAt: "2026-01-01T00:00:00.000Z",
    quality,
    eligibility,
    qualityGeneration: quality.provenance.outputGeneration,
    qualityStale: false,
  };
}

describe("Setup Engineer lap warning provenance", () => {
  test("keeps one warned lap local while clean selected laps remain clean", () => {
    const result = buildSetupEngineerLapSummaries([lapEvidence(1, 90, true), lapEvidence(2, 90.1), lapEvidence(3, 89.9)]);
    const warned = result.laps.find((row) => row.lapId === 1);
    const clean = result.laps.filter((row) => row.lapId !== 1);

    expect(result.setupAnalysis.status).toBe("eligible_with_warning");
    expect(result.setupAnalysis.reasons).toEqual([warning]);
    expect(result.laps.every(({ analysisEligible }) => analysisEligible)).toBe(true);
    expect(warned?.cornerTrace).toEqual({ status: "eligible_with_warning", reasons: [warning] });
    expect(clean.every((row) => row.cornerTrace.status === "eligible" && row.cornerTrace.reasons.length === 0)).toBe(true);
    expect(clean.every((row) => row.normalPace.reasons.length === 0)).toBe(true);
    expect(result.laps.every((row) => row.qualityGeneration != null)).toBe(true);
  });

  test("keeps manual rows on selection provenance without copying group warnings", () => {
    const manual = { ...lapEvidence(4, 90.2), experimentExcluded: true, experimentExcludedSource: "manual" as const };
    const result = buildSetupEngineerLapSummaries([lapEvidence(1, 90, true), lapEvidence(2, 90.1), lapEvidence(3, 89.9), manual]);
    const row = result.laps.find((candidate) => candidate.lapId === 4);
    expect(row).toMatchObject({
      analysisEligible: false,
      selectionReason: "manual",
      selectionReasonCodes: [],
      normalPace: { status: "eligible", reasons: [] },
      cornerTrace: { status: "eligible", reasons: [] },
    });
  });

  test("workflow renders group warning once and only warned lap carries local reason", () => {
    const laps = [lapEvidence(1, 90, true), lapEvidence(2, 90.1), lapEvidence(3, 89.9)];
    const selected = selectCleanLaps(laps);
    const rendered = renderSetupEngineerQualityProvenance({
      setupDecision: selected.setupDecision,
      lapBreakdown: selected.breakdown,
    });
    expect(rendered.confidenceLines.filter((line) => line.includes("channel_simplified"))).toHaveLength(1);
    const warnedSection = rendered.lapBreakdown.split("lap 2:")[0]!;
    const cleanSection = rendered.lapBreakdown.slice(rendered.lapBreakdown.indexOf("lap 2:"));
    expect(warnedSection).toContain("quality-generation:");
    expect(warnedSection).toContain("corner-trace: eligible_with_warning");
    expect(warnedSection).toContain("code=channel_simplified");
    expect(cleanSection).not.toContain("code=channel_simplified");
  });
});
