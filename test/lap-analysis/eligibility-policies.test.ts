import { describe, expect, test } from "bun:test";
import { evaluateAllEligibility, evaluateEligibility, evaluateGroupEligibility, isEligibilityUsable, QUALITY_POLICY_CONFIG_V1, resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  type EligibilityDecision,
  type EligibilityDecisionSet,
  type EligibilityReason,
  type GroupEligibilityLap,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";

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
  test("publishes its configuration compatibility identity", () => {
    expect(QUALITY_POLICY_CONFIG_V1.version).toBe(QUALITY_CONFIG_VERSION);
  });

  test("distinguishes current, stale, and missing snapshots across policy families", () => {
    const finalized = finalizeLapQualityGeneration(summarize(qualityPackets(200)), "test-session-source", {
      lapNumber: 1,
      rawByteOffset: 0,
      rawFrameCount: 200,
    });
    const quality = finalized.quality;
    const policyIds = ["normal-pace", "corner-trace", "setup-analysis", "ml-training"] as const;

    for (const policyId of policyIds) {
      const persisted = finalized.eligibility[policyId];
      const currentEvidence = {
        quality,
        eligibility: { [policyId]: persisted } as Partial<EligibilityDecisionSet>,
        qualityGeneration: quality.provenance.outputGeneration,
      };

      const current = resolveEligibilityDecision(currentEvidence, policyId);
      expect(current).toBe(persisted);

      const stale = resolveEligibilityDecision({ ...currentEvidence, qualityStale: true }, policyId);
      expect(stale.status).toBe("unknown");
      expect(isEligibilityUsable(stale)).toBe(false);
      expect(stale.reasons.map(({ code }) => code)).toEqual(["quality_stale"]);

      const missing = resolveEligibilityDecision({}, policyId);
      expect(missing.status).toBe("unknown");
      expect(isEligibilityUsable(missing)).toBe(false);
      expect(missing.reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);
    }

    const staleMissing = resolveEligibilityDecision({ quality: null, eligibility: null, qualityStale: true }, "corner-trace");
    expect(staleMissing.reasons.map(({ code }) => code)).toEqual(["quality_stale"]);
  });

  test("keeps official timing eligible through irrelevant telemetry gaps", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(evaluateEligibility("official-timing", quality).status).toBe("eligible");
    expect(evaluateEligibility("normal-pace", quality).status).toBe("ineligible");
    expect(evaluateEligibility("lap-comparison", quality).status).toBe("ineligible");
  });

  test("uses whole-channel coverage when dropped packets cannot localize channel loss", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.05, endFraction: 0.25 },
      }).status,
    ).toBe("ineligible");
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.4, endFraction: 0.6 },
      }).status,
    ).toBe("ineligible");
  });

  test("keeps zero-width probes conservative when channel loss is unlocalized", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.15, endFraction: 0.15 },
      }).status,
    ).toBe("ineligible");
    expect(
      evaluateEligibility("corner-trace", quality, {
        range: { startFraction: 0.5, endFraction: 0.5 },
      }).status,
    ).toBe("ineligible");
  });

  test("falls back to whole-channel coverage when loss is not fully localized", () => {
    const base = summarize(qualityPackets(200));
    const cases = [
      [],
      [
        {
          state: "missing" as const,
          freshness: "unknown" as const,
          timeRange: { startMs: 8_000, endMs: 9_000 },
          distanceRange: { startFraction: 0.8, endFraction: 0.9 },
          count: 10,
        },
        {
          state: "missing" as const,
          freshness: "unknown" as const,
          timeRange: { startMs: 9_000, endMs: 10_000 },
          distanceRange: null,
          count: 10,
        },
      ],
    ];

    for (const issueIntervals of cases) {
      const quality = copyQuality(base);
      const speed = quality.channelQuality.find(({ semanticId }) => semanticId === "motion.speed")!;
      speed.coverage = 0.9;
      speed.observedCount = 180;
      speed.resolutionCounts.ok = 180;
      speed.resolutionCounts.missing = 20;
      speed.issueIntervals = issueIntervals;

      const decision = evaluateEligibility("transient-event", quality, {
        requiredSemanticIds: ["motion.speed"],
        range: { startFraction: 0, endFraction: 0.1 },
      });
      expect(decision.status).toBe("ineligible");
      expect(decision.reasons.map(({ code }) => code)).toContain("channel_missing");
      expect(decision.confidence.score).toBeLessThan(1);
    }
  });

  test("counts point missing samples against ranged policy thresholds", () => {
    const quality = copyQuality(summarize(qualityPackets(200)));
    const speed = quality.channelQuality.find(({ semanticId }) => semanticId === "motion.speed")!;
    speed.coverage = 199 / 200;
    speed.observedCount = 199;
    speed.resolutionCounts.ok = 199;
    speed.resolutionCounts.missing = 1;
    speed.issueIntervals = [
      {
        state: "missing",
        freshness: "unknown",
        timeRange: { startMs: 2_000, endMs: 2_000 },
        distanceRange: { startFraction: 0.2, endFraction: 0.2 },
        count: 1,
      },
    ];

    const range = { startFraction: 0.1, endFraction: 0.3 };
    expect(evaluateEligibility("lap-comparison", quality, { range }).status).toBe("eligible");
    const transient = evaluateEligibility("transient-event", quality, {
      range,
      requiredSemanticIds: ["motion.speed"],
    });
    expect(transient.status).toBe("ineligible");
    expect(transient.reasons.map(({ code }) => code)).toContain("channel_missing");
    expect(
      evaluateEligibility("transient-event", quality, {
        range: { startFraction: 0.4, endFraction: 0.6 },
        requiredSemanticIds: ["motion.speed"],
      }).status,
    ).toBe("eligible");
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

  test("propagates source treatments into fidelity reasons, confidence, and strict status", () => {
    const base = copyQuality(summarize(qualityPackets(200)));
    const requiredChannels = new Set(["timing.distance-traveled", "motion.speed", "inputs.accel", "inputs.brake", "inputs.steer"]);
    for (const channel of base.channelQuality) {
      if (!requiredChannels.has(channel.semanticId)) continue;
      channel.mappingStatus = "direct";
      channel.limitations = [];
      channel.sourceProfile = null;
    }
    const direct = evaluateEligibility("corner-trace", base);
    expect(direct.status).toBe("eligible");

    const cases = [
      ["held", "channel_simplified"],
      ["resampled", "interpolated_channel"],
      ["dead-reckoned", "channel_derived"],
      ["assumed", "channel_simplified"],
    ] as const;
    for (const [treatment, reasonCode] of cases) {
      const quality = copyQuality(base);
      const steering = quality.channelQuality.find(({ semanticId }) => semanticId === "inputs.steer")!;
      steering.mappingStatus = "direct";
      steering.confidenceMean = 1;
      steering.sourceProfile = {
        schemaVersion: "1",
        sourceKind: "motec",
        treatment,
        sourceChannels: [{ name: "STEERANGLE", declaredHz: 60, effectiveHz: 10 }],
        evidenceId: `source-profile:steer:${treatment}`,
      };

      const decision = evaluateEligibility("corner-trace", quality);
      expect(decision.status).toBe("ineligible");
      expect(decision.reasons.map(({ code }) => code)).toContain(reasonCode);
      expect(decision.evidenceIds).toContain(steering.sourceProfile.evidenceId);
      expect(decision.confidence.score).toBeLessThan(direct.confidence.score!);
    }

    const heldQuality = copyQuality(base);
    const speed = heldQuality.channelQuality.find(({ semanticId }) => semanticId === "motion.speed")!;
    speed.sourceProfile = {
      schemaVersion: "1",
      sourceKind: "external-log",
      treatment: "held",
      sourceChannels: [{ name: "SPEED", declaredHz: 60, effectiveHz: 20 }],
      evidenceId: "source-profile:speed:held",
    };
    const comparison = evaluateEligibility("lap-comparison", heldQuality);
    expect(comparison.status).toBe("eligible_with_warning");
    expect(comparison.reasons.map(({ code }) => code)).toContain("channel_simplified");
    expect(comparison.confidence.score).toBeLessThan(evaluateEligibility("lap-comparison", base).confidence.score!);
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

    const missingChannels = evaluateEligibility("lap-comparison", quality)
      .reasons.filter(({ code }) => code === "channel_missing")
      .flatMap(({ semanticIds }) => semanticIds);
    expect(missingChannels).toEqual(expect.arrayContaining(["timing.distance-traveled", "motion.speed"]));
  });

  test("allows one complete pit tire snapshot but rejects it as continuous coverage", () => {
    const quality = summarize(qualityPackets(200));
    for (const semanticId of ["tire.temperature.average", "tires.tire-wear"] as const) {
      const channel = quality.channelQuality.find((candidate) => candidate.semanticId === semanticId)!;
      channel.mappingStatus = "direct";
      channel.limitations = ["pit-only snapshot"];
      channel.observedCount = 1;
      channel.coverage = 1 / channel.expectedCount;
      channel.confidenceMean = 1;
      channel.resolutionCounts.ok = 1;
      channel.resolutionCounts.missing = channel.expectedCount - 1;
      channel.freshnessCounts.stale = 0;
    }

    const continuous = evaluateEligibility("tire-analysis", quality);
    expect(continuous.status).toBe("ineligible");
    expect(continuous.reasons.map(({ code }) => code)).toContain("channel_missing");
    const missingChannels = continuous.reasons.filter(({ code }) => code === "channel_missing").flatMap(({ semanticIds }) => semanticIds);
    expect(missingChannels).toEqual(expect.arrayContaining(["tire.temperature.average", "tires.tire-wear"]));
    expect(evaluateEligibility("tire-analysis", quality, { tireMode: "pit-snapshot" }).status).toBe("eligible");
  });

  test("rejects invalid and error counts across required continuous tire channels", () => {
    const quality = copyQuality(summarize(qualityPackets(200)));
    const channels = [
      ["tire.temperature.average", "invalid"],
      ["tires.tire-wear", "error"],
    ] as const;
    for (const [semanticId, state] of channels) {
      const channel = quality.channelQuality.find((candidate) => candidate.semanticId === semanticId)!;
      channel.coverage = 1;
      channel.resolutionCounts[state] = 1;
    }

    const decision = evaluateEligibility("tire-analysis", quality);
    const invalidChannels = decision.reasons.filter(({ code }) => code === "channel_invalid").flatMap(({ semanticIds }) => semanticIds);
    expect(decision.status).toBe("ineligible");
    expect(invalidChannels).toEqual(expect.arrayContaining(["tire.temperature.average", "tires.tire-wear"]));
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

  test("preserves usable per-lap warnings in setup decisions", () => {
    const quality = summarize(qualityPackets(100));
    const warning: EligibilityReason = {
      code: "channel_simplified",
      severity: "warning",
      evidenceIds: ["source-channel-profile:steering"],
      timeRange: null,
      distanceRange: null,
      semanticIds: ["inputs.steer"],
    };
    const warned = [10, 10.1, 9.9].map((lapTime) => {
      const lap = groupLap(quality, lapTime);
      const cornerTrace = lap.eligibility["corner-trace"];
      return {
        ...lap,
        eligibility: {
          ...lap.eligibility,
          "corner-trace": {
            ...cornerTrace,
            status: "eligible_with_warning" as const,
            reasons: [warning],
            evidenceIds: warning.evidenceIds,
          },
        },
      };
    });

    const setup = evaluateGroupEligibility("setup-analysis", warned);
    expect(setup.status).toBe("eligible_with_warning");
    expect(setup.reasons).toEqual([warning]);
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
