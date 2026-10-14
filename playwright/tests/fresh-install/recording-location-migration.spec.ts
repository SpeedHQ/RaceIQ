import { expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtime } from "../../config/runtime";

test("recording migration prompt defers, rejects occupied folders, and relocates recordings on retry", async ({ page, request }) => {
  test.setTimeout(120_000);
  const settingsPath = join(runtime.freshInstall.dataDir, "settings.json");
  const originalSettings = readFileSync(settingsPath, "utf8");
  const workspace = realpathSync(mkdtempSync(join(runtime.freshInstall.dataDir, "location-migration-")));
  const source = join(workspace, "source");
  const destination = join(workspace, "destination");
  const occupied = join(workspace, "occupied");
  const filename = "fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
  const legacyFile = join(source, "fm-2023", filename);
  const organizedFile = join(destination, "fm-2023", "own", filename);
  mkdirSync(join(source, "fm-2023"), { recursive: true });
  mkdirSync(destination);
  mkdirSync(occupied);
  writeFileSync(join(occupied, "keep.txt"), "Do not overwrite");
  copyFileSync(resolve(__dirname, "../../../test/artifacts/sessions", filename), legacyFile);
  const originalCapture = readFileSync(legacyFile);
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(originalSettings), onboardingComplete: true, recordingDirectory: source }));

  try {
    const access = await request.get("/api/auth/status");
    expect(access.ok()).toBe(true);
    if ((await access.json() as { pending: boolean }).pending) {
      const setup = await request.post("/api/auth/setup", { data: { password: null, exposureConfirmed: true } });
      expect(setup.ok()).toBe(true);
    }
    const status = await request.get("/api/storage/layout-migration");
    expect(status.ok()).toBe(true);
    expect(await status.json()).toMatchObject({ directory: source, fileCount: 1, sessionCount: 0 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Organize recording files", exact: true })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Keep current folder/ })).toBeChecked();
    await expect(dialog.getByText(join(source, "<game>", "own"), { exact: true })).toBeVisible();
    await expect(dialog.getByText("1 files across 0 sessions", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Later", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(readFileSync(legacyFile)).toEqual(originalCapture);
    expect(existsSync(join(source, "fm-2023", "own", filename))).toBe(false);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(dialog.getByRole("heading", { name: "Organize recording files", exact: true })).toBeVisible();
    await dialog.getByRole("radio", { name: "Choose a new folder", exact: true }).check();
    await dialog.getByRole("textbox", { name: "Folder path", exact: true }).fill(occupied);
    const rejected = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/storage/layout-migration"));
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    expect((await rejected).ok()).toBe(false);
    await expect(dialog.getByRole("alert")).toContainText("Choose an empty destination folder.");
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("Do not overwrite");
    expect(readFileSync(legacyFile)).toEqual(originalCapture);

    await dialog.getByRole("textbox", { name: "Folder path", exact: true }).fill(destination);
    await expect(dialog.getByText(join(destination, "<game>", "own"), { exact: true })).toBeVisible();
    await expect(dialog.getByText(join(destination, "<game>", "others"), { exact: true })).toBeVisible();
    const accepted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/storage/layout-migration"));
    await dialog.getByRole("button", { name: "Retry organization", exact: true }).click();
    expect((await accepted).ok()).toBe(true);
    await expect(dialog.getByRole("heading", { name: "Recordings organized", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole("status")).toHaveText("Organized 1 files.");
    expect(readFileSync(organizedFile)).toEqual(originalCapture);
    expect(existsSync(legacyFile)).toBe(false);
    const settings = await request.get("/api/settings");
    expect(settings.ok()).toBe(true);
    expect(await settings.json()).toMatchObject({ recordingDirectory: destination, resolvedRecordingDirectory: destination });
    const finished = await request.get("/api/storage/layout-migration");
    expect(finished.ok()).toBe(true);
    expect(await finished.json()).toMatchObject({ directory: destination, fileCount: 0, progress: { status: "success", migrated: 1, failed: 0 } });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await page.close();
    writeFileSync(settingsPath, originalSettings);
    rmSync(workspace, { recursive: true, force: true });
  }
});
