import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "@raceiq/backend-core/db/index";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { disposeRecordingMaintenanceRuntime } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { beginRecordingStorageImport, reserveRecordingStorageOperation } from "@raceiq/backend-core/session-capture/storage-activity";
import type { SessionDownsampleStatus } from "@raceiq/shared/racing/sessions/downsample";
import { iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { storageRoutes } from "../../src/routes/system/storage-routes";

initGameAdapters();
initServerGameAdapters();
const app = new Hono().route("/", storageRoutes);
const insertedSessions: number[] = [];
const insertedLaps: number[] = [];
const ownedDirs: string[] = [];
const fixturePath = resolve("test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz");
const BASE_TIMESTAMP = 1_800_000_000_000;

function createOwnedDirectory(): string {
  const directory = resolve(join(resolveRecordingDirectory(), `downsample-route-${crypto.randomUUID()}`));
  mkdirSync(directory, { recursive: true });
  ownedDirs.push(directory);
  return directory;
}

async function createCapture(sampleIntervalMs = 10): Promise<{ path: string; rawByteOffset: number; sourceBytes: number }> {
  const sourceFrames = [...iterateSessionFrames(gunzipSync(readFileSync(fixturePath)))].slice(0, 520);
  const baseline = sourceFrames.find(frame => frame.readInt32LE(0) === 1);
  if (!baseline) throw new Error("FM route fixture has no active telemetry frame");
  const path = join(createOwnedDirectory(), "route-fixture.bin");
  const recorder = new SparseSessionRecorder("fm-2023");
  recorder.start(path);
  recorder.writeMetaFrame();
  const rawByteOffset = recorder.getCurrentByteOffset();
  for (let index = 0; index < 1_000; index++) {
    const frame = Buffer.from(baseline);
    frame.writeUInt32LE(index * sampleIntervalMs, 4);
    recorder.writeRecord(frame, BASE_TIMESTAMP + index * sampleIntervalMs);
  }
  await recorder.stop();
  return { path, rawByteOffset, sourceBytes: statSync(path).size };
}

async function insertFixture(file: string, rawByteOffset: number): Promise<number> {
  const { id } = await db
    .insert(sessions)
    .values({
      gameId: "fm-2023",
      carId: "route-test-car",
      trackId: "route-test-track",
      rawFile: file,
      createdAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    })
    .returning({ id: sessions.id })
    .get();
  insertedSessions.push(id);
  const lap = await db
    .insert(laps)
    .values({
      sessionId: id,
      lapNumber: 1,
      lapTime: 10,
      isValid: true,
      rawByteOffset,
      rawFrameCount: 1_000,
    })
    .returning({ id: laps.id })
    .get();
  insertedLaps.push(lap.id);
  return id;
}

async function post(path: string, body: string): Promise<Response> {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

async function getStatus(): Promise<SessionDownsampleStatus> {
  const response = await app.request("/api/storage/session-downsample");
  expect(response.status).toBe(200);
  return await response.json();
}

async function waitForTerminalStatus(): Promise<SessionDownsampleStatus> {
  const deadline = Date.now() + 20_000;
  let status = await getStatus();
  while (status.status === "running" && Date.now() < deadline) {
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 10));
    status = await getStatus();
  }
  if (status.status === "running") throw new Error("Downsample job did not reach terminal status before deadline");
  return status;
}

