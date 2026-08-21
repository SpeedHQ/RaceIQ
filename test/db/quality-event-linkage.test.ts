import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { RaceEvent, RaceEventId } from "../../shared/racing/events/contracts";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { db } from "../../server/db";
import { appendRaceEvents } from "../../server/db/race-event-queries";
import { linkSessionQualityEvents } from "../../server/db/quality-event-queries";
import { updateSessionQuality } from "../../server/db/session-queries";
import { laps, sessions } from "../../server/db/schema";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "../support/lap-analysis/quality-model";

function incidentEvent(sessionId: number, eventId: RaceEventId, sourceTimeMs: number): RaceEvent {
  return {
    eventId,
    eventType: "incident_observed",
    schemaVersion: "race-event-v1",
    sessionId,
    participantId: "local-player",
    participantKind: "player",
    driverId: null,
    teamId: null,
    timelineEpoch: 0,
    sequence: 1,
    eventOrder: 70,
    sourceTimeMs,
    sourceEndTimeMs: sourceTimeMs,
    sourceSequenceFamily: null,
    sourceSequence: null,
    receivedAtMs: sourceTimeMs,
    lapNumber: 1,
    lapId: null,
    trackDistanceM: null,
    trackDistancePct: null,
    worldPosition: null,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
    sourceKind: "native-live",
    payload: { previousCount: 0, currentCount: 1, delta: 1 },
    lifecycleId: null,
    linkedEventId: null,
    detectorId: "test",
    detectorVersion: "1",
    sourceGeneration: null,
    analysisGenerationId: null,
    contentHash: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("canonical quality event linkage", () => {
  test("replaces ephemeral IDs with overlapping durable timeline IDs", async () => {
    const packets = qualityPackets(100, [20]);
    const recording = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const packet of packets) recording.observe(packet);
    const sessionId = (
      await db.insert(sessions).values({ carOrdinal: 1, trackOrdinal: 2, gameId: "iracing" }).returning({ id: sessions.id }).get()
    ).id;
    const finalizedRecording = await updateSessionQuality(
      sessionId,
      recording.finalize("complete", { state: "verified", sourceGeneration: `sha256:${"e".repeat(64)}` }),
    );
    const generated = finalizeLapQualityGeneration(
      summarize(packets, { eventIds: ["pit:ephemeral"] }),
      finalizedRecording.provenance.sourceGeneration,
      { lapNumber: 1, rawByteOffset: null, rawFrameCount: packets.length },
    );
    const lapId = (
      await db.insert(laps).values({
        sessionId,
        lapNumber: 1,
        lapTime: 90,
        isValid: true,
        rawFrameCount: packets.length,
        quality: generated.quality,
        eligibility: generated.eligibility,
        qualityGeneration: generated.quality.provenance.outputGeneration,
      }).returning({ id: laps.id }).get()
    ).id;
    const fact = generated.quality.facts.find(({ timeRange }) => timeRange != null)!;
    const eventId = `race-event:sha256:${"f".repeat(64)}` as RaceEventId;
    await appendRaceEvents([incidentEvent(sessionId, eventId, fact.timeRange!.startMs)]);

    expect(await linkSessionQualityEvents(sessionId)).toBe(1);
    const stored = await db.select({ quality: laps.quality }).from(laps).where(eq(laps.id, lapId)).get();
    expect(stored?.quality?.facts.some((candidate) => candidate.eventIds.includes(eventId))).toBe(true);
    expect(stored?.quality?.facts.flatMap(({ eventIds }) => eventIds)).not.toContain("pit:ephemeral");
  });
});
