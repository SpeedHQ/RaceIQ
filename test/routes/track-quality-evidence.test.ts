import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type EligibilityStatus,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import { deleteRecordedOutline, getRecordedOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { cacheDelete, cacheSet } from "../../server/db/telemetry-replay-storage";
import { trackRoutes } from "../../server/routes/tracks";
import { resolveTrackOutline } from "../../server/routes/tracks/support";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

const createdSessionIds: number[] = [];
const cachedLapIds: number[] = [];
const recordedTrackOrdinals = new Set<number>();

function quality(generation: string): LapQualitySummary {
  const summarized = summarize(qualityPackets(100));
  return {
    ...summarized,
    provenance: {
      ...summarized.provenance,
      sourceGeneration: `sha256:${"c".repeat(64)}`,
      outputGeneration: generation,
    },
  };
}

function cornerTraceEligibility(status: EligibilityStatus): EligibilityDecisionSet {
  const eligibility = evaluateAllEligibility(quality(`sha256:${"0".repeat(64)}`));
  eligibility["corner-trace"] = {
    ...eligibility["corner-trace"],
    status,
    confidence: { level: status === "unknown" ? "unknown" : "high", score: status === "unknown" ? null : 1 },
    reasons: [],
    evidenceIds: [],
  };
  return eligibility;
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
    gameId?: GameId;
    sessionTrackOrdinal?: number;
    ownership?: "mine" | "others";
    lapTime?: number;
  },
): Promise<number> {
  const generation = `sha256:${trackOrdinal.toString(16).padStart(64, "0")}`;
  const sessionId = (
    await db
      .insert(sessions)
      .values({
        gameId: options.gameId ?? "iracing",
        carOrdinal: trackOrdinal + 1,
        trackOrdinal: options.sessionTrackOrdinal ?? trackOrdinal,
        source: "native-live",
        ownership: options.ownership ?? "mine",
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
        lapTime: options.lapTime ?? 90,
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

describe("POST /api/tracks/:trackOrdinal/recompute-outline", () => {
  const recompute = (trackOrdinal: number, lapId?: number) =>
    trackRoutes.request(`/api/tracks/${trackOrdinal}/recompute-outline?gameId=iracing${lapId == null ? "" : `&lapId=${lapId}`}`, { method: "POST" });

  test("explicit mode writes only owned matching current corner-trace evidence", async () => {
    const acceptedTrack = 9_231_210;
    const acceptedLap = await insertOutlineCandidate(acceptedTrack, { eligibility: cornerTraceEligibility("eligible") });
    expect((await recompute(acceptedTrack, acceptedLap)).status).toBe(200);
    expect(getRecordedOutlineByOrdinal(acceptedTrack, "iracing")?.length).toBeGreaterThanOrEqual(50);

    const rejected = [
      { track: 9_231_211, options: { eligibility: cornerTraceEligibility("eligible"), gameId: "acc" as const }, status: 404 },
      { track: 9_231_212, options: { eligibility: cornerTraceEligibility("eligible"), sessionTrackOrdinal: 9_231_999 }, status: 404 },
      { track: 9_231_213, options: { eligibility: cornerTraceEligibility("eligible"), ownership: "others" as const }, status: 404 },
      { track: 9_231_214, options: { eligibility: cornerTraceEligibility("eligible"), lapTime: 0 }, status: 404 },
      { track: 9_231_215, options: { eligibility: cornerTraceEligibility("eligible"), storedGeneration: `sha256:${"d".repeat(64)}` }, status: 422 },
      { track: 9_231_216, options: { eligibility: cornerTraceEligibility("ineligible") }, status: 422 },
      { track: 9_231_217, options: { eligibility: null }, status: 422 },
    ];

    for (const candidate of rejected) {
      const lapId = await insertOutlineCandidate(candidate.track, candidate.options);
      expect((await recompute(candidate.track, lapId)).status).toBe(candidate.status);
      expect(getRecordedOutlineByOrdinal(candidate.track, "iracing")).toBeNull();
    }
  });

  test("pooled mode keeps fastest matching evidence and writes nothing when every candidate is rejected", async () => {
    const acceptedTrack = 9_231_220;
    await insertOutlineCandidate(acceptedTrack, { eligibility: cornerTraceEligibility("eligible"), lapTime: 91 });
    await insertOutlineCandidate(acceptedTrack, { eligibility: cornerTraceEligibility("eligible"), ownership: "others", lapTime: 80 });
    await insertOutlineCandidate(acceptedTrack, { eligibility: cornerTraceEligibility("ineligible"), lapTime: 81 });
    await insertOutlineCandidate(acceptedTrack, {
      eligibility: cornerTraceEligibility("eligible"),
      storedGeneration: "sha256:stale",
      lapTime: 82,
    });
    const accepted = await recompute(acceptedTrack);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ lapsUsed: 1 });
    expect(getRecordedOutlineByOrdinal(acceptedTrack, "iracing")?.length).toBeGreaterThanOrEqual(50);

    const rejectedTrack = 9_231_221;
    await insertOutlineCandidate(rejectedTrack, { eligibility: cornerTraceEligibility("ineligible") });
    await insertOutlineCandidate(rejectedTrack, { eligibility: cornerTraceEligibility("eligible"), ownership: "others" });
    await insertOutlineCandidate(rejectedTrack, { eligibility: cornerTraceEligibility("eligible"), storedGeneration: "sha256:stale" });
    await insertOutlineCandidate(rejectedTrack, { eligibility: cornerTraceEligibility("eligible"), gameId: "acc" });
    await insertOutlineCandidate(rejectedTrack, { eligibility: cornerTraceEligibility("eligible"), sessionTrackOrdinal: rejectedTrack + 1 });

    expect((await recompute(rejectedTrack)).status).toBe(404);
    expect(getRecordedOutlineByOrdinal(rejectedTrack, "iracing")).toBeNull();
  });
});

describe("resolveTrackOutline iRacing persistence fallback", () => {
  test("seeds generated outline from current corner-trace evidence", async () => {
    const trackOrdinal = 9_231_201;
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: cornerTraceEligibility("eligible"),
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

  test("rejects wrong-scope, stale, missing, and corner-trace-ineligible fallback candidates without writing", async () => {
    const trackOrdinal = 9_231_202;
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: cornerTraceEligibility("ineligible"),
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: cornerTraceEligibility("eligible"),
      storedGeneration: "sha256:stale-outline-generation",
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: cornerTraceEligibility("eligible"),
      ownership: "others",
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: null,
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: cornerTraceEligibility("eligible"),
      gameId: "acc",
    });
    await insertOutlineCandidate(trackOrdinal, {
      eligibility: cornerTraceEligibility("eligible"),
      sessionTrackOrdinal: trackOrdinal + 1,
    });

    expect(await resolveTrackOutline(trackOrdinal, "iracing")).toBeNull();
    expect(getRecordedOutlineByOrdinal(trackOrdinal, "iracing")).toBeNull();
  });
});
