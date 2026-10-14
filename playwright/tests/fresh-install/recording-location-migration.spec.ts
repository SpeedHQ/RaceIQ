import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtime } from "../../config/runtime";

test.describe.configure({ retries: 0 });
test("recording migration imports legacy captures, rejects occupied folders, and relocates on retry", async ({ request }) => {
  const api = `http://localhost:${runtime.freshInstall.port}`;
  const settingsPath = join(runtime.freshInstall.dataDir, "settings.json");
  const originalSettings = readFileSync(settingsPath, "utf8");
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "raceiq-location-migration-")));
  const source = join(runtime.freshInstall.dataDir, "sessions");
  const destination = join(workspace, "destination");
  const occupied = join(workspace, "occupied");
  let importedFiles: string[] = [];
  let originalCaptures: Buffer[] = [];
  try {
    mkdirSync(destination);
    mkdirSync(occupied);
    mkdirSync(join(source, "fm-2023"), { recursive: true });
    const previousFiles = new Set(readdirSync(join(source, "fm-2023")));
    writeFileSync(join(occupied, "keep.txt"), "Do not overwrite");
    writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(originalSettings), onboardingComplete: true }));
    const imported = spawnSync("bun", [
      "run", "apps/backend/scripts/data/seed-db.ts",
      "--games=fm-2023",
      "--fixtures=test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
      "--legacy-recordings",
    ], { cwd: resolve(__dirname, "../../.."), env: { ...process.env, DATA_DIR: runtime.freshInstall.dataDir }, encoding: "utf8" });
    expect(imported.status, imported.stderr || imported.stdout).toBe(0);
    importedFiles = readdirSync(join(source, "fm-2023")).filter((entry) => !previousFiles.has(entry) && entry.endsWith(".bin"));
    expect(importedFiles.length).toBeGreaterThan(0);
    const legacyFiles = importedFiles.map((filename) => join(source, "fm-2023", filename));
    const organizedFiles = importedFiles.map((filename) => join(destination, "fm-2023", "own", filename));
    originalCaptures = legacyFiles.map((file) => readFileSync(file));

    const access = await request.get(`${api}/api/auth/status`);
    expect(access.ok()).toBe(true);
    if ((await access.json() as { pending: boolean }).pending) {
      const setup = await request.post(`${api}/api/auth/setup`, { data: { password: null, exposureConfirmed: true } });
      expect(setup.ok()).toBe(true);
    }
    const status = await request.get(`${api}/api/storage/layout-migration`);
    expect(status.ok()).toBe(true);
    expect(await status.json()).toMatchObject({ directory: source, fileCount: importedFiles.length, sessionCount: importedFiles.length });
    legacyFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(originalCaptures[index]));
    expect(existsSync(join(source, "fm-2023", "own", importedFiles[0]!))).toBe(false);

    const rejected = await request.post(`${api}/api/storage/layout-migration`, { data: { directory: occupied } });
    expect(rejected.ok()).toBe(false);
    expect(await rejected.json()).toMatchObject({ code: "DESTINATION_NOT_EMPTY" });
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("Do not overwrite");
    legacyFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(originalCaptures[index]));

    const accepted = await request.post(`${api}/api/storage/layout-migration`, { data: { directory: destination } });
    expect(accepted.status()).toBe(202);
    await expect.poll(async () => {
      const response = await request.get(`${api}/api/storage/layout-migration`);
      expect(response.ok()).toBe(true);
      return response.json();
    }, { timeout: 60_000 }).toMatchObject({
      directory: destination,
      fileCount: 0,
      progress: { status: "success", migrated: importedFiles.length, failed: 0 },
    });
    organizedFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(originalCaptures[index]));
    legacyFiles.forEach((file) => expect(existsSync(file)).toBe(false));
    const settings = await request.get(`${api}/api/settings`);
    expect(settings.ok()).toBe(true);
    expect(await settings.json()).toMatchObject({ recordingDirectory: destination, resolvedRecordingDirectory: destination });
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("Do not overwrite");
  } finally {
    importedFiles.forEach((filename) => {
      const file = join(source, "fm-2023", filename);
      if (existsSync(file)) unlinkSync(file);
    });
    writeFileSync(settingsPath, originalSettings);
    rmSync(workspace, { recursive: true, force: true });
  }
});