afterEach(async () => {
  await disposeRecordingMaintenanceRuntime();
  if (insertedLaps.length)
    await db
      .delete(laps)
      .where(inArray(laps.id, insertedLaps.splice(0)))
      .run();
  if (insertedSessions.length)
    await db
      .delete(sessions)
      .where(inArray(sessions.id, insertedSessions.splice(0)))
      .run();
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session downsample storage routes", () => {
  test("strictly validates JSON, mode, age, frequency, and unknown fields", async () => {
    for (const body of [
      "{",
      JSON.stringify({ mode: "all", targetHz: 55 }),
      JSON.stringify({ mode: "all", targetHz: 50, extra: true }),
      JSON.stringify({ mode: "older-than", targetHz: 50, olderThanDays: 7 }),
      JSON.stringify({ mode: "older-than", targetHz: 50 }),
      JSON.stringify({ mode: "unknown", targetHz: 50 }),
      JSON.stringify({ mode: "all" }),
    ]) {
      const response = await post("/api/storage/session-downsample/preview", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid downsample request" });
    }
  });

  test("preview skips 50 Hz recordings for 50 Hz and 80 Hz targets", async () => {
    const fixture = await createCapture(20);
    const id = await insertFixture(fixture.path, fixture.rawByteOffset);
    const beforeFile = readFileSync(fixture.path);

    for (const targetHz of [50, 80] as const) {
      const response = await post("/api/storage/session-downsample/preview", JSON.stringify({ mode: "all", targetHz }));
      expect(response.status).toBe(200);
      const preview = (await response.json()) as { candidateSessionIds: number[]; skipped: { sessionIds: number[]; reason: string }[] };
      expect(preview.candidateSessionIds).not.toContain(id);
      expect(preview.skipped).toContainEqual({ sessionIds: [id], reason: "already-at-or-below-target" });
    }

    expect(readFileSync(fixture.path)).toEqual(beforeFile);
    expect((await db.select({ cap: sessions.downsampledFrequencyHz }).from(sessions).where(eq(sessions.id, id)).get())?.cap).toBeNull();
  });
  test("preview reads real timestamped recording without changing source, indexes, or settings", async () => {
    const fixture = await createCapture();
    const id = await insertFixture(fixture.path, fixture.rawByteOffset);
    const beforeFile = readFileSync(fixture.path);
    const settingsBefore = loadSettings();
    const before = await db
      .select({ rawFile: sessions.rawFile, cap: sessions.downsampledFrequencyHz, offset: laps.rawByteOffset, count: laps.rawFrameCount })
      .from(sessions)
      .innerJoin(laps, eq(laps.sessionId, sessions.id))
      .where(inArray(sessions.id, [id]))
      .get();

    const response = await post("/api/storage/session-downsample/preview", JSON.stringify({ mode: "all", targetHz: 50 }));

    expect(response.status).toBe(200);
    const preview = (await response.json()) as { candidateSessionIds: number[]; fileCount: number; sourceBytes: number };
    expect(preview.candidateSessionIds).toContain(id);
    expect(preview.fileCount).toBeGreaterThan(0);
    expect(preview.sourceBytes).toBeGreaterThanOrEqual(fixture.sourceBytes);
    expect(readFileSync(fixture.path)).toEqual(beforeFile);
    expect(
      await db
        .select({ rawFile: sessions.rawFile, cap: sessions.downsampledFrequencyHz, offset: laps.rawByteOffset, count: laps.rawFrameCount })
        .from(sessions)
        .innerJoin(laps, eq(laps.sessionId, sessions.id))
        .where(inArray(sessions.id, [id]))
        .get(),
    ).toEqual(before);
    const settingsAfter = loadSettings();
    expect(settingsAfter.sessionDownsampleEnabled).toBe(settingsBefore.sessionDownsampleEnabled);
    expect(settingsAfter.sessionDownsampleAgeDays).toBe(settingsBefore.sessionDownsampleAgeDays);
    expect(settingsAfter.sessionDownsampleFrequencyHz).toBe(settingsBefore.sessionDownsampleFrequencyHz);
    expect(settingsAfter.recordingFrequencyHz).toBe(settingsBefore.recordingFrequencyHz);
  });

  for (const request of [{ mode: "all", targetHz: 50 } as const, { mode: "older-than", olderThanDays: 30, targetHz: 50 } as const]) {
    test(`accepts ${request.mode} request and completes real replayable rewrite`, async () => {
      const fixture = await createCapture();
      const id = await insertFixture(fixture.path, fixture.rawByteOffset);
      const settingsBefore = loadSettings();
      const accepted = await post("/api/storage/session-downsample", JSON.stringify(request));
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({ accepted: true });

      const status = await waitForTerminalStatus();
      expect(status.status).toBe("success");
      expect(status.request).toEqual(request);
      expect(status.done).toBe(status.total);
      expect(status.convertedFiles).toBe(1);
      const stored = await db.select().from(sessions).where(eq(sessions.id, id)).get();
      const lap = await db
        .select()
        .from(laps)
        .where(eq(laps.id, insertedLaps.at(-1)!))
        .get();
      expect(stored?.downsampledFrequencyHz).toBe(50);
      expect(stored?.rawFile).not.toBe(fixture.path);
      expect(stored?.rawFile).not.toBeNull();
      expect(statSync(stored!.rawFile!).size).toBeLessThan(fixture.sourceBytes);
      expect(lap?.rawFrameCount).toBe(501);
      const replayed = await parseRawLapFrames(
        { rawFile: stored!.rawFile!, source: null, gameId: "fm-2023", carId: stored!.carId!, trackId: stored!.trackId! },
        lap!.rawByteOffset!,
        lap!.rawFrameCount!,
      );
      expect(replayed.length).toBeGreaterThan(0);
      const settingsAfter = loadSettings();
      expect(settingsAfter.sessionDownsampleEnabled).toBe(settingsBefore.sessionDownsampleEnabled);
      expect(settingsAfter.sessionDownsampleAgeDays).toBe(settingsBefore.sessionDownsampleAgeDays);
      expect(settingsAfter.sessionDownsampleFrequencyHz).toBe(settingsBefore.sessionDownsampleFrequencyHz);
      expect(settingsAfter.recordingFrequencyHz).toBe(settingsBefore.recordingFrequencyHz);
    });
  }

  test("duplicate admission returns 409 without resetting an active job", async () => {
    const fixture = await createCapture();
    await insertFixture(fixture.path, fixture.rawByteOffset);
    let releaseLock!: () => void;
    let enteredLock!: () => void;
    const lockEntered = new Promise<void>((resolveEntered) => {
      enteredLock = resolveEntered;
    });
    const releaseGate = new Promise<void>((resolveRelease) => {
      releaseLock = resolveRelease;
    });
    const heldLock = withSessionCaptureMaintenanceLock(async () => {
      enteredLock();
      await releaseGate;
    });
    await lockEntered;
    try {
      const first = await post("/api/storage/session-downsample", JSON.stringify({ mode: "all", targetHz: 50 }));
      expect(first.status).toBe(202);
      const original = await getStatus();
      expect(original.status).toBe("running");
      expect(original.request).toEqual({ mode: "all", targetHz: 50 });
      expect(original.done).toBe(0);
      const duplicate = await post("/api/storage/session-downsample", JSON.stringify({ mode: "all", targetHz: 60 }));
      expect(duplicate.status).toBe(409);
      const afterDuplicate = await getStatus();
      expect(afterDuplicate.status).toBe("running");
      expect(afterDuplicate.request).toEqual({ mode: "all", targetHz: 50 });
      expect(afterDuplicate.done).toBe(0);
    } finally {
      releaseLock();
      await heldLock;
      await waitForTerminalStatus();
    }
  });

  for (const operation of ["import", "directory-move", "layout-migration"] as const) {
    test(`${operation} ownership rejects archival admission without resetting status`, async () => {
      const before = await getStatus();
      const release = operation === "import" ? beginRecordingStorageImport() : reserveRecordingStorageOperation(operation);
      try {
        const response = await post("/api/storage/session-downsample", JSON.stringify({ mode: "all", targetHz: 50 }));
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe(operation === "import" ? "IMPORT_ACTIVE" : "MOVE_ACTIVE");
        expect(await getStatus()).toEqual(before);
      } finally {
        release();
      }
    });
  }
});
