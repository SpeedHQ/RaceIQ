import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { runSessionCaptureMaintenanceNow } from "@raceiq/backend-core/session-capture/compressor";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { cleanupOrphanSessionFiles } from "@raceiq/backend-core/session-capture/cleanup";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { timestampForFilename } from "@raceiq/backend-core/session-capture/filename";

const settingsPath = join(resolveDataDir(), "settings.json");
const originalSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
const paths: string[] = [];
const ids: number[] = [];

async function capture(daysOld: number): Promise<{ id: number; path: string }> {
  const directory = join(resolveDataDir(), "sessions", `auto-cleanup-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  paths.push(directory);
  const path = join(directory, "capture.bin.gz");
  writeFileSync(path, "capture");
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
    saveSettings({ ...loadSettings(), sessionCleanupEnabled: false, sessionCleanupAgeDays: 90 });

    await runSessionCaptureMaintenanceNow();
    expect(existsSync(old.path)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, old.id)).get())?.rawFile).toBe(old.path);

    saveSettings({ ...loadSettings(), sessionCleanupEnabled: true, sessionCleanupAgeDays: 90 });
    expect(loadSettings().sessionCleanupEnabled).toBe(true);
    await runSessionCaptureMaintenanceNow();

    expect(existsSync(old.path)).toBe(false);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, old.id)).get())?.rawFile).toBeNull();
    expect(existsSync(recent.path)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, recent.id)).get())?.rawFile).toBe(recent.path);
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
