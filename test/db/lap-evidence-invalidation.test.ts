import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray, or } from "drizzle-orm";
import { db } from "../../server/db";
import { getLapById } from "../../server/db/lap-read-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import {
  compareAnalyses,
  lapAnalyses,
  lapMetrics,
  laps,
  sessions,
} from "../../server/db/schema";
import {
  getSessions,
  insertSession,
  updateSessionQuality,
} from "../../server/db/session-queries";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { lapRoutes } from "../../server/routes/laps";
import { reprocessSession } from "../../server/session-capture/reprocess";
import { initServerGameAdapters } from "../../server/games/init";
import { initGameAdapters } from "../../shared/games/init";
import {
  LOCAL_PLAYER_EVIDENCE,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import {
  qualityPackets,
  summarize,
  TEST_VERSION_IDENTITY,
} from "../support/lap-analysis/quality-model";

initGameAdapters();
initServerGameAdapters();

const SESSION_FIXTURE =
  "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const sessionIds: number[] = [];
const lapIds: number[] = [];

function finalizedQuality(
  lapNumber: number,
  rawByteOffset: number | null,
  rawFrameCount: number,
  sourceGeneration = `sha256:${"a".repeat(64)}`,
) {
  return finalizeLapQualityGeneration(
    summarize(qualityPackets(50)),
    sourceGeneration,
    { lapNumber, rawByteOffset, rawFrameCount },
  );
}

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

async function seedCaches(
  lapId: number,
  comparisonLapId: number,
  quality: LapQualitySummary,
): Promise<void> {
  await db.insert(lapAnalyses).values({
    lapId,
    analysis: "cached lap analysis",
    qualityGeneration: quality.provenance.outputGeneration,
    qualityPolicyVersion: quality.provenance.policyVersion,
  }).run();
  await db.insert(compareAnalyses).values({
    lapAId: Math.min(lapId, comparisonLapId),
    lapBId: Math.max(lapId, comparisonLapId),
    analysis: "cached comparison",
    qualityGeneration: quality.provenance.outputGeneration,
    qualityPolicyVersion: quality.provenance.policyVersion,
  }).run();
  await db.insert(lapMetrics).values({
    lapId,
    qualityGeneration: quality.provenance.outputGeneration,
    insights: "[]",
    segmentStats: "{}",
  }).run();
}

async function insertCurrentLap(
  sessionId: number,
  lapNumber: number,
): Promise<{ id: number; quality: LapQualitySummary }> {
  const generated = finalizedQuality(lapNumber, null, 50);
  const id = await insertLap({
    sessionId,
    lapNumber,
    lapTime: 90,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 50,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: [30, 30, 30],
    quality: generated.quality,
    eligibility: generated.eligibility,
    versionIdentity: TEST_VERSION_IDENTITY,
  });
  lapIds.push(id);
  return { id, quality: generated.quality };
}

afterEach(async () => {
  if (lapIds.length > 0) {
    await db.delete(compareAnalyses).where(
      or(
        inArray(compareAnalyses.lapAId, lapIds),
        inArray(compareAnalyses.lapBId, lapIds),
      ),
    ).run();
  }
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  lapIds.length = 0;
});

describe("lap evidence invalidation", () => {
  test("manual validity recheck stales quality and deletes derived caches", async () => {
    const sessionId = await insertSession(
      995_100,
      996_100,
      "fm-2023",
      "practice",
      TEST_VERSION_IDENTITY,
    );
    sessionIds.push(sessionId);
    const target = await insertCurrentLap(sessionId, 1);
    const comparison = await insertCurrentLap(sessionId, 2);
    await seedCaches(target.id, comparison.id, target.quality);
    await db.update(laps).set({ fuelPerLap: 2.5, tyreWear: 0.04 })
      .where(eq(laps.id, target.id)).run();

    expect(await getLapById(target.id)).toMatchObject({
      eligibility: expect.any(Object),
      qualityStale: false,
    });

    const response = await lapRoutes.request(`/api/laps/${target.id}/recheck`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: target.id,
      valid: false,
      reason: "too few telemetry packets",
    });
    const stored = await db.select().from(laps).where(eq(laps.id, target.id)).get();
    expect(stored).toMatchObject({
      isValid: false,
      invalidReason: "too few telemetry packets",
      eligibility: null,
      qualitySchemaVersion: null,
      qualityPolicyVersion: null,
      qualityConfigVersion: null,
      qualityGeneration: null,
      fuelPerLap: 2.5,
      tyreWear: 0.04,
    });
    expect(stored?.quality?.provenance.outputGeneration).toBe(
      target.quality.provenance.outputGeneration,
    );
    expect(await getLapById(target.id)).toMatchObject({
      qualityStale: true,
    });
    expect((await getLapById(target.id))?.quality).not.toBeNull();
    expect(await db.select().from(lapAnalyses).where(eq(lapAnalyses.lapId, target.id)).get()).toBeUndefined();
    expect(await db.select().from(compareAnalyses).where(
      or(eq(compareAnalyses.lapAId, target.id), eq(compareAnalyses.lapBId, target.id)),
    ).get()).toBeUndefined();
    expect(await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, target.id)).get()).toBeUndefined();

    await updateSessionQuality(sessionId, recordingQualityFor(qualityPackets(50)));

    const afterQualityUpdate = await db.select().from(laps)
      .where(eq(laps.id, target.id)).get();
    expect(afterQualityUpdate).toMatchObject({
      eligibility: null,
      qualityGeneration: null,
    });
    expect(afterQualityUpdate?.quality?.provenance.outputGeneration).toBe(
      target.quality.provenance.outputGeneration,
    );
    expect(await getLapById(target.id)).toMatchObject({
      qualityStale: true,
    });
  });

  test("same-count reprocessing preserves lap identity and metadata while refreshing quality", async () => {
    const session = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "fm-2023",
      sessionType: "practice",
      rawFile: SESSION_FIXTURE,
      lapDetectorVersion: "legacy-detector",
      ...TEST_VERSION_IDENTITY,
    }).returning({ id: sessions.id }).get();
    const sessionId = session.id;
    sessionIds.push(sessionId);

    const initial = await reprocessSession(sessionId);
    expect(initial.lapsDetected).toBeGreaterThan(0);
    const beforeLaps = await db.select().from(laps)
      .where(eq(laps.sessionId, sessionId))
      .orderBy(laps.lapNumber)
      .all();
    lapIds.push(...beforeLaps.map(({ id }) => id));
    const target = beforeLaps[0]!;

    const comparisonSessionId = await insertSession(
      995_101,
      996_101,
      "fm-2023",
      "practice",
      TEST_VERSION_IDENTITY,
    );
    sessionIds.push(comparisonSessionId);
    const comparison = await insertCurrentLap(comparisonSessionId, 1);

    const recordingQuality = await updateSessionQuality(
      sessionId,
      recordingQualityFor(qualityPackets(50)),
    );
    const generated = finalizedQuality(
      target.lapNumber,
      target.rawByteOffset,
      target.rawFrameCount ?? 0,
      recordingQuality.provenance.sourceGeneration,
    );
    await db.update(laps).set({
      quality: generated.quality,
      eligibility: generated.eligibility,
      qualitySchemaVersion: generated.quality.provenance.schemaVersion,
      qualityPolicyVersion: generated.quality.provenance.policyVersion,
      qualityConfigVersion: generated.quality.provenance.configurationVersion,
      qualityGeneration: generated.quality.provenance.outputGeneration,
      fuelPerLap: 2.8,
      tyreWear: 0.06,
      notes: "preserve me",
      pi: 777,
      carSetup: JSON.stringify({ wing: 3 }),
      experimentId: 12345,
      experimentVersionId: 67890,
      experimentExcluded: 1,
      experimentExcludedSource: "manual",
    }).where(eq(laps.id, target.id)).run();
    await seedCaches(target.id, comparison.id, generated.quality);

    const currentSession = (await getSessions("fm-2023"))
      .find(({ id }) => id === sessionId);
    expect(currentSession).toMatchObject({
      recordingQuality,
      qualityStale: false,
    });
    expect(await getLapById(target.id)).toMatchObject({
      eligibility: expect.any(Object),
      qualityStale: false,
    });

    const result = await reprocessSession(sessionId);

    expect(result.strategy).toBe("in-place");
    expect(result.lapsUpdated).toBe(beforeLaps.length);
    const afterLaps = await db.select().from(laps)
      .where(eq(laps.sessionId, sessionId))
      .orderBy(laps.lapNumber)
      .all();
    expect(afterLaps.map(({ id }) => id)).toEqual(beforeLaps.map(({ id }) => id));

    const storedSession = await db.select().from(sessions)
      .where(eq(sessions.id, sessionId)).get();
    expect(storedSession).toMatchObject({
      recordingQuality: expect.any(Object),
      qualitySchemaVersion: "1",
      qualityPolicyVersion: "1",
      qualityConfigVersion: "1",
      qualityGeneration: expect.stringMatching(/^sha256:/),
    });
    expect(
      (await getSessions("fm-2023")).find(
        ({ id }) => id === sessionId,
      ),
    ).toMatchObject({
      recordingQuality: expect.any(Object),
      qualityStale: false,
    });

    const storedLap = afterLaps.find(
      ({ id }) => id === target.id,
    )!;
    expect(storedLap).toMatchObject({
      eligibility: expect.any(Object),
      qualitySchemaVersion: "1",
      qualityPolicyVersion: "1",
      qualityConfigVersion: "1",
      qualityGeneration: expect.stringMatching(/^sha256:/),
      fuelPerLap: null,
      tyreWear: null,
      notes: "preserve me",
      pi: 777,
      carSetup: JSON.stringify({ wing: 3 }),
      experimentId: 12345,
      experimentVersionId: 67890,
      experimentExcluded: 1,
      experimentExcludedSource: "manual",
      createdAt: target.createdAt,
    });
    expect(await getLapById(target.id)).toMatchObject({
      qualityStale: false,
      eligibility: expect.any(Object),
    });
    expect(await db.select().from(lapAnalyses).where(eq(lapAnalyses.lapId, target.id)).get()).toBeUndefined();
    expect(await db.select().from(compareAnalyses).where(
      or(eq(compareAnalyses.lapAId, target.id), eq(compareAnalyses.lapBId, target.id)),
    ).get()).toBeUndefined();
    expect(await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, target.id)).get()).toBeUndefined();
  });
});
