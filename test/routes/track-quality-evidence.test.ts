import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import {
  deleteRecordedOutline,
} from "../../shared/racing/tracks/recording/outlines";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import {
  cacheDelete,
  cacheSet,
} from "../../server/db/telemetry-replay-storage";
import { trackRoutes } from "../../server/routes/tracks";
import { resolveTrackOutline } from "../../server/routes/tracks/support";
import { normalPaceEligibility } from "../support/lap-analysis/recap";

const createdSessionIds: number[] = [];
const cachedLapIds: number[] = [];
const recordedTrackOrdinals = new Set<number>();

function quality(generation: string): LapQualitySummary {
  return {
    provenance: {
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: "sha256:track-route-source",
      outputGeneration: generation,
    },
  } as LapQualitySummary;
}

function outlineTelemetry(): TelemetryPacket[] {
  return Array.from({ length: 60 }, (_, index) => {
    const angle = (index / 59) * Math.PI * 2;
    return {
      gameId: "iracing",
      PositionX: Math.cos(angle) * 100,
      PositionZ: Math.sin(angle) * 100,
      TimestampMS: index * 100,
      Speed: 30,
      Yaw: angle,
    } as TelemetryPacket;
  });
}

async function insertOutlineCandidate(
  trackOrdinal: number,
  options: {
    eligibility: EligibilityDecisionSet | null;
    storedGeneration?: string;
  },
): Promise<number> {
  const generation = `sha256:outline-${trackOrdinal}`;
  const sessionId = (
    await db
      .insert(sessions)
      .values({
        gameId: "iracing",
        carOrdinal: trackOrdinal + 1,
        trackOrdinal,
        source: "native-live",
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
        lapTime: 90,
        isValid: true,
        quality: quality(generation),
        eligibility: options.eligibility,
        qualityGeneration: options.storedGeneration ?? generation,
        qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
        qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
        qualityConfigVersion: QUALITY_CONFIG_VERSION,
      })
      .returning({ id: laps.id })
      .get()
  ).id;
  cacheSet(lapId, outlineTelemetry());
  cachedLapIds.push(lapId);
  recordedTrackOrdinals.add(trackOrdinal);
  return lapId;
}

afterEach(async () => {
  for (const lapId of cachedLapIds) cacheDelete(lapId);
  cachedLapIds.length = 0;
  for (const ordinal of recordedTrackOrdinals) {
    deleteRecordedOutline(ordinal, "iracing");
  }
  recordedTrackOrdinals.clear();
  for (const sessionId of createdSessionIds) await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  createdSessionIds.length = 0;
});

describe("GET /api/tracks/:trackOrdinal/all-laps", () => {
  test("returns quality evidence needed by Track Detail badges", async () => {
    const generation = "sha256:track-route-quality";
    const sessionId = (await db.insert(sessions).values({ gameId: "iracing", carOrdinal: 9_231_101, trackOrdinal: 9_231_102, source: "native-live" }).returning({ id: sessions.id }).get()).id;
    createdSessionIds.push(sessionId);
    const lapId = (
      await db
        .insert(laps)
        .values({
          sessionId,
          lapNumber: 1,
          lapTime: 90,
          isValid: true,
          quality: quality(generation),
          qualityGeneration: generation,
          qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
          qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
          qualityConfigVersion: QUALITY_CONFIG_VERSION,
        })
        .returning({ id: laps.id })
        .get()
    ).id;

    const response = await trackRoutes.request(`/api/tracks/9231102/all-laps?gameId=iracing`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(body).toContainEqual(
      expect.objectContaining({
        lapId,
        source: "native-live",
        qualityGeneration: generation,
        qualityStale: true,
        quality: expect.objectContaining({ provenance: expect.objectContaining({ outputGeneration: generation }) }),
      }),
    );
  });
});

describe("resolveTrackOutline iRacing persistence fallback", () => {
  test("seeds generated outline from current normal-pace-eligible evidence", async () => {
    const trackOrdinal = 9_231_201;
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: normalPaceEligibility("eligible"),
    });

    const resolved = await resolveTrackOutline(trackOrdinal, "iracing");

    expect(resolved).toEqual(
      expect.objectContaining({
        source: "generated",
        recorded: true,
        points: expect.any(Array),
      }),
    );
    expect(resolved?.points.length).toBeGreaterThanOrEqual(50);
  });

  test("rejects missing, stale, and normal-pace-ineligible persisted evidence", async () => {
    const trackOrdinal = 9_231_202;
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: normalPaceEligibility("ineligible"),
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: normalPaceEligibility("eligible"),
      storedGeneration: "sha256:stale-outline-generation",
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: null,
    });

    expect(await resolveTrackOutline(trackOrdinal, "iracing")).toBeNull();
  });
});
