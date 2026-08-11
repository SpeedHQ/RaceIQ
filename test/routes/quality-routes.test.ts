import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION, LOCAL_PLAYER_EVIDENCE, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator, summarizeLapQuality } from "../../shared/racing/quality/measure";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { finalizeLapQualityGeneration, finalizeRecordingQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { lapRoutes } from "../../server/routes/laps";
import { sessionRoutes } from "../../server/routes/session-routes";
import { packet } from "../support/telemetry/resolver";

initGameAdapters();
initServerGameAdapters();

const VERSION: TelemetryVersionIdentity = {
  catalogVersion: "quality-api-catalog",
  catalogHash: "quality-api-hash",
  catalogSchemaVersion: "quality-api-schema",
  parserVersion: "quality-api-parser",
  resolverVersion: "quality-api-resolver",
  derivationVersion: "quality-api-derivation",
};

const createdSessionIds: number[] = [];
const createdRawDirectories: string[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdSessionIds.length = 0;
  for (const directory of createdRawDirectories) rmSync(directory, { recursive: true, force: true });
  createdRawDirectories.length = 0;
});

function telemetry(): TelemetryPacket[] {
  return Array.from({ length: 201 }, (_, index) => {
    const fraction = index / 200;
    return packet("iracing", {
      TimestampMS: index * 50,
      DistanceTraveled: fraction * 5_000,
      CurrentLap: fraction * 10,
      LastLap: 10,
      PositionX: 100 + fraction,
      PositionZ: 200 + fraction,
      Speed: 55,
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
        sessionTick: index,
        sessionNum: 0,
        driverCarIdx: 1,
        trackLengthM: 5_000,
        lapDistanceM: fraction * 5_000,
        lapDistancePct: fraction,
        onPitRoad: false,
        playerTrackSurface: 3,
        incidents: 0,
        trackWetness: 0,
        carName: "Quality test car",
        carClassName: "Quality test class",
        trackName: "Quality test track",
      },
    });
  });
}

async function seedQualitySession(): Promise<{ sessionId: number; lapId: number }> {
  const packets = telemetry();
  const recordingAccumulator = new RecordingQualityAccumulator("native-live", LOCAL_PLAYER_EVIDENCE, VERSION);
  for (const sample of packets) recordingAccumulator.observe(sample);
  const recordingQuality = finalizeRecordingQualityGeneration(
    recordingAccumulator.finalize("complete", {
      state: "verified",
      sourceGeneration: "quality-api-archive",
    }),
  );
  const draftQuality = summarizeLapQuality({
    packets,
    lapTime: 10,
    timingSource: "simulator-history",
    complete: true,
    structurallyValid: true,
    invalidReason: null,
    classification: DEFAULT_LAP_CLASSIFICATION,
    sourceKind: "native-live",
    participant: LOCAL_PLAYER_EVIDENCE,
    versionIdentity: VERSION,
  });
  const generated = finalizeLapQualityGeneration(draftQuality, recordingQuality.provenance.sourceGeneration, {
    lapNumber: 1,
    rawByteOffset: null,
    rawFrameCount: packets.length,
  });
  const quality = generated.quality;
  const sessionId = (
    await db
      .insert(sessions)
      .values({
        carOrdinal: 991_236,
        trackOrdinal: 992_236,
        gameId: "iracing",
        source: "native-live",
        recordingQuality,
        qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
        lapDetectorVersion: "iracing_lapdetector_v5",
        qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
        qualityConfigVersion: QUALITY_CONFIG_VERSION,
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
        rawByteOffset: null,
        rawFrameCount: packets.length,
        lapTime: 10,
        isValid: true,
        quality,
        eligibility: generated.eligibility,
        qualityGeneration: quality.provenance.outputGeneration,
        qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
        qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
        qualityConfigVersion: QUALITY_CONFIG_VERSION,
      })
      .returning({ id: laps.id })
      .get()
  ).id;
  return { sessionId, lapId };
}

