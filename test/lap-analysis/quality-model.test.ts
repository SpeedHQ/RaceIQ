import { describe, expect, test } from "bun:test";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
import { LOCAL_PLAYER_EVIDENCE, type LapQualitySummary } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator, summarizeLapQuality } from "../../shared/racing/quality/measure";
import { evaluateAllEligibility, evaluateEligibility, evaluateGroupEligibility, resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { packet } from "../support/telemetry/resolver";

export const TEST_VERSION_IDENTITY: TelemetryVersionIdentity = {
  catalogVersion: "test-catalog",
  catalogHash: "test-hash",
  catalogSchemaVersion: "test-schema",
  parserVersion: "test-parser",
  resolverVersion: "test-resolver",
  derivationVersion: "test-derivation",
};

export function qualityPackets(count: number, skippedTicks: readonly number[] = []): TelemetryPacket[] {
  const skipped = new Set(skippedTicks);
  const maximumTick = count + skippedTicks.length - 1;
  const packets: TelemetryPacket[] = [];
  for (let tick = 0; tick <= maximumTick; tick += 1) {
    if (skipped.has(tick)) continue;
    const fraction = maximumTick > 0 ? tick / maximumTick : 0;
    packets.push(
      packet("iracing", {
        TimestampMS: tick * 50,
        DistanceTraveled: fraction * 5_000,
        CurrentLap: fraction * 10,
        LastLap: 10,
        PositionX: 100 + fraction * 5,
        PositionZ: 200 + fraction * 5,
        Speed: 50,
        Accel: 180,
        Brake: 0,
        Steer: 0,
        Fuel: 50 - fraction,
        TireTempFL: 80,
        TireTempFR: 80,
        TireTempRL: 80,
        TireTempRR: 80,
        TireWearFL: 0.9,
        TireWearFR: 0.9,
        TireWearRL: 0.9,
        TireWearRR: 0.9,
        TirePressureFrontLeft: 27,
        TirePressureFrontRight: 27,
        TirePressureRearLeft: 27,
        TirePressureRearRight: 27,
        TireSlipRatioFL: 0.01,
        TireSlipRatioFR: 0.01,
        TireSlipRatioRL: 0.01,
        TireSlipRatioRR: 0.01,
        TireSlipAngleFL: 0.01,
        TireSlipAngleFR: 0.01,
        TireSlipAngleRL: 0.01,
        TireSlipAngleRR: 0.01,
        WheelRotationSpeedFL: 100,
        WheelRotationSpeedFR: 100,
        WheelRotationSpeedRL: 100,
        WheelRotationSpeedRR: 100,
        NormSuspensionTravelFL: 0.5,
        NormSuspensionTravelFR: 0.5,
        NormSuspensionTravelRL: 0.5,
        NormSuspensionTravelRR: 0.5,
        iracing: {
          sessionTick: tick,
          sessionNum: 0,
          driverCarIdx: 1,
          trackLengthM: 5_000,
          lapDistanceM: fraction * 5_000,
          lapDistancePct: fraction,
          onPitRoad: false,
          playerTrackSurface: 3,
          incidents: 0,
          trackWetness: 0,
          carName: "Test car",
          carClassName: "Test class",
          trackName: "Test track",
        },
      }),
    );
  }
  return packets;
}

export function summarize(packets: readonly TelemetryPacket[], overrides: Partial<Parameters<typeof summarizeLapQuality>[0]> = {}): LapQualitySummary {
  return summarizeLapQuality({
    packets,
    lapTime: 10,
    timingSource: "simulator-history",
    complete: true,
    structurallyValid: true,
    invalidReason: null,
    classification: DEFAULT_LAP_CLASSIFICATION,
    sourceKind: "native-live",
    participant: LOCAL_PLAYER_EVIDENCE,
    versionIdentity: TEST_VERSION_IDENTITY,
    ...overrides,
  });
}

describe("lap quality measurement", () => {
  test("reports exact sequence and channel coverage", () => {
    const quality = summarize(qualityPackets(200));
    expect(quality.lifecycleState).toBe("exact");
    expect(quality.gapSummary).toMatchObject({
      countMethod: "native-sequence",
      totalMissingCount: 0,
      totalMissingFraction: 0,
    });
    expect(quality.trackDistanceCoverage).toBe(1);
    expect(quality.participant.stableId).toBe("local-player");
  });

  test("classifies two missing samples under 250ms as minor", () => {
    const quality = summarize(qualityPackets(500, [248, 249]));
    expect(quality.lifecycleState).toBe("minor_gaps");
    expect(quality.gapSummary.totalMissingCount).toBe(2);
    expect(quality.facts.some(({ code }) => code === "telemetry_gap_minor")).toBe(true);
  });

  test("classifies one-second apex loss as major", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));
    expect(quality.lifecycleState).toBe("degraded");
    expect(quality.gapSummary.largestContiguousGapMs).toBeGreaterThan(1_000);
    expect(quality.facts.some(({ code }) => code === "telemetry_gap_major")).toBe(true);
  });

  test("localizes ordering faults instead of blocking unrelated ranges", () => {
    const packets = qualityPackets(200).map((sample) => ({
      ...sample,
      iracing: sample.iracing ? { ...sample.iracing } : undefined,
    }));
    packets[10]!.iracing!.sessionTick = 2;
    const quality = summarize(packets);
    const orderingFact = quality.facts.find(({ code }) => code === "out_of_order_observations");

    expect(quality.lifecycleState).toBe("degraded");
    expect(orderingFact?.timeRange).toEqual({
      startMs: packets[9]!.TimestampMS,
      endMs: packets[10]!.TimestampMS,
    });
    expect(orderingFact?.distanceRange).toEqual({
      startFraction: packets[9]!.iracing!.lapDistancePct,
      endFraction: packets[10]!.iracing!.lapDistancePct,
    });
    expect(
      evaluateEligibility("normal-pace", quality, {
        range: { startFraction: 0.8, endFraction: 0.9 },
      }).status,
    ).toBe("eligible");

    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of packets) recording.observe(sample);
    expect(recording.finalize("complete", { state: "verified", sourceGeneration: "sha256:ordering" }).facts.find(({ code }) => code === "out_of_order_observations")?.timeRange).toEqual({
      startMs: packets[9]!.TimestampMS,
      endMs: packets[10]!.TimestampMS,
    });
  });

  test("localizes timeline discontinuities instead of blocking unrelated ranges", () => {
    const packets = qualityPackets(200).map((sample, index) => ({
      ...sample,
      TimestampMS: sample.TimestampMS + (index >= 10 ? 10_000 : 0),
    }));
    const quality = summarize(packets);
    const discontinuity = quality.facts.find(({ code }) => code === "timeline_discontinuity");

    expect(discontinuity?.timeRange).toEqual({
      startMs: packets[9]!.TimestampMS,
      endMs: packets[10]!.TimestampMS,
    });
    expect(discontinuity?.distanceRange).toEqual({
      startFraction: packets[9]!.iracing!.lapDistancePct,
      endFraction: packets[10]!.iracing!.lapDistancePct,
    });
    expect(
      evaluateEligibility("normal-pace", quality, {
        range: { startFraction: 0.8, endFraction: 0.9 },
      }).status,
    ).toBe("eligible");
  });

  test("keeps opponent-only channel values unavailable instead of zero", () => {
    const quality = summarize(qualityPackets(50), {
      participant: {
        kind: "opponent",
        sourceId: "car-7",
        stableId: null,
        identityState: "session-scoped",
      },
    });
    const throttle = quality.channelQuality.find(({ semanticId }) => semanticId === "inputs.accel");
    expect(throttle?.coverage).toBeNull();
    expect(throttle?.confidenceMean).toBeNull();
    expect(quality.facts.some(({ code }) => code === "opponent_channel_unavailable")).toBe(true);
  });

  test("preserves imported source provenance", () => {
    const quality = summarize(qualityPackets(50), { sourceKind: "iracing-ibt" });
    expect(quality.sourceKind).toBe("iracing-ibt");
    expect(quality.provenance.sourceGeneration).toContain("iracing-ibt");
    expect(quality.facts.some(({ code }) => code === "imported_source")).toBe(true);
  });

  test("source profile overrides canonical fields without treating synthesized zeros as evidence", () => {
    const quality = summarize(qualityPackets(50), {
      sourceKind: "motec",
      sourceChannelProfile: {
        schemaVersion: "1",
        sourceKind: "motec",
        channels: {
          "inputs.steer": {
            treatment: "assumed",
            mappingStatus: "simplified",
            sourceChannels: [{ name: "STEERANGLE", declaredHz: 60, effectiveHz: 60 }],
            limitations: ["Steering normalized using assumed lock."],
            evidenceId: "source-channel-profile:1:motec:inputs.steer",
          },
          "tires.tire-wear": {
            treatment: "absent",
            mappingStatus: "unavailable",
            sourceChannels: [],
            limitations: ["MoTeC import does not provide tire wear."],
            evidenceId: "source-channel-profile:1:motec:tires.tire-wear",
          },
          "motion.position-x": {
            treatment: "dead-reckoned",
            mappingStatus: "derived",
            sourceChannels: [
              { name: "SPEED", declaredHz: 60, effectiveHz: 60 },
              { name: "ROTY", declaredHz: 60, effectiveHz: 60 },
            ],
            limitations: ["Position dead-reckoned from speed and yaw rate."],
            evidenceId: "source-channel-profile:1:motec:motion.position-x",
          },
        },
      },
    });
    const steering = quality.channelQuality.find(({ semanticId }) => semanticId === "inputs.steer");
    const tireWear = quality.channelQuality.find(({ semanticId }) => semanticId === "tires.tire-wear");
    const position = quality.channelQuality.find(({ semanticId }) => semanticId === "motion.position-x");

    expect(steering).toMatchObject({ mappingStatus: "simplified" });
    expect(steering?.limitations).toContain("Steering normalized using assumed lock.");
    expect(tireWear).toMatchObject({ mappingStatus: "unavailable", observedCount: 0, coverage: null, confidenceMean: null });
    expect(position).toMatchObject({ mappingStatus: "derived" });
    expect(quality.facts.find(({ code, semanticIds }) => code === "channel_simplified" && semanticIds.includes("inputs.steer"))?.eventIds).toEqual(["source-channel-profile:1:motec:inputs.steer"]);
    expect(quality.facts.find(({ code, semanticIds }) => code === "channel_unavailable" && semanticIds.includes("tires.tire-wear"))?.eventIds).toEqual([
      "source-channel-profile:1:motec:tires.tire-wear",
    ]);
    expect(quality.facts.find(({ code, semanticIds }) => code === "channel_derived" && semanticIds.includes("motion.position-x"))?.eventIds).toEqual([
      "source-channel-profile:1:motec:motion.position-x",
    ]);
  });

  test("counts native packet-family duplicates without double-counting shared timestamps", () => {
    const f1Packet = (overallFrameIdentifier: number, packetId: number, timestampMs: number) =>
      packet("f1-2025", {
        TimestampMS: timestampMs,
        DistanceTraveled: overallFrameIdentifier * 100,
        f1: { overallFrameIdentifier, packetId } as TelemetryPacket["f1"],
      });
    const distinctFamilies = [f1Packet(1, 0, 1_000), f1Packet(1, 1, 1_000), f1Packet(2, 0, 1_050), f1Packet(2, 1, 1_050)];
    expect(summarize(distinctFamilies).facts.some(({ code }) => code === "duplicate_observations")).toBe(false);

    const duplicatePair = [...distinctFamilies, f1Packet(2, 1, 1_050)];
    const lapQuality = summarize(duplicatePair);
    expect(lapQuality.facts.find(({ code }) => code === "duplicate_observations")?.details?.count).toBe(1);

    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of duplicatePair) recording.observe(sample);
    expect(recording.finalize("complete", { state: "verified", sourceGeneration: "sha256:test" }).facts.find(({ code }) => code === "duplicate_observations")?.details?.count).toBe(1);

    const legacyArchive = new RecordingQualityAccumulator("raceiq-archive", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of qualityPackets(50)) legacyArchive.observe(sample);
    const legacySummary = legacyArchive.finalize("imported", {
      state: "unknown",
      sourceGeneration: "legacy",
      details: "Archive predates member checksums",
    });
    expect(legacySummary.lifecycleState).toBe("exact");
    expect(legacySummary.facts.some(({ code }) => code === "provenance_missing")).toBe(true);
  });

  test("uses one Kunos source sequence per canonical packet", () => {
    const packets = qualityPackets(20).map(
      (sample, index) =>
        ({
          ...sample,
          gameId: "acc",
          iracing: undefined,
          acc: {
            physicsPacketId: (index + 1) * 3,
            graphicsPacketId: Math.floor(index / 2) + 1,
          } as TelemetryPacket["acc"],
        }) satisfies TelemetryPacket,
    );
    const quality = summarize(packets);

    expect(quality.gapSummary).toMatchObject({
      expectedCount: packets.length,
      observedCount: packets.length,
      totalMissingCount: 0,
    });
    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of packets) recording.observe(sample);
    const recordingSummary = recording.finalize("complete", { state: "verified", sourceGeneration: "sha256:kunos" });
    expect(recordingSummary).toMatchObject({
      lifecycleState: "exact",
      gapSummary: {
        expectedCount: packets.length,
        observedCount: packets.length,
        totalMissingCount: 0,
        largestContiguousGapMs: quality.gapSummary.largestContiguousGapMs,
      },
    });
    const gappedPackets = packets.filter((_, index) => index !== 10);
    const replayGapSummary = summarize(gappedPackets).gapSummary;
    const gappedRecording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of gappedPackets) gappedRecording.observe(sample);
    expect(gappedRecording.finalize("complete", { state: "verified", sourceGeneration: "sha256:kunos-gap" })).toMatchObject({
      lifecycleState: "degraded",
      gapSummary: {
        expectedCount: packets.length,
        observedCount: packets.length - 1,
        totalMissingCount: 1,
        largestContiguousGapMs: replayGapSummary.largestContiguousGapMs,
      },
    });
    expect(quality.facts.some(({ code }) => code === "duplicate_observations")).toBe(false);
    expect(quality.channelQuality.find(({ semanticId }) => semanticId === "motion.speed")?.coverage).toBe(1);
    expect(quality.channelQuality.find(({ semanticId }) => semanticId === "timing.distance-traveled")?.coverage).toBe(1);
  });

  test("keeps timestamp-estimated recording gaps aligned with replay", () => {
    const packets = qualityPackets(20, [10]).map((sample) => ({
      ...sample,
      iracing: undefined,
    }));
    const replayGapSummary = summarize(packets).gapSummary;
    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of packets) recording.observe(sample);
    const recordingGapSummary = recording.finalize("complete", {
      state: "verified",
      sourceGeneration: "sha256:timestamp-gap",
    }).gapSummary;

    expect(recordingGapSummary).toEqual(replayGapSummary);
  });

  test("localizes reconnect evidence in packet time and degrades recording quality", () => {
    const packets = qualityPackets(10);
    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of packets.slice(0, 5)) recording.observe(sample);
    recording.noteSourceLifecycle({ kind: "reconnect", timestampMs: Date.now(), eventId: "source:reconnect" });
    recording.observe(packets[5]!);

    const summary = recording.finalize("complete", { state: "verified", sourceGeneration: "sha256:reconnect" });
    expect(summary.lifecycleState).toBe("degraded");
    expect(summary.facts.find(({ code }) => code === "source_reconnect")).toMatchObject({
      timeRange: {
        startMs: packets[4]!.TimestampMS,
        endMs: packets[5]!.TimestampMS,
      },
      eventIds: ["source:reconnect"],
    });
  });
});

