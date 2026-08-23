import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { getLapById } from "../../server/db/lap-read-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { laps, sessions } from "../../server/db/schema";
import {
  deleteSession,
  getSessions,
  insertSession,
  updateSessionQuality,
} from "../../server/db/session-queries";
import {
  finalizeLapQualityGeneration,
  finalizeRecordingQualityGeneration,
} from "../../server/lap-analysis/quality-generation";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import {
  LOCAL_PLAYER_EVIDENCE,
  type LapQualitySummary,
  type SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import {
  qualityPackets,
  summarize,
  TEST_VERSION_IDENTITY,
} from "../support/lap-analysis/quality-model";

const sessionIds: number[] = [];
const testGameId = "quality-persistence-test" as GameId;

const sourceChannelProfile: SourceChannelProfile = {
  schemaVersion: "1",
  sourceKind: "motec",
  channels: {
    "motion.speed": {
      treatment: "resampled",
      mappingStatus: "normalized",
      sourceChannels: [
        { name: "Ground Speed", declaredHz: 50, effectiveHz: 20 },
      ],
      limitations: ["resampled export"],
      evidenceId: "source-profile:motion.speed",
    },
  },
};
function recordingQualityFor(packets: readonly TelemetryPacket[]) {
  const accumulator = new RecordingQualityAccumulator(
    "native-live",
    LOCAL_PLAYER_EVIDENCE,
    TEST_VERSION_IDENTITY,
  );
  for (const packet of packets) accumulator.observe(packet);
  return accumulator.finalize("test-complete", {
    state: "verified",
    sourceGeneration: `sha256:${"c".repeat(64)}`,
  });
}


afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) await deleteSession(sessionId);
});

test("current session and lap queries round-trip quality and expose stale generations", async () => {
  const sessionId = await insertSession(
    990_260,
    991_260,
    testGameId,
    "practice",
    TEST_VERSION_IDENTITY,
    "mine",
    "motec",
    sourceChannelProfile,
  );
  sessionIds.push(sessionId);

  const packets = qualityPackets(50);
  const recordingAccumulator = new RecordingQualityAccumulator(
    "motec",
    LOCAL_PLAYER_EVIDENCE,
    TEST_VERSION_IDENTITY,
  );
  for (const packet of packets) recordingAccumulator.observe(packet);
  const recordingQuality = await updateSessionQuality(
    sessionId,
    recordingAccumulator.finalize("test-complete", {
      state: "verified",
      sourceGeneration: `sha256:${"a".repeat(64)}`,
    }),
  );
  const finalizedLap = finalizeLapQualityGeneration(
    summarize(packets, {
      sourceKind: "motec",
      sourceChannelProfile,
    }),
    recordingQuality.provenance.sourceGeneration,
    { lapNumber: 1, rawByteOffset: null, rawFrameCount: 0 },
  );
  const persistedLapQuality = JSON.parse(
    JSON.stringify(finalizedLap.quality),
  ) as typeof finalizedLap.quality;
  const persistedEligibility = JSON.parse(
    JSON.stringify(finalizedLap.eligibility),
  ) as typeof finalizedLap.eligibility;
  const lapId = await insertLap({
    sessionId,
    lapNumber: 1,
    lapTime: 10,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 0,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    quality: finalizedLap.quality,
    eligibility: finalizedLap.eligibility,
  });

  const currentSession = (await getSessions(testGameId)).find(
    (session) => session.id === sessionId,
  );
  expect(currentSession).toMatchObject({
    source: "motec",
    sourceChannelProfile,
    recordingQuality,
    qualityGeneration: recordingQuality.provenance.outputGeneration,
    qualityStale: false,
  });
  const currentLap = await getLapById(lapId);
  expect(currentLap).toMatchObject({
    quality: persistedLapQuality,
    eligibility: persistedEligibility,
    qualityGeneration: finalizedLap.quality.provenance.outputGeneration,
    qualityStale: false,
  });

  const staleGeneration = `sha256:${"b".repeat(64)}`;
  await db
    .update(sessions)
    .set({ qualityGeneration: staleGeneration })
    .where(eq(sessions.id, sessionId))
    .run();
  await db
    .update(laps)
    .set({ qualityGeneration: staleGeneration })
    .where(eq(laps.id, lapId))
    .run();

  const staleSession = (await getSessions(testGameId)).find(
    (session) => session.id === sessionId,
  );
  expect(staleSession?.recordingQuality).toEqual(recordingQuality);
  expect(staleSession?.qualityGeneration).toBe(staleGeneration);
  expect(staleSession?.qualityStale).toBe(true);
  const staleLap = await getLapById(lapId);
  expect(staleLap?.quality).toEqual(persistedLapQuality);
  expect(staleLap?.eligibility).toEqual(persistedEligibility);
  expect(staleLap?.qualityGeneration).toBe(staleGeneration);
  expect(staleLap?.qualityStale).toBe(true);
});

test("missing session quality remains absent rather than stale", async () => {
  const sessionId = await insertSession(1, 2, testGameId);
  sessionIds.push(sessionId);

  const session = (await getSessions(testGameId)).find(
    (candidate) => candidate.id === sessionId,
  );

  expect(session?.source).toBe("native-live");
  expect(session?.recordingQuality).toBeUndefined();
  expect(session?.qualityGeneration).toBeUndefined();
  expect(session?.qualityStale).toBe(false);
});

