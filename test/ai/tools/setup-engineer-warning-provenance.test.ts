import { describe, expect, test } from "bun:test";
import { buildSetupEngineerLapSummaries } from "../../../mastra/tools/setup-engineer";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import { ELIGIBILITY_POLICY_VERSION, type EligibilityReason } from "../../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../../shared/racing/quality/policies";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";

const warning: EligibilityReason = {
  code: "channel_simplified",
  severity: "warning",
  evidenceIds: ["source-channel-profile:steering"],
  timeRange: null,
  distanceRange: null,
  semanticIds: ["inputs.steer"],
};

function warnedLap(id: number, lapTime: number): LapMeta {
  const quality = summarize(qualityPackets(100));
  const eligibility = evaluateAllEligibility(quality);
  eligibility["corner-trace"] = {
    ...eligibility["corner-trace"],
    status: "eligible_with_warning",
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    reasons: [warning],
    evidenceIds: warning.evidenceIds,
  };
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
  test("reports warning status and reason codes for selected laps", () => {
    const rows = buildSetupEngineerLapSummaries([warnedLap(1, 90), warnedLap(2, 90.1), warnedLap(3, 89.9)]);

    expect(rows.every(({ analysisEligible }) => analysisEligible)).toBe(true);
    expect(rows.map(({ eligibilityStatus }) => eligibilityStatus)).toEqual(["eligible_with_warning", "eligible_with_warning", "eligible_with_warning"]);
    expect(rows.every(({ reasonCodes }) => reasonCodes.includes("channel_simplified"))).toBe(true);
  });
});
