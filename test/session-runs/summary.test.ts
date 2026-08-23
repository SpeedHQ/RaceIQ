import { describe, expect, test } from "bun:test";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import type { SessionRunId } from "../../shared/racing/runs/contracts";

import { deriveSessionRunSummary } from "../../shared/racing/runs/summary";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

const runId = `session-run:sha256:${"a".repeat(64)}` as SessionRunId;

function eligibleLap(lapNumber: number, lapTimeMs: number) {
  const finalized = finalizeLapQualityGeneration(
    summarize(qualityPackets(200)),
    `summary-source-${lapNumber}`,
    { lapNumber, rawByteOffset: 0, rawFrameCount: 200 },
  );
  return {
    lapEventId: `race-event:sha256:${lapNumber.toString(16).padStart(64, "0")}` as RaceEventId,
    lapId: lapNumber,
    lapNumber,
    lapTimeMs,
    isValid: true,
    phase: "flying" as const,
    conditions: [] as const,
    quality: finalized.quality,
    eligibility: finalized.eligibility,
    qualityGeneration: finalized.quality.provenance.outputGeneration,
  };
}

describe("session run summary", () => {
  test("uses every membership and shared normal-pace/falloff policy", () => {
    const summary = deriveSessionRunSummary({
      runId,
      runKind: "pace",
      laps: [
        eligibleLap(1, 90_000),
        eligibleLap(2, 91_000),
        eligibleLap(3, 92_000),
      ],
    });

    expect(summary.membershipCount).toBe(3);
    expect(summary.normalPaceLapCount).toBe(3);
    expect(summary.bestLapTimeS).toBe(90);
    expect(summary.medianLapTimeS).toBe(91);
    expect(summary.meanLapTimeS).toBe(91);
    expect(summary.degradationSlopeSPerLap).toBe(1);
    expect(summary.falloffEligibility.policyId).toBe("stint-falloff");
  });

  test("keeps structural membership and reports unavailable metrics as null", () => {
    const summary = deriveSessionRunSummary({
      runId,
      runKind: "tire",
      laps: [],
      membershipCount: 1,
      qualityLimitations: ["participant_identity_unavailable"],
    });

    expect(summary.membershipCount).toBe(1);
    expect(summary.completedLapCount).toBe(0);
    expect(summary.bestLapTimeS).toBeNull();
    expect(summary.meanLapTimeS).toBeNull();
    expect(summary.degradationSlopeSPerLap).toBeNull();
    expect(summary.qualityLimitations).toEqual([
      "falloff_unavailable",
      "lap_metadata_unavailable",
      "normal_pace_unavailable",
      "participant_identity_unavailable",
      "repeatability_unavailable",
    ]);
  });
});