test("session and lap quality writes converge with recording gaps", async () => {
  const skippedTicks = [
    20,
    21,
    ...Array.from({ length: 20 }, (_, index) => 100 + index),
  ];
  const recordingPackets = qualityPackets(300, skippedTicks);
  const recordingDraft = recordingQualityFor(recordingPackets);
  const finalizedRecording = finalizeRecordingQualityGeneration(recordingDraft);
  const lapPackets = qualityPackets(300);
  const baseLap = finalizeLapQualityGeneration(
    summarize(lapPackets),
    finalizedRecording.provenance.sourceGeneration,
    { lapNumber: 1, rawByteOffset: null, rawFrameCount: 0 },
  );

  async function persist(order: "session-first" | "lap-first") {
    const sessionId = await insertSession(
      990_261,
      991_261,
      testGameId,
      "practice",
      TEST_VERSION_IDENTITY,
    );
    sessionIds.push(sessionId);
    if (order === "session-first") {
      await updateSessionQuality(sessionId, recordingDraft);
    }
    const lapId = await insertLap({
      sessionId,
      lapNumber: 1,
      lapTime: 10,
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: 0,
      profileId: null,
      tuneId: null,
      invalidReason: null,
      sectors: null,
      quality: baseLap.quality,
      eligibility: baseLap.eligibility,
    });
    if (order === "lap-first") {
      await updateSessionQuality(sessionId, recordingDraft);
    }
    return db
      .select({
        quality: laps.quality,
        eligibility: laps.eligibility,
        qualitySchemaVersion: laps.qualitySchemaVersion,
        qualityPolicyVersion: laps.qualityPolicyVersion,
        qualityConfigVersion: laps.qualityConfigVersion,
        qualityGeneration: laps.qualityGeneration,
      })
      .from(laps)
      .where(eq(laps.id, lapId))
      .get();
  }

  const sessionFirst = await persist("session-first");
  const lapFirst = await persist("lap-first");
  expect(sessionFirst).toEqual(lapFirst);
  const gapFacts = sessionFirst?.quality?.facts.filter(
    ({ code }) =>
      code === "telemetry_gap_minor" || code === "telemetry_gap_major",
  );
  expect(gapFacts?.map(({ code }) => code).sort()).toEqual([
    "telemetry_gap_major",
    "telemetry_gap_minor",
  ]);
  expect(gapFacts?.every(({ id }) => id.startsWith("session:"))).toBe(true);
});

test("overlapping lap and recording gaps remain single measured facts", async () => {
  const skippedTicks = [
    20,
    21,
    ...Array.from({ length: 20 }, (_, index) => 100 + index),
  ];
  const packets = qualityPackets(300, skippedTicks);
  const recordingDraft = recordingQualityFor(packets);
  const finalizedRecording = finalizeRecordingQualityGeneration(recordingDraft);
  const baseLap = finalizeLapQualityGeneration(
    summarize(packets),
    finalizedRecording.provenance.sourceGeneration,
    { lapNumber: 1, rawByteOffset: null, rawFrameCount: 0 },
  );
  const sessionId = await insertSession(
    990_262,
    991_262,
    testGameId,
    "practice",
    TEST_VERSION_IDENTITY,
  );
  sessionIds.push(sessionId);
  await updateSessionQuality(sessionId, recordingDraft);
  const lapId = await insertLap({
    sessionId,
    lapNumber: 1,
    lapTime: 10,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 0,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    quality: baseLap.quality,
    eligibility: baseLap.eligibility,
  });

  const stored = await getLapById(lapId);
  const gapFacts = stored?.quality?.facts.filter(
    ({ code }) =>
      code === "telemetry_gap_minor" || code === "telemetry_gap_major",
  );
  expect(gapFacts?.map(({ code }) => code).sort()).toEqual([
    "telemetry_gap_major",
    "telemetry_gap_minor",
  ]);
  expect(gapFacts?.some(({ id }) => id.startsWith("session:"))).toBe(false);
});

test("session quality updates do not promote legacy placeholder laps", async () => {
  const packets = qualityPackets(50);
  const sessionId = await insertSession(
    990_263,
    991_263,
    testGameId,
    "practice",
    TEST_VERSION_IDENTITY,
  );
  sessionIds.push(sessionId);
  const summary = summarize(packets);
  const legacyProvenance = {
    schemaVersion: "legacy",
    policyVersion: "legacy",
    configurationVersion: "legacy",
    sourceGeneration: "legacy",
    outputGeneration: "legacy",
  };
  const legacyQuality: LapQualitySummary = {
    ...summary,
    lifecycleState: "unavailable",
    facts: summary.facts.map((fact) => ({
      ...fact,
      provenance: legacyProvenance,
    })),
    provenance: legacyProvenance,
  };
  const lapId = await insertLap({
    sessionId,
    lapNumber: 1,
    lapTime: 10,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 0,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    quality: legacyQuality,
    eligibility: null,
  });

  await updateSessionQuality(sessionId, recordingQualityFor(packets));

  const stored = await getLapById(lapId);
  expect(stored?.quality?.provenance).toEqual(legacyProvenance);
  expect(stored?.qualityGeneration).toBe("legacy");
  expect(stored?.qualityStale).toBe(true);
});
