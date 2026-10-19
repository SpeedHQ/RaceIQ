import { expect, test } from "@playwright/test";
import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runtime } from "../../config/runtime";

test.describe.configure({ retries: 0 });
test("an empty recording folder does not show a migration dialog", async ({ page, request }) => {
  const api = `http://localhost:${runtime.freshInstall.port}`;
  const access = await request.get(`${api}/api/auth/status`);
  expect(access.ok()).toBe(true);
  if ((await access.json() as { pending: boolean }).pending) {
    const setup = await request.post(`${api}/api/auth/setup`, { data: { password: null, exposureConfirmed: true } });
    expect(setup.ok()).toBe(true);
  }
  const status = await request.get(`${api}/api/storage/layout-migration`);
  expect(status.ok()).toBe(true);
  expect(await status.json()).toMatchObject({ fileCount: 0, progress: { status: "idle" } });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("legacy recordings automatically prompt for consent and migrate to the user-selected folder", async ({ page, request }) => {
  // Fixture conversion and browser setup run before the 60-second migration wait.
  test.setTimeout(120_000);
  const api = `http://localhost:${runtime.freshInstall.port}`;
  const settingsPath = join(runtime.freshInstall.dataDir, "settings.json");
  const originalSettings = readFileSync(settingsPath, "utf8");
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "raceiq-location-migration-")));
  const offlineDataDir = join(workspace, "offline");
  const source = join(runtime.freshInstall.dataDir, "sessions");
  const legacySource = join(source, "fm-2023");
  const occupied = join(workspace, "occupied");
  let importedSessionIds: number[] = [];
  let importedFiles: string[] = [];
  let originalCaptures: Buffer[] = [];
  try {
    mkdirSync(occupied);
    mkdirSync(offlineDataDir);
    mkdirSync(legacySource, { recursive: true });
    writeFileSync(join(occupied, "keep.txt"), "Do not overwrite");
    writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(originalSettings), onboardingComplete: true }));
    // Convert fixture offline; only import its resulting capture into the running app.
    await promisify(execFile)("bun", [
      "run", "apps/backend/scripts/data/seed-db.ts",
      "--games=fm-2023",
      "--fixtures=test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
      "--legacy-recordings",
    ], { cwd: resolve(__dirname, "../../.."), env: { ...process.env, DATA_DIR: offlineDataDir }, encoding: "utf8" });
    const offlineCaptureDir = join(offlineDataDir, "sessions", "fm-2023");
    const captureFiles = readdirSync(offlineCaptureDir).filter((entry) => entry.endsWith(".bin"));
    expect(captureFiles.length).toBeGreaterThan(0);
    const access = await request.get(`${api}/api/auth/status`);
    expect(access.ok()).toBe(true);
    if ((await access.json() as { pending: boolean }).pending) {
      const setup = await request.post(`${api}/api/auth/setup`, { data: { password: null, exposureConfirmed: true } });
      expect(setup.ok()).toBe(true);
    }
    const importResponse = await request.post(`${api}/api/laps/import`, {
      multipart: {
        file: {
          name: captureFiles[0]!,
          mimeType: "application/octet-stream",
          buffer: readFileSync(join(offlineCaptureDir, captureFiles[0]!)),
        },
        ownership: "mine",
      },
    });
    expect(importResponse.ok()).toBe(true);
    const importResult = await importResponse.json() as { laps?: { sessionId: number }[] };
    importedSessionIds = [...new Set(importResult.laps?.map((lap) => lap.sessionId) ?? [])];
    expect(importedSessionIds.length).toBeGreaterThan(0);
    const database = createClient({ url: `file:${join(runtime.freshInstall.dataDir, "app.db")}` });
    try {
      const transaction = await database.transaction("write");
      try {
        const rows = await transaction.execute({
          sql: `SELECT id, raw_file FROM sessions WHERE id IN (${importedSessionIds.map(() => "?").join(",")})`,
          args: importedSessionIds,
        });
        expect(rows.rows).toHaveLength(importedSessionIds.length);
        const updates = rows.rows.map((row) => {
          const original = String(row.raw_file);
          expect(existsSync(original), `imported capture exists at ${original}`).toBe(true);
          const bytes = readFileSync(original);
          expect(bytes.length, `imported capture ${original} is non-empty`).toBeGreaterThan(0);
          const filename = original.split(/[\\/]/).at(-1)!;
          const destination = join(legacySource, filename);
          renameSync(original, destination);
          expect(readFileSync(destination)).toEqual(bytes);
          importedFiles.push(filename);
          originalCaptures.push(bytes);
          return { sql: "UPDATE sessions SET raw_file = ? WHERE id = ?", args: [destination, Number(row.id)] };
        });
        await transaction.batch(updates);
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } finally {
      await database.close();
    }
    const legacyFiles = importedFiles.map((filename) => join(legacySource, filename));
    expect(importedFiles.length).toBeGreaterThan(0);
    const status = await request.get(`${api}/api/storage/layout-migration`);
    expect(status.ok()).toBe(true);
    expect(await status.json()).toMatchObject({ directory: source, fileCount: importedFiles.length, sessionCount: importedFiles.length });
    legacyFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(originalCaptures[index]));
    importedFiles.forEach((filename) => expect(existsSync(join(source, "fm-2023", "own", filename))).toBe(false));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const prompt = page.getByRole("dialog", { name: "Organize your recordings", exact: true });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("radio", { name: /Keep current folder/ })).toBeChecked();
    await expect(prompt.getByRole("button", { name: "Organize recordings", exact: true })).toBeEnabled();
    await expect(prompt).toContainText(source);
    // Detection and rendering must not move anything before the user consents.
    legacyFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(originalCaptures[index]));
    importedFiles.forEach((filename) => expect(existsSync(join(source, "fm-2023", "own", filename))).toBe(false));

    // Required migration cannot be skipped by a button, Escape, or backdrop click.
    await expect(prompt.getByRole("button", { name: "Later", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(prompt).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(prompt).toBeVisible();
    legacyFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(originalCaptures[index]));
    importedFiles.forEach((filename) => expect(existsSync(join(source, "fm-2023", "own", filename))).toBe(false));

    await prompt.getByRole("radio", { name: "Choose a new folder", exact: true }).check();
    await expect(prompt.getByRole("textbox", { name: "Folder path", exact: true })).toBeVisible();
    await prompt.getByRole("textbox", { name: "Folder path", exact: true }).fill(occupied);
    const accepted = page.waitForResponse((response) => response.url().endsWith("/api/storage/layout-migration") && response.request().method() === "POST");
    await prompt.getByRole("button", { name: "Organize and move recordings", exact: true }).click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toEqual({ directory: occupied });
    await expect.poll(async () => {
      const response = await request.get(`${api}/api/storage/layout-migration`);
      expect(response.ok()).toBe(true);
      return response.json();
    }, { timeout: 60_000 }).toMatchObject({
      directory: occupied,
      fileCount: 0,
      progress: { status: "success", migrated: importedFiles.length, failed: 0 },
    });
    const success = page.getByRole("dialog", { name: "Recordings organized", exact: true });
    await expect(success).toBeVisible();
    await expect(success.getByRole("status")).toHaveText(`Organized ${importedFiles.length} files.`);
    await expect(success).toContainText(occupied);
    await success.getByRole("button", { name: "Close", exact: true }).click();
    const reloadedStatus = page.waitForResponse((response) => response.url().endsWith("/api/storage/layout-migration") && response.request().method() === "GET");
    await page.reload({ waitUntil: "networkidle" });
    expect(await (await reloadedStatus).json()).toMatchObject({ fileCount: 0 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("Do not overwrite");
    importedFiles.forEach((filename, index) => expect(readFileSync(join(occupied, "fm-2023", "own", filename))).toEqual(originalCaptures[index]));
    legacyFiles.forEach((file) => expect(existsSync(file)).toBe(false));
    const settings = await request.get(`${api}/api/settings`);
    expect(settings.ok()).toBe(true);
    expect(await settings.json()).toMatchObject({ recordingDirectory: occupied, resolvedRecordingDirectory: occupied });
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("Do not overwrite");
  } finally {
    try {
      if (importedSessionIds.length) {
        const cleanup = await request.post(`${api}/api/sessions/bulk-delete`, { data: { ids: importedSessionIds } });
        expect(cleanup.ok(), "cleanup imported migration sessions through session API").toBe(true);
      }
    } finally {
      importedFiles.forEach((filename) => {
        for (const directory of [legacySource, join(occupied, "fm-2023", "own")]) {
          const file = join(directory, filename);
          if (existsSync(file)) unlinkSync(file);
        }
      });
      writeFileSync(settingsPath, originalSettings);
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});
