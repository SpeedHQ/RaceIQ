/**
 * GET /api/laps/:id/issues — per-lap tune issue feed route. Uses the real
 * (test) SQLite DB directly, same convention as lap-legacy-detection.test.ts,
 * since getLapById reads through the raw session file rather than a mockable
 * layer.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION } from "../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { cacheDelete, cacheSet } from "../../server/db/telemetry-replay-storage";
import { tuneRoutes } from "../../server/routes/tune-routes";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

initGameAdapters();
initServerGameAdapters();

const TRACK_ORDINAL = 434343;

async function insertSession(rawFile: string | null): Promise<number> {
  const row = await db.insert(sessions).values({ carOrdinal: 1, trackOrdinal: TRACK_ORDINAL, gameId: "iracing", rawFile }).returning({ id: sessions.id }).get();
  return row!.id;
}

async function insertLap(sessionId: number, lapNumber: number): Promise<number> {
  const row = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime: 90.0,
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: null,
    })
    .returning({ id: laps.id })
    .get();
  return row!.id;
}

describe("GET /api/laps/:id/issues", () => {
  const sessionIds: number[] = [];
  const cachedLapIds: number[] = [];

  afterEach(async () => {
    for (const sid of sessionIds) {
      await db.delete(laps).where(eq(laps.sessionId, sid)).run();
      await db.delete(sessions).where(eq(sessions.id, sid)).run();
    }
    for (const lapId of cachedLapIds) cacheDelete(lapId);
    cachedLapIds.length = 0;
    sessionIds.length = 0;
  });

  test("legacy lap with no current quality evidence rejects generated issues", async () => {
    const sid = await insertSession(null); // no rawFile → legacy, telemetry === []
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 1);
    const res = await tuneRoutes.request(`/api/laps/${lapId}/issues?gameId=iracing`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      decision: { status: string; reasons: { code: string }[] };
    };
    expect(body.decision.status).toBe("unknown");
    expect(body.decision.reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);
  });

  test("returns telemetry-derived issues without false race-event evidence", async () => {
    const sid = await insertSession(null);
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 7);
    const packets = qualityPackets(100).map((packet) => ({
      ...packet,
      TirePressureFrontLeft: 24,
      TirePressureFrontRight: 24,
      TirePressureRearLeft: 24,
      TirePressureRearRight: 24,
    }));
    const generation = `sha256:${"1".repeat(64)}`;
    const draftQuality = summarize(packets);
    const quality = {
      ...draftQuality,
      provenance: {
        ...draftQuality.provenance,
        sourceGeneration: `sha256:${"2".repeat(64)}`,
        outputGeneration: generation,
      },
    };
    const eligibility = evaluateAllEligibility(quality);
    eligibility["setup-analysis"] = {
      ...eligibility["normal-pace"],
      policyId: "setup-analysis",
    };
    await db
      .update(laps)
      .set({
        quality,
        eligibility,
        qualityGeneration: generation,
        qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
        qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
        qualityConfigVersion: QUALITY_CONFIG_VERSION,
      })
      .where(eq(laps.id, lapId))
      .run();
    cacheSet(lapId, packets);
    cachedLapIds.push(lapId);

    const res = await tuneRoutes.request(`/api/laps/${lapId}/issues?gameId=iracing`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body).toHaveLength(4);
    expect(body).toContainEqual({
      kind: "tyre-pressure",
      severity: "critical",
      detail: "FL pressure -3.5 psi vs target",
      lapNumber: 7,
    });
    expect(body.every((issue) => !("eventIds" in issue))).toBe(true);
    const crossGame = await tuneRoutes.request(`/api/laps/${lapId}/issues?gameId=fm-2023`);
    expect(crossGame.status).toBe(404);
  });

  test("unknown lap id returns 404", async () => {
    const res = await tuneRoutes.request("/api/laps/999999999/issues?gameId=iracing");
    expect(res.status).toBe(404);
  });
});
