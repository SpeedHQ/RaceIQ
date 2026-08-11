import { describe, expect, test } from "bun:test";
import { evaluateAllEligibility, evaluateEligibility, evaluateGroupEligibility, isEligibilityUsable } from "../../shared/racing/quality/policies";
import type { EligibilityDecisionSet, GroupEligibilityLap, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { qualityPackets, summarize } from "./quality-model.test";

function copyQuality(quality: LapQualitySummary): LapQualitySummary {
  return {
    ...quality,
    provenance: { ...quality.provenance },
    participant: { ...quality.participant },
    facts: quality.facts.map((fact) => ({
      ...fact,
      provenance: { ...fact.provenance },
      semanticIds: [...fact.semanticIds],
      channelFamilies: [...fact.channelFamilies],
      eventIds: [...fact.eventIds],
    })),
    channelQuality: quality.channelQuality.map((channel) => ({
      ...channel,
      resolutionCounts: { ...channel.resolutionCounts },
      freshnessCounts: { ...channel.freshnessCounts },
      boundaryCoverage: { ...channel.boundaryCoverage },
      issueIntervals: channel.issueIntervals.map((interval) => ({
        ...interval,
        timeRange: { ...interval.timeRange },
        distanceRange: interval.distanceRange ? { ...interval.distanceRange } : null,
      })),
      limitations: [...channel.limitations],
    })),
  };
}

function groupLap(quality: LapQualitySummary, lapTime: number): GroupEligibilityLap {
  return {
    lapTime,
    quality,
    eligibility: evaluateAllEligibility(quality),
    carTrackKey: "iracing:test-car:test-track",
  };
}

describe("eligibility policy registry", () => {
  test("keeps official timing eligible through irrelevant telemetry gaps", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(evaluateEligibility("official-timing", quality).status).toBe("eligible");
    expect(evaluateEligibility("normal-pace", quality).status).toBe("ineligible");
    expect(evaluateEligibility("lap-comparison", quality).status).toBe("ineligible");
  });

  test("applies gap evidence only when selected range overlaps", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.05, endFraction: 0.25 },
      }).status,
    ).not.toBe("ineligible");
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.4, endFraction: 0.6 },
      }).status,
    ).toBe("ineligible");
  });

  test("evaluates zero-width probe ranges for segment partitioning", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.15, endFraction: 0.15 },
      }).status,
    ).not.toBe("ineligible");
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.5, endFraction: 0.5 },
      }).status,
    ).toBe("ineligible");
  });

  test("multiplies required-channel confidence by lifecycle factor", () => {
    const quality = copyQuality(summarize(qualityPackets(200)));
    quality.lifecycleState = "minor_gaps";
    const speed = quality.channelQuality.find(({ semanticId }) => semanticId === "motion.speed")!;
    speed.coverage = 1;
    speed.confidenceMean = 0.9;
    speed.issueIntervals = [];

    const decision = evaluateEligibility("transient-event", quality, {
      requiredSemanticIds: ["motion.speed"],
    });
    expect(decision.confidence.score).toBeCloseTo(0.81, 8);
    expect(decision.confidence.level).toBe("medium");
  });

  test("rejects missing, stale, simplified, and unreliable derived transient channels", () => {
    const base = summarize(qualityPackets(200));
    const cases = [{ mappingStatus: "unavailable" as const }, { freshness: "stale" as const }, { mappingStatus: "simplified" as const }, { mappingStatus: "derived" as const }];
    for (const change of cases) {
      const quality = copyQuality(base);
      const channel = quality.channelQuality.find(({ semanticId }) => semanticId === "tires.tire-slip-ratio")!;
      if (change.mappingStatus) channel.mappingStatus = change.mappingStatus;
      if (change.freshness) {
        channel.freshnessCounts.fresh = 0;
        channel.freshnessCounts.stale = channel.expectedCount;
        channel.issueIntervals.push({
          state: "stale",
          freshness: "stale",
          timeRange: { startMs: 0, endMs: 10_000 },
          distanceRange: { startFraction: 0, endFraction: 1 },
          count: channel.expectedCount,
        });
      }
      expect(evaluateEligibility("transient-event", quality).status).toBe("ineligible");
    }
  });

  test("retains every missing required channel in decision evidence", () => {
    const quality = copyQuality(summarize(qualityPackets(200)));
    for (const semanticId of ["timing.distance-traveled", "motion.speed"] as const) {
      quality.channelQuality.find((channel) => channel.semanticId === semanticId)!.coverage = 0.5;
    }

    const missingChannels = evaluateEligibility("lap-comparison", quality).reasons
      .filter(({ code }) => code === "channel_missing")
      .flatMap(({ semanticIds }) => semanticIds);
    expect(missingChannels).toEqual(expect.arrayContaining(["timing.distance-traveled", "motion.speed"]));
  });

  test("accepts complete pit-only tire snapshots only in pit-snapshot mode", () => {
    const quality = summarize(qualityPackets(200));
    for (const semanticId of ["tire.temperature.average", "tires.tire-wear"] as const) {
      const channel = quality.channelQuality.find((candidate) => candidate.semanticId === semanticId)!;
      channel.mappingStatus = "direct";
      channel.limitations = ["pit-only snapshot"];
      channel.observedCount = 4;
      channel.coverage = 1;
      channel.confidenceMean = 1;
      channel.freshnessCounts.stale = 0;
    }
    expect(evaluateEligibility("tire-analysis", quality).status).toBe("ineligible");
    expect(evaluateEligibility("tire-analysis", quality, { tireMode: "pit-snapshot" }).status).toBe("eligible");
  });

  test("keeps caution and incident separate from partial lap", () => {
    const caution = summarize(qualityPackets(100), {
      classification: {
        phase: "flying",
        conditions: ["caution"],
        paceEligibility: "excluded",
      },
    });
    expect(evaluateEligibility("normal-pace", caution).reasons.map(({ code }) => code)).toContain("caution_context");

    const incidentPackets = qualityPackets(100);
    incidentPackets[incidentPackets.length - 1]!.iracing!.incidents = 1;
    const incident = summarize(incidentPackets);
    expect(evaluateEligibility("fuel-burn", incident).status).toBe("eligible_with_warning");

    const partial = summarize(qualityPackets(50), {
      complete: false,
      structurallyValid: false,
      invalidReason: "session ended",
      timingSource: "estimated",
    });
    expect(evaluateEligibility("official-timing", partial).status).toBe("ineligible");
    expect(evaluateEligibility("official-timing", partial).reasons.map(({ code }) => code)).toContain("partial_lap");
    expect(evaluateEligibility("fuel-burn", partial).status).toBe("ineligible");
    expect(evaluateEligibility("fuel-burn", partial).reasons.map(({ code }) => code)).toContain("partial_lap");

    const structurallyInvalid = summarize(qualityPackets(100), {
      structurallyValid: false,
      invalidReason: "track limits",
    });
    expect(evaluateEligibility("fuel-burn", structurallyInvalid).status).toBe("eligible");
  });

  test("never treats unknown group decisions as usable", () => {
    const quality = summarize(qualityPackets(100));
    const decisions = evaluateAllEligibility(quality);
    expect(decisions["stint-falloff"].status).toBe("unknown");
    expect(isEligibilityUsable(decisions["stint-falloff"])).toBe(false);
    expect(evaluateGroupEligibility("stint-falloff", [groupLap(quality, 10)], {}).status).toBe("unknown");
  });

  test("enforces setup sample size and lap-time consistency", () => {
    const quality = summarize(qualityPackets(100));
    const stable = [10, 10.1, 9.9].map((lapTime) => groupLap(quality, lapTime));
    expect(evaluateGroupEligibility("setup-analysis", stable, {}).status).toBe("eligible");
    const inconsistent = [10, 10.5, 9.5].map((lapTime) => groupLap(quality, lapTime));
    expect(evaluateGroupEligibility("setup-analysis", inconsistent, {}).status).toBe("ineligible");
  });

  test("requires verified provenance and stable identity for ML", () => {
    const quality = summarize(qualityPackets(100));
    expect(evaluateEligibility("ml-training", quality).status).toBe("ineligible");

    const verified = copyQuality(quality);
    verified.provenance.sourceGeneration = "sha256:verified";
    expect(verified.provenance).toMatchObject({
      schemaVersion: "1",
      policyVersion: "1",
      configurationVersion: "1",
      sourceGeneration: "sha256:verified",
    });
    verified.facts = verified.facts.filter(({ severity, code }) => severity !== "warning" || code === "imported_source");
    for (const semanticId of ["timing.distance-traveled", "motion.speed", "inputs.accel", "inputs.brake", "inputs.steer"] as const) {
      const channel = verified.channelQuality.find((candidate) => candidate.semanticId === semanticId)!;
      channel.mappingStatus = "normalized";
      channel.coverage = 1;
      channel.confidenceMean = 1;
      channel.freshnessCounts.stale = 0;
      channel.freshnessCounts.unknown = 0;
      channel.freshnessCounts.fresh = channel.expectedCount;
    }
    const verifiedDecision = evaluateEligibility("ml-training", verified);
    expect(verifiedDecision.reasons).toEqual([]);
    expect(verifiedDecision.status).toBe("eligible");

    const structurallyInvalid = copyQuality(verified);
    structurallyInvalid.structurallyValid = false;
    const invalidDecision = evaluateEligibility("ml-training", structurallyInvalid);
    expect(invalidDecision.status).toBe("ineligible");
    expect(invalidDecision.reasons.map(({ code }) => code)).toContain("structurally_invalid");

    verified.participant = {
      kind: "opponent",
      sourceId: "7",
      stableId: null,
      identityState: "session-scoped",
    };
    expect(evaluateEligibility("ml-training", verified).reasons.map(({ code }) => code)).toContain("identity_unstable");
  });

  test("builds every policy decision with current policy version", () => {
    const decisions: EligibilityDecisionSet = evaluateAllEligibility(summarize(qualityPackets(50)));
    expect(Object.keys(decisions)).toHaveLength(11);
    expect(new Set(Object.values(decisions).map(({ policyVersion }) => policyVersion))).toEqual(new Set(["1"]));
  });
});