describe("versioned eligibility policies", () => {
  test("keeps timing usable and marks minor-gap analysis as limited", () => {
    const quality = summarize(qualityPackets(500, [248, 249]));
    const decisions = evaluateAllEligibility(quality);

    expect(decisions["official-timing"].status).toBe("eligible");
    expect(decisions["normal-pace"].status).toBe("eligible_with_warning");
    expect(decisions["lap-comparison"].status).toBe("eligible_with_warning");
    expect(decisions["lap-comparison"].reasons.map(({ code }) => code)).toContain("telemetry_gap_minor");
  });

  test("applies gap evidence only when it overlaps the requested range", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));

    expect(
      evaluateEligibility("lap-comparison", quality, {
        range: { startFraction: 0, endFraction: 0.3 },
      }).status,
    ).toBe("eligible");
    const affected = evaluateEligibility("lap-comparison", quality, {
      range: { startFraction: 0.4, endFraction: 0.6 },
    });
    expect(affected.status).toBe("ineligible");
    expect(affected.reasons.map(({ code }) => code)).toContain("telemetry_gap_major");
  });

  test("requires an explicit stable pace segment for stint falloff", () => {
    const quality = summarize(qualityPackets(200));
    const eligibility = evaluateAllEligibility(quality);
    const laps = Array.from({ length: 5 }, (_, index) => ({
      lapId: index + 1,
      lapTime: 90 + index * 0.1,
      quality,
      eligibility,
    }));

    expect(evaluateGroupEligibility("stint-falloff", laps).status).toBe("unknown");
    expect(evaluateGroupEligibility("stint-falloff", laps, { paceSegmentId: "pace-1" }).status).toBe("eligible");
  });

  test("returns explicit unknown evidence for legacy rows", () => {
    const decision = resolveEligibilityDecision({}, "corner-trace");
    expect(decision.status).toBe("unknown");
    expect(decision.reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);
  });
});