describe("quality diagnostics API", () => {
  test("returns persisted lap evidence and policy decisions", async () => {
    const { lapId } = await seedQualitySession();
    const response = await lapRoutes.request(`/api/laps/${lapId}/quality`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lapId).toBe(lapId);
    expect(body.quality.provenance.schemaVersion).toBe(QUALITY_SCHEMA_VERSION);
    expect(body.eligibility["normal-pace"].policyVersion).toBe(ELIGIBILITY_POLICY_VERSION);
    expect(body.qualityGeneration).toBe(body.quality.provenance.outputGeneration);
  });

  test("returns session recording evidence, rebuild state, and lap generations", async () => {
    const { sessionId, lapId } = await seedQualitySession();
    const response = await sessionRoutes.request(`/api/sessions/${sessionId}/quality`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("current");
    expect(body.recordingQuality.provenance.schemaVersion).toBe(QUALITY_SCHEMA_VERSION);
    expect(body.laps).toEqual([expect.objectContaining({ id: lapId, qualityGeneration: expect.any(String) })]);
  });

  test("rebuilds stale policy decisions once without changing measured quality generation", async () => {
    const { sessionId, lapId } = await seedQualitySession();
    const before = await db.select({ generation: laps.qualityGeneration }).from(laps).where(eq(laps.id, lapId)).get();
    await db.update(sessions).set({ qualityPolicyVersion: "stale-policy" }).where(eq(sessions.id, sessionId)).run();
    await db.update(laps).set({ qualityPolicyVersion: "stale-policy" }).where(eq(laps.id, lapId)).run();

    const staleResponse = await sessionRoutes.request(`/api/sessions/${sessionId}/quality`);
    expect((await staleResponse.json()).action).toBe("rebuild_eligibility");

    const rebuildResponse = await sessionRoutes.request(`/api/sessions/${sessionId}/quality/rebuild`, { method: "POST" });
    expect(rebuildResponse.status).toBe(200);
    const rebuilt = await rebuildResponse.json();
    expect(rebuilt.strategy).toBe("eligibility");
    expect(rebuilt.status.action).toBe("current");

    const stored = await db.select({ generation: laps.qualityGeneration, policyVersion: laps.qualityPolicyVersion, eligibility: laps.eligibility }).from(laps).where(eq(laps.id, lapId)).get();
    expect(stored?.generation).toBe(before?.generation);
    expect(stored?.policyVersion).toBe(ELIGIBILITY_POLICY_VERSION);
    expect(stored?.eligibility?.["corner-trace"].policyVersion).toBe(ELIGIBILITY_POLICY_VERSION);

    const repeatResponse = await sessionRoutes.request(`/api/sessions/${sessionId}/quality/rebuild`, { method: "POST" });
    expect((await repeatResponse.json()).strategy).toBe("none");
  });

  test("reports unavailable instead of inventing rebuilt quality without raw evidence", async () => {
    const { sessionId } = await seedQualitySession();
    await db.update(sessions).set({ qualitySchemaVersion: "stale-schema" }).where(eq(sessions.id, sessionId)).run();

    const response = await sessionRoutes.request(`/api/sessions/${sessionId}/quality/rebuild`, { method: "POST" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.status).toMatchObject({ action: "unavailable", rawAvailable: false });
  });

  test("reports unavailable canonical metadata without inventing archive provenance", async () => {
    const { sessionId, lapId } = await seedQualitySession();
    const response = await sessionRoutes.request(`/api/sessions/${sessionId}/evidence-retention`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId,
      action: "raw_unavailable",
      canDeleteRaw: false,
      reasons: ["raw_redecode_required"],
      availability: {
        rawCapture: false,
        canonicalArchive: {
          state: "unavailable",
          semanticIds: [],
          eventIds: [],
          provenance: null,
        },
      },
    });
    expect(body.laps).toEqual([expect.objectContaining({ lapId })]);
  });

  test("retains existing raw capture when canonical archive metadata is unavailable", async () => {
    const { sessionId } = await seedQualitySession();
    const directory = mkdtempSync(join(tmpdir(), "raceiq-retention-"));
    createdRawDirectories.push(directory);
    const rawFile = join(directory, "session.bin");
    writeFileSync(rawFile, "raw-evidence");
    await db.update(sessions).set({ rawFile }).where(eq(sessions.id, sessionId)).run();

    const response = await sessionRoutes.request(`/api/sessions/${sessionId}/evidence-retention`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId,
      action: "retain_raw",
      canDeleteRaw: false,
      reasons: ["raw_redecode_required"],
      availability: {
        rawCapture: true,
        canonicalArchive: { state: "unavailable", semanticIds: [], eventIds: [], provenance: null },
      },
    });
    expect(existsSync(rawFile)).toBe(true);
  });

  test("returns 404 for missing session evidence-retention assessment", async () => {
    const response = await sessionRoutes.request("/api/sessions/2147483647/evidence-retention");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  test("blocks AI preflight with a machine-readable decision when quality is unknown", async () => {
    const sessionId = (
      await db
        .insert(sessions)
        .values({
          carOrdinal: 993_236,
          trackOrdinal: 994_236,
          gameId: "iracing",
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
        })
        .returning({ id: laps.id })
        .get()
    ).id;

    const response = await lapRoutes.request(`/api/laps/${lapId}/analyse`, { method: "POST" });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.decision).toEqual(
      expect.objectContaining({
        policyId: "corner-trace",
        status: "unknown",
      }),
    );
    expect(body.decision.reasons.map((reason: { code: string }) => reason.code)).toContain("quality_not_rebuilt");
  });
});
