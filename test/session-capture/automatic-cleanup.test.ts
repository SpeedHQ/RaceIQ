import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";
import { runSessionCaptureMaintenanceNow } from "../../server/session-capture/compressor";
import { loadSettings, saveSettings } from "../../server/runtime/config/settings";
import { resolveDataDir } from "../../server/runtime/config/data-dir";

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
    gameId: "fm-2023", carOrdinal: 1, trackOrdinal: 1, rawFile: path,
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
});
