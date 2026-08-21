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
import { _telemetryCacheForTest } from "../../server/db/telemetry-replay-storage";
import { lapRoutes } from "../../server/routes/laps";
import { sessionRoutes } from "../../server/routes/session-routes";
import { tuneRoutes } from "../../server/routes/tune-routes";
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
const cachedLapIds: number[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  for (const lapId of cachedLapIds) _telemetryCacheForTest.delete(lapId);
  cachedLapIds.length = 0;
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

async function seedUnsafeRecordedLap(): Promise<{ sessionId: number; lapId: number }> {
  const seeded = await seedQualitySession();
  const directory = mkdtempSync(join(tmpdir(), "raceiq-unsafe-inspection-"));
  createdRawDirectories.push(directory);
  const rawFile = join(directory, "session.bin");
  writeFileSync(rawFile, "unsafe-recorded-evidence");
  await db.update(sessions).set({ rawFile }).where(eq(sessions.id, seeded.sessionId)).run();
  await db.update(laps).set({ qualityPolicyVersion: "stale-policy" }).where(eq(laps.id, seeded.lapId)).run();
  _telemetryCacheForTest.set(seeded.lapId, telemetry());
  cachedLapIds.push(seeded.lapId);
  return seeded;
}

async function expectQualityBlocked(response: Response, policyId: string): Promise<void> {
  expect(response.status).toBe(422);
  const body = (await response.json()) as {
    decision: { policyId: string; status: string; reasons: { code: string }[] };
  };
  expect(body.decision).toMatchObject({ policyId, status: "unknown" });
  expect(body.decision.reasons.map(({ code }) => code)).toEqual(["quality_stale"]);
}

describe("quality diagnostics API", () => {
  test("requires matching game scope before returning persisted lap evidence", async () => {
    const { sessionId, lapId } = await seedQualitySession();
    expect((await lapRoutes.request(`/api/laps/${lapId}/quality`)).status).toBe(400);
    expect((await lapRoutes.request(`/api/laps/${lapId}/quality`, { headers: { "X-Game-Id": "invalid" } })).status).toBe(400);
    expect((await lapRoutes.request(`/api/laps/${lapId}/quality`, { headers: { "X-Game-Id": "acc" } })).status).toBe(404);

    const response = await lapRoutes.request(`/api/laps/${lapId}/quality`, { headers: { "X-Game-Id": "iracing" } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lapId).toBe(lapId);
    expect(body.quality.provenance.schemaVersion).toBe(QUALITY_SCHEMA_VERSION);
    expect(body.eligibility["normal-pace"].policyVersion).toBe(ELIGIBILITY_POLICY_VERSION);
    expect(body.qualityGeneration).toBe(body.quality.provenance.outputGeneration);

    await db.update(sessions).set({ ownership: "others" }).where(eq(sessions.id, sessionId)).run();
    expect((await lapRoutes.request(`/api/laps/${lapId}/quality`, { headers: { "X-Game-Id": "iracing" } })).status).toBe(404);
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

  test("requires raw reprocessing when measurement configuration is stale", async () => {
    const { sessionId, lapId } = await seedQualitySession();
    await db.update(sessions).set({ qualityConfigVersion: "stale-config" }).where(eq(sessions.id, sessionId)).run();
    await db.update(laps).set({ qualityConfigVersion: "stale-config" }).where(eq(laps.id, lapId)).run();

    const unavailableResponse = await sessionRoutes.request(`/api/sessions/${sessionId}/quality/rebuild`, { method: "POST" });
    expect(unavailableResponse.status).toBe(409);
    expect(await unavailableResponse.json()).toMatchObject({
      status: { action: "unavailable", stale: { configuration: true } },
    });
    expect((await db.select({ version: laps.qualityConfigVersion }).from(laps).where(eq(laps.id, lapId)).get())?.version).toBe("stale-config");

    const rawDirectory = mkdtempSync(join(tmpdir(), "raceiq-config-stale-"));
    createdRawDirectories.push(rawDirectory);
    const rawFile = join(rawDirectory, "recording.bin");
    writeFileSync(rawFile, new Uint8Array([0]));
    await db.update(sessions).set({ rawFile }).where(eq(sessions.id, sessionId)).run();

    const reprocessResponse = await sessionRoutes.request(`/api/sessions/${sessionId}/quality`);
    expect(await reprocessResponse.json()).toMatchObject({
      action: "reprocess",
      rawAvailable: true,
      stale: { configuration: true },
    });
  });

  test("returns 404 when rebuilding quality for a missing session", async () => {
    const response = await sessionRoutes.request("/api/sessions/2147483647/quality/rebuild", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
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

  test("blocks reports, issues, and rules auto-tuning when stored quality is stale", async () => {
    const { lapId } = await seedUnsafeRecordedLap();

    await expectQualityBlocked(await lapRoutes.request(`/api/laps/${lapId}/export`), "corner-trace");
    await expectQualityBlocked(await tuneRoutes.request(`/api/laps/${lapId}/issues`), "setup-analysis");
    await expectQualityBlocked(
      await tuneRoutes.request("/api/tunes/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: "acc",
          stintId: lapId,
          filePath: "unused.json",
          preview: true,
          engine: "rules",
        }),
      }),
      "setup-analysis",
    );
  });

  test("keeps stale recorded laps inspectable without deriving insights", async () => {
    const { lapId } = await seedUnsafeRecordedLap();
    const gameHeader = { "X-Game-Id": "iracing" };

    const semanticResponse = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
      headers: gameHeader,
    });
    expect(semanticResponse.status).toBe(200);
    const semantic = await semanticResponse.json();
    expect(semantic.envelopes.length).toBeGreaterThan(0);
    expect(semantic.insights).toEqual([]);
    expect(semantic.decision.reasons.map((reason: { code: string }) => reason.code)).toEqual(["quality_stale"]);

    const detailResponse = await lapRoutes.request(`/api/laps/${lapId}`, { headers: gameHeader });
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.telemetry.length).toBeGreaterThan(0);
    expect(detail.insights).toEqual([]);
    expect(detail.decision.reasons.map((reason: { code: string }) => reason.code)).toEqual(["quality_stale"]);

    const notesResponse = await lapRoutes.request(`/api/laps/${lapId}/notes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "inspection remains available" }),
    });
    expect(notesResponse.status).toBe(200);

    const rawResponse = await lapRoutes.request(`/api/laps/${lapId}/export-bin`);
    expect(rawResponse.status).toBe(200);
    expect(rawResponse.headers.get("Content-Disposition")).toContain(".bin.gz");
    expect((await rawResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const deleteResponse = await lapRoutes.request(`/api/laps/${lapId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ success: true });
  });
});
