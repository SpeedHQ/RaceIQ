import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { client, db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { runSessionCaptureMaintenanceNow } from "@raceiq/backend-core/session-capture/compressor";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { cleanupOrphanSessionFiles } from "@raceiq/backend-core/session-capture/cleanup";
import { timestampForFilename } from "@raceiq/backend-core/session-capture/filename";

initGameAdapters();
initServerGameAdapters();

const settingsPath = join(resolveDataDir(), "settings.json");
const originalSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
const paths: string[] = [];
const ids: number[] = [];

async function capture(daysOld: number, extraAgeMs = 0): Promise<{ id: number; path: string }> {
  const directory = join(resolveDataDir(), "sessions", `auto-cleanup-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  paths.push(directory);
  const path = join(directory, "capture.bin.gz");
  writeFileSync(path, "capture");
  const row = await db.insert(sessions).values({
    gameId: "fm-2023", carId: "1", trackId: "1", rawFile: path,
    createdAt: new Date(Date.now() - daysOld * 86_400_000 - extraAgeMs).toISOString(),
  }).returning({ id: sessions.id }).get();
  ids.push(row.id);
  return { id: row.id, path };
}
async function eligibleCapture(daysOld: number): Promise<{ id: number; path: string }> {
  const directory = join(resolveRecordingDirectory(), `auto-downsample-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  paths.push(directory);
  const path = join(directory, "capture.bin");
  const source = gunzipSync(readFileSync("test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"));
  const recorder = new SparseSessionRecorder("fm-2023");
  recorder.start(path);
  recorder.writeMetaFrame();
  let count = 0;
  for (const frame of iterateSessionFrames(source)) {
    recorder.writeRecord(frame);
    if (++count === 520) break;
  }
  await recorder.stop();
  const row = await db.insert(sessions).values({
    gameId: "fm-2023", carId: "1", trackId: "1", rawFile: path,
    createdAt: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
  }).returning({ id: sessions.id }).get();
  ids.push(row.id);
  return { id: row.id, path };
}

afterEach(async () => {
  for (const id of ids.splice(0)) await db.delete(sessions).where(eq(sessions.id, id)).run();
  for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true });
  if (originalSettings === null) rmSync(settingsPath, { force: true });
  else writeFileSync(settingsPath, originalSettings);
});

describe("automatic capture cleanup", () => {
  test("remains off until opted in, then archives only captures older than persisted age", async () => {
    const old = await capture(100);
    const recent = await capture(40);
    saveSettings({ ...loadSettings(), sessionCleanupEnabled: false, sessionCleanupAgeDays: 90, sessionDownsampleEnabled: false, sessionDownsampleAgeDays: 30, sessionDownsampleFrequencyHz: 50 });

    await runSessionCaptureMaintenanceNow();
    expect(existsSync(old.path)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, old.id)).get())?.rawFile).toBe(old.path);

    saveSettings({ ...loadSettings(), sessionCleanupEnabled: true, sessionCleanupAgeDays: 90, sessionDownsampleEnabled: false });
    expect(loadSettings().sessionCleanupEnabled).toBe(true);
    await runSessionCaptureMaintenanceNow();

    expect(existsSync(old.path)).toBe(false);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, old.id)).get())?.rawFile).toBeNull();
    expect(existsSync(recent.path)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, recent.id)).get())?.rawFile).toBe(recent.path);
  });
  test("deletes only records strictly older than the configured age", async () => {
    const originalNow = Date.now;
    const fixedNow = Date.UTC(2025, 0, 1);
    Date.now = () => fixedNow;
    try {
      const boundary = await capture(90);
      const older = await capture(90, 1);
      saveSettings({ ...loadSettings(), sessionCleanupEnabled: true, sessionCleanupAgeDays: 90, sessionDownsampleEnabled: false });
      await runSessionCaptureMaintenanceNow();
      expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, boundary.id)).get())?.rawFile).toBe(boundary.path);
      expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, older.id)).get())?.rawFile).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });
  test("downsamples aged eligible files before deletion and honors established caps on the next pass", async () => {
    const eligible = await eligibleCapture(40);
    const deleted = await capture(100);
    saveSettings({
      ...loadSettings(),
      sessionDownsampleEnabled: true,
      sessionDownsampleAgeDays: 30,
      sessionDownsampleFrequencyHz: 50,
      sessionCleanupEnabled: true,
      sessionCleanupAgeDays: 90,
    });
    await runSessionCaptureMaintenanceNow();
    const first = await db.select({ rawFile: sessions.rawFile, cap: sessions.downsampledFrequencyHz })
      .from(sessions).where(eq(sessions.id, eligible.id)).get();
    expect(first?.cap).toBe(50);
    expect(first?.rawFile).not.toBe(eligible.path);
    expect(first?.rawFile).not.toBeNull();
    expect(existsSync(first!.rawFile!)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, deleted.id)).get())?.rawFile).toBeNull();
    await runSessionCaptureMaintenanceNow();
    const second = await db.select({ rawFile: sessions.rawFile, cap: sessions.downsampledFrequencyHz })
      .from(sessions).where(eq(sessions.id, eligible.id)).get();
    expect(second).toEqual(first);
  });

  test("skips deletion when automatic downsampling fails", async () => {
    const candidate = await eligibleCapture(100);
    const trigger = `automatic_downsample_failure_${candidate.id}`;
    await client.execute(`
      CREATE TRIGGER ${trigger} BEFORE UPDATE OF downsampled_frequency_hz ON sessions
      WHEN OLD.id = ${candidate.id}
      BEGIN SELECT RAISE(ABORT, 'Injected downsample failure'); END
    `);
    saveSettings({
      ...loadSettings(),
      sessionDownsampleEnabled: true,
      sessionDownsampleAgeDays: 30,
      sessionDownsampleFrequencyHz: 50,
      sessionCleanupEnabled: true,
      sessionCleanupAgeDays: 90,
    });
    try {
      await expect(runSessionCaptureMaintenanceNow()).rejects.toThrow();
    } finally {
      await client.execute(`DROP TRIGGER ${trigger}`);
    }
    const current = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, candidate.id)).get();
    expect(current?.rawFile).not.toBeNull();
    expect(current?.rawFile).not.toBeUndefined();
    expect(existsSync(current!.rawFile!)).toBe(true);
  });
  test("preserves unpublished direct files while referenced and removes only controlled orphan files", async () => {
    const directory = join(resolveRecordingDirectory(), "fm-2023", "own", `${timestampForFilename()}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    paths.push(directory);
    const manifest = join(directory, "capture-manifest.json");
    const raw = join(directory, `${crypto.randomUUID()}.bin`);
    const unrelated = join(directory, "notes.txt");
    writeFileSync(manifest, JSON.stringify({
      version: 3, gameId: "fm-2023", sourceRevision: "direct-cleanup",
      sourceCoordinates: "native-wire-v1", sourceByteLength: 12, sourceRecordCount: 0, chunks: [],
    }));
    writeFileSync(raw, "unpublished native capture bytes");
    writeFileSync(unrelated, "user notes");
    const row = await db.insert(sessions).values({
      gameId: "fm-2023", carId: "test-car", trackId: "test-track", rawFile: manifest,
      captureLayoutVersion: 1, captureManifestFile: manifest,
    }).returning({ id: sessions.id }).get();
    ids.push(row.id);
    await cleanupOrphanSessionFiles(() => false);
    expect(existsSync(raw)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    await db.delete(sessions).where(eq(sessions.id, row.id)).run();
    await cleanupOrphanSessionFiles(() => false);
    expect(existsSync(raw)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("user notes");
  });
});
