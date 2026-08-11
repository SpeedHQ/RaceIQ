import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { finalizeLapQualityGeneration, finalizeRecordingQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { db } from "../../server/db";
import { linkSessionQualityEvents } from "../../server/db/quality-event-queries";
import { updateSessionQuality } from "../../server/db/session-queries";
import { laps, pitEvents, sessionResults, sessions } from "../../server/db/schema";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "../lap-analysis/quality-model.test";

const createdSessionIds: number[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  createdSessionIds.length = 0;
});

describe("durable quality event linkage", () => {
  test("links only events matching lap and time range, then stays idempotent", async () => {
    const packets = qualityPackets(100, [20]);
    const recordingAccumulator = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const packet of packets) recordingAccumulator.observe(packet);
    const recordingQuality = finalizeRecordingQualityGeneration(
      recordingAccumulator.finalize("complete", {
        state: "verified",
        sourceGeneration: "sha256:event-source",
      }),
    );
    const measured = summarize(packets, { eventIds: ["pit:ephemeral"] });
    const generated = finalizeLapQualityGeneration(measured, recordingQuality.provenance.sourceGeneration, {
      lapNumber: 1,
      rawByteOffset: 12,
      rawFrameCount: packets.length,
    });
    const sessionId = (
      await db
        .insert(sessions)
        .values({
          carOrdinal: 991_237,
          trackOrdinal: 992_237,
          gameId: "iracing",
          source: "native-live",
          recordingQuality,
          qualitySchemaVersion: recordingQuality.provenance.schemaVersion,
          qualityPolicyVersion: recordingQuality.provenance.policyVersion,
          qualityConfigVersion: recordingQuality.provenance.configurationVersion,
          qualityGeneration: recordingQuality.provenance.outputGeneration,
        })
        .returning({ id: sessions.id })
        .get()
    ).id;
    createdSessionIds.push(sessionId);
    const lapId = (
      await db
        .insert(laps)
        .values({
          sessionId,
          lapNumber: 1,
          lapTime: 10,
          isValid: true,
          quality: generated.quality,
          eligibility: evaluateAllEligibility(generated.quality),
          qualitySchemaVersion: generated.quality.provenance.schemaVersion,
          qualityPolicyVersion: generated.quality.provenance.policyVersion,
          qualityConfigVersion: generated.quality.provenance.configurationVersion,
          qualityGeneration: generated.quality.provenance.outputGeneration,
        })
        .returning({ id: laps.id })
        .get()
    ).id;
    const resultId = (
      await db.insert(sessionResults).values({ sessionId }).returning({ id: sessionResults.id }).get()
    ).id;
    const gap = generated.quality.facts.find(({ code }) => code === "telemetry_gap_minor")!;
    const eventTime = ((gap.timeRange?.startMs ?? 0) + (gap.timeRange?.endMs ?? 0)) / 2_000;
    const matchingEvent = (
      await db
        .insert(pitEvents)
        .values({ resultId, sequence: 1, eventType: "pit", lapNumber: 1, elapsedSeconds: eventTime, durationSeconds: 0.01 })
        .returning({ id: pitEvents.id })
        .get()
    ).id;
    await db.insert(pitEvents).values([
      { resultId, sequence: 2, eventType: "pit", lapNumber: 2, elapsedSeconds: eventTime, durationSeconds: 0.01 },
      { resultId, sequence: 3, eventType: "position-change", lapNumber: 1, elapsedSeconds: eventTime + 20, durationSeconds: 0.01 },
    ]).run();

    expect(await linkSessionQualityEvents(sessionId)).toBe(1);
    const stored = await db.select({ quality: laps.quality }).from(laps).where(eq(laps.id, lapId)).get();
    const linkedGap = stored?.quality?.facts.find(({ code }) => code === "telemetry_gap_minor");
    expect(linkedGap?.eventIds).toEqual([`pit-event:${matchingEvent}`]);
    expect(await linkSessionQualityEvents(sessionId)).toBe(0);
  });

  test("projects lifecycle evidence only onto overlapping laps", async () => {
    const firstPackets = qualityPackets(20);
    const secondPackets = qualityPackets(20).map((packet, index) => ({
      ...packet,
      TimestampMS: packet.TimestampMS + 10_000,
      iracing: packet.iracing ? { ...packet.iracing, sessionTick: index + firstPackets.length } : undefined,
    }));
    const recordingAccumulator = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const packet of [...firstPackets, ...secondPackets.slice(0, 5)]) recordingAccumulator.observe(packet);
    recordingAccumulator.noteSourceLifecycle({ kind: "reconnect", timestampMs: Date.now(), eventId: "lifecycle:reconnect" });
    for (const packet of secondPackets.slice(5)) recordingAccumulator.observe(packet);
    const recordingQuality = recordingAccumulator.finalize("complete", {
      state: "verified",
      sourceGeneration: "sha256:localized-source",
    });

    const sessionId = (
      await db
        .insert(sessions)
        .values({
          carOrdinal: 991_238,
          trackOrdinal: 992_238,
          gameId: "iracing",
          source: "native-live",
        })
        .returning({ id: sessions.id })
        .get()
    ).id;
    createdSessionIds.push(sessionId);
    for (const [index, packets] of [firstPackets, secondPackets].entries()) {
      const quality = summarize(packets);
      await db.insert(laps).values({
        sessionId,
        lapNumber: index + 1,
        lapTime: 10,
        isValid: true,
        quality,
        eligibility: evaluateAllEligibility(quality),
        qualitySchemaVersion: quality.provenance.schemaVersion,
        qualityPolicyVersion: quality.provenance.policyVersion,
        qualityConfigVersion: quality.provenance.configurationVersion,
        qualityGeneration: quality.provenance.outputGeneration,
      });
    }

    await updateSessionQuality(sessionId, recordingQuality);
    const stored = await db.select({ lapNumber: laps.lapNumber, quality: laps.quality, eligibility: laps.eligibility }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    const first = stored.find(({ lapNumber }) => lapNumber === 1)!;
    const second = stored.find(({ lapNumber }) => lapNumber === 2)!;

    expect(first.quality?.facts.some(({ code }) => code === "source_reconnect")).toBe(false);
    expect(first.quality?.lifecycleState).toBe("exact");
    expect(second.quality?.facts.find(({ code }) => code === "source_reconnect")?.eventIds).toEqual(["lifecycle:reconnect"]);
    expect(second.quality?.lifecycleState).toBe("degraded");
    expect(second.eligibility?.["lap-comparison"].status).toBe("eligible_with_warning");
    expect(second.eligibility?.["transient-event"].status).toBe("ineligible");

    const cleanRecording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const packet of [...firstPackets, ...secondPackets]) cleanRecording.observe(packet);
    await updateSessionQuality(
      sessionId,
      cleanRecording.finalize("complete", {
        state: "verified",
        sourceGeneration: "sha256:clean-source",
      }),
    );
    const rebuilt = await db.select({ quality: laps.quality }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    expect(rebuilt.map(({ quality }) => quality?.lifecycleState)).toEqual(["exact", "exact"]);
    expect(rebuilt.every(({ quality }) => quality?.facts.every(({ id }) => !id.startsWith("session:")))).toBe(true);
  });

  test("keeps measured ordering faults local without duplicate session facts", async () => {
    const firstPackets = qualityPackets(20);
    const secondPackets = qualityPackets(20).map((packet, index) => ({
      ...packet,
      TimestampMS: packet.TimestampMS + 10_000,
      iracing: packet.iracing
        ? {
            ...packet.iracing,
            sessionTick: index === 10 ? firstPackets.length + 2 : index + firstPackets.length,
          }
        : undefined,
    }));
    const recordingAccumulator = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const packet of [...firstPackets, ...secondPackets]) recordingAccumulator.observe(packet);
    const recordingQuality = recordingAccumulator.finalize("complete", {
      state: "verified",
      sourceGeneration: "sha256:ordering-source",
    });

    const sessionId = (
      await db
        .insert(sessions)
        .values({
          carOrdinal: 991_239,
          trackOrdinal: 992_239,
          gameId: "iracing",
          source: "native-live",
        })
        .returning({ id: sessions.id })
        .get()
    ).id;
    createdSessionIds.push(sessionId);
    for (const [index, packets] of [firstPackets, secondPackets].entries()) {
      const quality = summarize(packets);
      await db.insert(laps).values({
        sessionId,
        lapNumber: index + 1,
        lapTime: 10,
        isValid: true,
        quality,
        eligibility: evaluateAllEligibility(quality),
        qualitySchemaVersion: quality.provenance.schemaVersion,
        qualityPolicyVersion: quality.provenance.policyVersion,
        qualityConfigVersion: quality.provenance.configurationVersion,
        qualityGeneration: quality.provenance.outputGeneration,
      });
    }

    await updateSessionQuality(sessionId, recordingQuality);
    const stored = await db.select({ lapNumber: laps.lapNumber, quality: laps.quality }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    const first = stored.find(({ lapNumber }) => lapNumber === 1)!;
    const second = stored.find(({ lapNumber }) => lapNumber === 2)!;
    const orderingFacts = second.quality?.facts.filter(({ code }) => code === "out_of_order_observations") ?? [];

    expect(first.quality?.facts.some(({ code }) => code === "out_of_order_observations")).toBe(false);
    expect(first.quality?.lifecycleState).toBe("exact");
    expect(orderingFacts).toHaveLength(1);
    expect(orderingFacts[0]?.id.startsWith("session:")).toBe(false);
    expect(orderingFacts[0]?.timeRange).toEqual({
      startMs: secondPackets[9]!.TimestampMS,
      endMs: secondPackets[10]!.TimestampMS,
    });
  });
});
