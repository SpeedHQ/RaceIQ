import { describe, expect, test } from "bun:test";
import { ELIGIBILITY_POLICY_VERSION, LOCAL_PLAYER_EVIDENCE, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type LapQualitySummary, type QualityFact, type QualityReasonCode, type RecordingQualitySummary } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { evaluateAllEligibility, evaluateEligibility, evaluateGroupEligibility, isQualitySnapshotCurrent, resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import {
  combineQualityGenerations,
  finalizeLapQualityGeneration,
  finalizeRecordingQualityGeneration,
  mergeRecordingQualityIntoLapQuality,
} from "../../server/lap-analysis/quality-generation";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "../support/lap-analysis/quality-model";
import { packet } from "../support/telemetry/resolver";

function generationFact(
  provenance: QualityFact["provenance"],
  id: string,
  code: QualityReasonCode,
  timeRange: QualityFact["timeRange"],
): QualityFact {
  return {
    id,
    code,
    severity: code === "recording_corrupt" ? "error" : "warning",
    timeRange,
    semanticIds: [],
    channelFamilies: [],
    provenance,
    eventIds: [`event:${id}`],
    details: { reason: code },
  };
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

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("does not confirm %s stored lap time", (_label, lapTime) => {
    for (const timingSource of ["simulator-last-lap", "simulator-history", "telemetry-elapsed", "estimated"] as const) {
      const quality = summarize([], { lapTime, timingSource });

      expect(quality.timing.confirmed).toBe(false);
      expect(quality.facts.some(({ code }) => code === "lap_time_unconfirmed")).toBe(true);
    }
  });

  test("attaches classification event evidence to pace and caution facts", () => {
    const eventIds = ["event:classification:pace", "event:classification:caution"];
    const quality = summarize(qualityPackets(50), {
      classification: {
        phase: "flying",
        conditions: ["caution"],
        paceEligibility: "excluded",
      },
      eventIds,
    });

    expect(quality.facts.find(({ code }) => code === "non_pace_classification")?.eventIds).toEqual(eventIds);
    expect(quality.facts.find(({ code }) => code === "caution_context")?.eventIds).toEqual(eventIds);
  });

  test("keeps fallback track coverage independent of cumulative distance origin", () => {
    const packets = qualityPackets(200).map(({ iracing: _iracing, ...sample }) => ({
      ...sample,
      DistanceTraveled: sample.DistanceTraveled + 15_000,
    }));
    const quality = summarize(packets);

    expect(quality.trackDistanceCoverage).toBe(1);
    expect(quality.facts.some(({ code }) => code === "partial_track_coverage")).toBe(false);
  });

  test("uses known track length for partial cumulative-distance coverage", () => {
    const packets = qualityPackets(100).map((sample) => ({
      ...sample,
      DistanceTraveled: 15_000 + sample.iracing!.lapDistancePct * 2_500,
      iracing: {
        ...sample.iracing!,
        lapDistancePct: Number.NaN,
        trackLengthM: 5_000,
      },
    }));
    const quality = summarize(packets);

    expect(quality.trackDistanceCoverage).toBe(0.5);
    expect(quality.facts.some(({ code }) => code === "partial_track_coverage")).toBe(true);
  });

  test("classifies two missing samples under 250ms as minor", () => {
    const quality = summarize(qualityPackets(500, [248, 249]));
    expect(quality.lifecycleState).toBe("minor_gaps");
    expect(quality.gapSummary.totalMissingCount).toBe(2);
    expect(quality.facts.some(({ code }) => code === "telemetry_gap_minor")).toBe(true);
  });

  test("keeps localized minor gap severity when the recording also has major loss", () => {
    const skippedTicks = [20, 21, ...Array.from({ length: 20 }, (_, index) => 100 + index)];
    const packets = qualityPackets(300, skippedTicks);
    const quality = summarize(packets);
    const gapFacts = quality.facts
      .filter(({ code }) => code === "telemetry_gap_minor" || code === "telemetry_gap_major")
      .map(({ code, timeRange, details }) => ({
        code,
        timeRange,
        missingCount: details?.inferredMissingCount,
      }));
    const recordingAccumulator = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    for (const sample of packets) recordingAccumulator.observe(sample);
    const recording = recordingAccumulator.finalize("complete", {
      state: "verified",
      sourceGeneration: `sha256:${"a".repeat(64)}`,
    });
    const recordingGapCodes = recording.facts
      .filter(({ code }) => code === "telemetry_gap_minor" || code === "telemetry_gap_major")
      .map(({ code }) => code);

    expect(quality.lifecycleState).toBe("degraded");
    expect(recording.lifecycleState).toBe("degraded");
    expect(recordingGapCodes).toEqual(["telemetry_gap_minor", "telemetry_gap_major"]);
    expect(gapFacts).toEqual([
      {
        code: "telemetry_gap_minor",
        timeRange: { startMs: 950, endMs: 1_100 },
        missingCount: 2,
      },
      {
        code: "telemetry_gap_major",
        timeRange: { startMs: 4_950, endMs: 6_000 },
        missingCount: 20,
      },
    ]);
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

  test("source profile treatments override canonical fields without treating synthesized zeros as evidence", () => {
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
            mappingStatus: "derived",
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

    expect(steering).toMatchObject({
      mappingStatus: "simplified",
      sourceProfile: {
        schemaVersion: "1",
        sourceKind: "motec",
        treatment: "assumed",
        sourceChannels: [{ name: "STEERANGLE", declaredHz: 60, effectiveHz: 60 }],
        evidenceId: "source-channel-profile:1:motec:inputs.steer",
      },
    });
    expect(steering?.limitations).toContain("Steering normalized using assumed lock.");
    expect(tireWear).toMatchObject({
      mappingStatus: "unavailable",
      observedCount: 0,
      coverage: null,
      confidenceMean: null,
      sourceProfile: {
        schemaVersion: "1",
        sourceKind: "motec",
        treatment: "absent",
        sourceChannels: [],
        evidenceId: "source-channel-profile:1:motec:tires.tire-wear",
      },
    });
    expect(position).toMatchObject({
      mappingStatus: "derived",
      sourceProfile: {
        schemaVersion: "1",
        sourceKind: "motec",
        treatment: "dead-reckoned",
        sourceChannels: [
          { name: "SPEED", declaredHz: 60, effectiveHz: 60 },
          { name: "ROTY", declaredHz: 60, effectiveHz: 60 },
        ],
        evidenceId: "source-channel-profile:1:motec:motion.position-x",
      },
    });
    expect(quality.facts.find(({ code, semanticIds }) => code === "channel_simplified" && semanticIds.includes("inputs.steer"))?.eventIds).toEqual(["source-channel-profile:1:motec:inputs.steer"]);
    expect(quality.facts.find(({ code, semanticIds }) => code === "channel_unavailable" && semanticIds.includes("tires.tire-wear"))?.eventIds).toEqual([
      "source-channel-profile:1:motec:tires.tire-wear",
    ]);
    expect(quality.facts.some(({ code, semanticIds }) => code === "channel_derived" && semanticIds.includes("tires.tire-wear"))).toBe(false);
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

  test("measures F1 channel coverage and cadence from owning packet families", () => {
    const packets: TelemetryPacket[] = [];
    for (let frame = 0; frame <= 8; frame += 1) {
      const timestampMs = frame * 50;
      packets.push(
        packet("f1-2025", {
          TimestampMS: timestampMs,
          DistanceTraveled: frame * 500,
          Accel: 128,
          f1: { overallFrameIdentifier: frame, packetId: 6 } as TelemetryPacket["f1"],
        }),
      );
      if (frame === 4) {
        packets.push(
          packet("f1-2025", {
            TimestampMS: timestampMs,
            DistanceTraveled: frame * 500,
            Accel: 128,
            f1: { overallFrameIdentifier: frame, packetId: 6 } as TelemetryPacket["f1"],
          }),
        );
      }
      if (frame % 2 === 0 && frame !== 6) {
        packets.push(
          packet("f1-2025", {
            TimestampMS: timestampMs,
            DistanceTraveled: frame * 500,
            Accel: 128,
            f1: { overallFrameIdentifier: frame, packetId: 7 } as TelemetryPacket["f1"],
          }),
        );
      }
    }

    const quality = summarize(packets);
    const accelerator = quality.channelQuality.find(({ semanticId }) => semanticId === "inputs.accel");
    const fuel = quality.channelQuality.find(({ semanticId }) => semanticId === "fuel.fuel");

    expect(accelerator).toMatchObject({
      expectedCount: 9,
      observedCount: 9,
      expectedCadenceMs: 50,
      observedCadenceMs: 50,
      coverage: 1,
    });
    expect(fuel).toMatchObject({
      expectedCount: 5,
      observedCount: 4,
      expectedCadenceMs: 100,
      observedCadenceMs: 100,
      coverage: 0.8,
    });
    expect(accelerator?.resolutionCounts.ok).toBe(9);
    expect(fuel?.resolutionCounts.ok).toBe(4);
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
    expect(quality.channelQuality.find(({ semanticId }) => semanticId === "motion.speed")).toMatchObject({
      expectedCount: 20,
      observedCount: 20,
      expectedCadenceMs: 50,
      observedCadenceMs: 50,
      coverage: 1,
    });
    expect(quality.channelQuality.find(({ semanticId }) => semanticId === "timing.distance-traveled")).toMatchObject({
      expectedCount: 10,
      observedCount: 10,
      expectedCadenceMs: 100,
      observedCadenceMs: 100,
      coverage: 1,
    });
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

  test("records localized minor native sequence gaps", () => {
    const packets = qualityPackets(500, [248, 249]);
    const recording = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    for (const sample of packets) recording.observe(sample);
    const summary = recording.finalize("complete", {
      state: "verified",
      sourceGeneration: "sha256:minor-gap",
    });

    expect(summary.lifecycleState).toBe("minor_gaps");
    expect(summary.facts).toContainEqual(
      expect.objectContaining({
        id: "quality-v1:telemetry_gap_minor:1",
        code: "telemetry_gap_minor",
        timeRange: { startMs: 12_350, endMs: 12_500 },
        details: {
          durationMs: 150,
          inferredMissingCount: 2,
          countMethod: "native-sequence",
          sequenceFamily: "iracing-session-tick",
        },
      }),
    );
  });

  test("records localized major native sequence gaps", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const packets = qualityPackets(200, missing);
    const recording = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    for (const sample of packets) recording.observe(sample);
    const summary = recording.finalize("complete", {
      state: "verified",
      sourceGeneration: "sha256:major-gap",
    });

    expect(summary.lifecycleState).toBe("degraded");
    expect(summary.facts).toContainEqual(
      expect.objectContaining({
        id: "quality-v1:telemetry_gap_major:1",
        code: "telemetry_gap_major",
        timeRange: { startMs: 4_450, endMs: 5_500 },
        details: {
          durationMs: 1_050,
          inferredMissingCount: 20,
          countMethod: "native-sequence",
          sequenceFamily: "iracing-session-tick",
        },
      }),
    );
  });

  test("starts a fresh native sequence baseline after reconnect without repeated ordering facts", () => {
    const beforeReconnect = qualityPackets(5);
    const afterReconnect = qualityPackets(4).map((sample) => ({
      ...sample,
      TimestampMS: sample.TimestampMS + beforeReconnect.length * 50,
    }));
    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of beforeReconnect) recording.observe(sample);
    recording.noteSourceLifecycle({ kind: "reconnect", timestampMs: Date.now(), eventId: "source:reconnect" });
    for (const sample of afterReconnect) recording.observe(sample);

    const summary = recording.finalize("complete", { state: "verified", sourceGeneration: "sha256:reconnect" });
    expect(summary.lifecycleState).toBe("degraded");
    expect(summary.gapSummary.totalMissingCount).toBe(0);
    expect(summary.facts.filter(({ code }) => code === "source_reconnect")).toHaveLength(1);
    expect(summary.facts.filter(({ code }) => code === "out_of_order_observations")).toHaveLength(0);
    expect(summary.facts.find(({ code }) => code === "source_reconnect")).toMatchObject({
      timeRange: {
        startMs: beforeReconnect[beforeReconnect.length - 1]!.TimestampMS,
        endMs: afterReconnect[0]!.TimestampMS,
      },
      eventIds: ["source:reconnect"],
    });
  });

  test("keeps timeout sequence ordering semantics unchanged", () => {
    const beforeTimeout = qualityPackets(5);
    const resetPacket = {
      ...qualityPackets(1)[0]!,
      TimestampMS: beforeTimeout.length * 50,
    };
    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const sample of beforeTimeout) recording.observe(sample);
    recording.noteSourceLifecycle({ kind: "timeout", timestampMs: Date.now(), eventId: "source:timeout" });
    recording.observe(resetPacket);

    const facts = recording.finalize("complete", { state: "verified", sourceGeneration: "sha256:timeout" }).facts;
    expect(facts.filter(({ code }) => code === "timeline_discontinuity")).toHaveLength(1);
    expect(facts.filter(({ code }) => code === "out_of_order_observations")).toHaveLength(1);
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

  test("keeps ranged comparison conservative when channel loss is unlocalized", () => {
    const missing = Array.from({ length: 20 }, (_, index) => 90 + index);
    const quality = summarize(qualityPackets(200, missing));

    expect(
      evaluateEligibility("lap-comparison", quality, {
        range: { startFraction: 0, endFraction: 0.3 },
      }).status,
    ).toBe("ineligible");
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

  test("keeps provisional quality unusable until finalized with canonical generations", () => {
    const provisional = summarize(qualityPackets(200));
    const provisionalEvidence = {
      quality: provisional,
      eligibility: evaluateAllEligibility(provisional),
      qualityGeneration: provisional.provenance.outputGeneration,
      qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
      qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
      qualityConfigVersion: QUALITY_CONFIG_VERSION,
    };

    expect(isQualitySnapshotCurrent(provisionalEvidence)).toBe(false);
    expect(resolveEligibilityDecision(provisionalEvidence, "corner-trace")).toMatchObject({
      status: "unknown",
      reasons: [{ code: "quality_not_rebuilt" }],
    });

    const finalized = finalizeLapQualityGeneration(provisional, `sha256:${"a".repeat(64)}`, {
      lapNumber: 1,
      rawByteOffset: 0,
      rawFrameCount: 200,
    });
    const finalizedEvidence = {
      quality: finalized.quality,
      eligibility: finalized.eligibility,
      qualityGeneration: finalized.quality.provenance.outputGeneration,
      qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
      qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
      qualityConfigVersion: QUALITY_CONFIG_VERSION,
    };

    expect(isQualitySnapshotCurrent(finalizedEvidence)).toBe(true);
    expect(resolveEligibilityDecision(finalizedEvidence, "corner-trace")).toEqual(finalized.eligibility["corner-trace"]);
  });

  test("rejects persisted decisions from stale quality snapshots", () => {
    const quality = summarize(qualityPackets(200));
    const evidence = {
      quality,
      eligibility: evaluateAllEligibility(quality),
      qualityGeneration: quality.provenance.outputGeneration,
      qualityStale: true,
    };

    const decision = resolveEligibilityDecision(evidence, "corner-trace");
    expect(decision.status).toBe("unknown");
    expect(decision.reasons.map(({ code }) => code)).toEqual(["quality_stale"]);
  });
  test("finalizes lap and recording generations deterministically", () => {
    const sessionGeneration = `sha256:${"a".repeat(64)}`;
    const quality = summarize(qualityPackets(200));
    const lapIdentity = {
      lapNumber: 1,
      rawByteOffset: 0,
      rawFrameCount: 200,
    };
    const firstLap = finalizeLapQualityGeneration(quality, sessionGeneration, lapIdentity);
    const secondLap = finalizeLapQualityGeneration(quality, sessionGeneration, lapIdentity);
    expect(secondLap).toEqual(firstLap);
    expect(firstLap.quality.provenance.outputGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);

    const recording = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    for (const sample of qualityPackets(20)) recording.observe(sample);
    const summary = recording.finalize("complete", {
      state: "verified",
      sourceGeneration: sessionGeneration,
    });
    const firstRecording = finalizeRecordingQualityGeneration(summary);
    const secondRecording = finalizeRecordingQualityGeneration(summary);
    expect(secondRecording).toEqual(firstRecording);
    expect(firstRecording.provenance.outputGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(firstRecording.provenance.sourceGeneration).toBe(sessionGeneration);
    expect(firstLap.quality.provenance.sourceGeneration).not.toBe(sessionGeneration);
    expect(firstLap.quality.provenance.sourceGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("finalizes unavailable recording evidence with a deterministic source identity", () => {
    const recording = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    for (const sample of qualityPackets(20)) recording.observe(sample);
    const summary = recording.finalize("recording-disabled", {
      state: "unavailable",
      sourceGeneration: null,
      details: "Recording disabled",
    });

    const first = finalizeRecordingQualityGeneration(summary);
    const second = finalizeRecordingQualityGeneration(summary);

    expect(second).toEqual(first);
    expect(first.provenance.sourceGeneration).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(first.provenance.outputGeneration).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(first.lifecycleState).toBe("unavailable");
    expect(first.facts.some(({ code }) => code === "recording_unavailable")).toBe(
      true,
    );
  });

  test("rejects unresolved and malformed source generations", () => {
    const recording = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    for (const sample of qualityPackets(20)) recording.observe(sample);
    const summary = recording.finalize("complete", {
      state: "verified",
      sourceGeneration: `sha256:${"a".repeat(64)}`,
    });
    const quality = summarize(qualityPackets(20));
    const identity = {
      lapNumber: 1,
      rawByteOffset: 0,
      rawFrameCount: 20,
    };
    const invalidGenerations = [
      null,
      "",
      "legacy",
      "provisional:native-live:player",
      "sha256:abc",
      `sha256:${"A".repeat(64)}`,
      `SHA256:${"a".repeat(64)}`,
      `sha256:${"g".repeat(64)}`,
    ];

    for (const sourceGeneration of invalidGenerations) {
      expect(() =>
        finalizeRecordingQualityGeneration({
          ...summary,
          archiveVerification: {
            ...summary.archiveVerification,
            sourceGeneration,
          },
        }),
      ).toThrow("recording source generation must be sha256: plus 64 lowercase hex characters");
      expect(() =>
        finalizeLapQualityGeneration(quality, sourceGeneration, identity),
      ).toThrow("session source generation must be sha256: plus 64 lowercase hex characters");
    }
  });

  test("merges only applicable recording facts without duplicating lap measurements", () => {
    const provenance = summarize(qualityPackets(20)).provenance;
    const lap: LapQualitySummary = {
      ...summarize(qualityPackets(20)),
      timeRange: { startMs: 100, endMs: 500 },
      facts: [
        generationFact(
          provenance,
          "lap-timeline",
          "timeline_discontinuity",
          { startMs: 180, endMs: 220 },
        ),
      ],
    };
    const accumulator = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    const recording: RecordingQualitySummary = {
      ...accumulator.finalize("complete", {
        state: "verified",
        sourceGeneration: `sha256:${"b".repeat(64)}`,
      }),
      facts: [
        generationFact(
          provenance,
          "duplicate-timeline",
          "timeline_discontinuity",
          { startMs: 200, endMs: 240 },
        ),
        generationFact(
          provenance,
          "writer-drop",
          "writer_drop",
          { startMs: 300, endMs: 350 },
        ),
        generationFact(
          provenance,
          "outside",
          "source_reconnect",
          { startMs: 700, endMs: 800 },
        ),
      ],
    };

    const merged = mergeRecordingQualityIntoLapQuality(recording, lap);

    expect(merged.facts.map(({ id }) => id)).toEqual([
      "lap-timeline",
      "session:writer-drop",
    ]);
    expect(merged.facts[1]).toMatchObject({
      code: "writer_drop",
      timeRange: { startMs: 300, endMs: 350 },
      eventIds: ["event:writer-drop"],
      details: { reason: "writer_drop" },
    });
    expect(merged.lifecycleState).toBe("degraded");
    expect(mergeRecordingQualityIntoLapQuality(recording, merged)).toEqual(merged);
  });

  test("derives merged lifecycle deterministically from retained evidence", () => {
    const lap: LapQualitySummary = {
      ...summarize(qualityPackets(20)),
      timeRange: { startMs: 100, endMs: 500 },
      facts: [],
    };
    const accumulator = new RecordingQualityAccumulator(
      "native-live",
      LOCAL_PLAYER_EVIDENCE,
      TEST_VERSION_IDENTITY,
    );
    const recording = accumulator.finalize("complete", {
      state: "verified",
      sourceGeneration: `sha256:${"c".repeat(64)}`,
    });
    const cases = [
      { code: null, lifecycleState: "exact" },
      { code: "telemetry_gap_minor", lifecycleState: "minor_gaps" },
      { code: "writer_drop", lifecycleState: "degraded" },
      { code: "recording_incomplete", lifecycleState: "incomplete" },
      { code: "recording_corrupt", lifecycleState: "corrupt" },
    ] as const;

    for (const { code, lifecycleState } of cases) {
      const facts = code
        ? [
            generationFact(
              lap.provenance,
              code,
              code,
              code === "recording_corrupt" ? null : { startMs: 200, endMs: 250 },
            ),
          ]
        : [];
      const merged = mergeRecordingQualityIntoLapQuality(
        { ...recording, facts },
        lap,
      );
      expect(merged.lifecycleState).toBe(lifecycleState);
    }
  });


  test("folds quality generations independent of input order", () => {
    const left = `sha256:${"a".repeat(64)}`;
    const right = `sha256:${"b".repeat(64)}`;
    expect(combineQualityGenerations([left, right])).toBe(
      combineQualityGenerations([right, left]),
    );
    expect(combineQualityGenerations([left, right])).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

});
