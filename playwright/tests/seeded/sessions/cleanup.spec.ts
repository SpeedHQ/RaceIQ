import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { SessionCleanupPreview, SessionCleanupResult } from "@raceiq/shared/racing/sessions/cleanup";
import { runtime } from "../../../config/runtime";
import { collectBrowserErrors } from "../../support/browser-errors";
import { cleanDisposable, importDisposableLap, lapsFor, sessionRows, sessionsFor, type DisposableImport } from "./helpers";

function captureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? captureFiles(path) : entry.isFile() ? [path] : [];
  });
}

test("confirmed cleanup removes disposable capture while preserving session and laps", async ({ page, request }) => {
  test.setTimeout(90_000);
  const browserErrors = collectBrowserErrors(page);
  const capturesDir = join(runtime.seeded.dataDir, "sessions", "fm-2023", "own");
  const capturesBefore = new Set(captureFiles(capturesDir));
  let disposable: DisposableImport | undefined;
  try {
    disposable = await importDisposableLap(request, "fm-2023", "sessions-cleanup");
    const sessionIds = disposable.sessionIds;
    const lapIds = disposable.lapIds;
    // Import now publishes per-lap files and a manifest as well as the retained
    // source. Wait for that publication before taking an independent disk count.
    await expect.poll(async () => {
      const owned = (await sessionsFor(request, "fm-2023")).filter((session) => sessionIds.includes(session.id));
      return owned.length === sessionIds.length && owned.every((session) => session.captureSplit?.phase === "ready");
    }, { timeout: 60_000 }).toBe(true);
    const captures = captureFiles(capturesDir).filter((path) => !capturesBefore.has(path));
    expect(captures.length, "import creates disposable capture files").toBeGreaterThan(0);
    const bytes = captures.reduce((total, path) => total + statSync(path).size, 0);
    expect(bytes).toBeGreaterThan(0);

    const sessionsBefore = (await sessionsFor(request, "fm-2023")).filter((session) => sessionIds.includes(session.id));
    const lapsBefore = (await lapsFor(request, "fm-2023")).filter((lap) => lapIds.includes(lap.id));
    expect(sessionsBefore).toHaveLength(sessionIds.length);
    expect(lapsBefore).toHaveLength(lapIds.length);
    expect(lapsBefore.every((lap) => lap.telemetryAvailable)).toBe(true);

    await page.goto("/fm23/sessions?tab=mine", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search track, car, notes…").fill(disposable.note);
    const rows = sessionRows(page);
    await expect(rows).toHaveCount(sessionIds.length);
    for (const row of await rows.all()) await row.getByRole("checkbox").check();

    const previewResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/storage/session-cleanup/preview");
    await page.getByRole("button", { name: "Free space", exact: true }).click();
    const previewHttp = await previewResponse;
    expect(previewHttp.ok()).toBe(true);
    const preview = (await previewHttp.json()) as SessionCleanupPreview;
    expect(new Set(preview.candidateSessionIds)).toEqual(new Set(sessionIds));
    expect(preview.fileCount).toBe(captures.length);
    expect(preview.reclaimableBytes).toBe(bytes);
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(captures.every(existsSync), "preview must not delete captures").toBe(true);

    const cleanupResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/storage/session-cleanup");
    await page.getByRole("button", { name: "Remove raw telemetry", exact: true }).click();
    const cleanupHttp = await cleanupResponse;
    expect(cleanupHttp.ok()).toBe(true);
    const result = (await cleanupHttp.json()) as SessionCleanupResult;
    expect(new Set(result.cleanedSessionIds)).toEqual(new Set(sessionIds));
    expect(result.deletedFiles).toBe(captures.length);
    expect(result.freedBytes).toBe(bytes);
    expect(result.failed).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(captures.some(existsSync), "cleanup deletes disposable captures").toBe(false);
    expect([...capturesBefore].every(existsSync), "seeded captures stay untouched").toBe(true);

    const sessionsAfter = (await sessionsFor(request, "fm-2023")).filter((session) => sessionIds.includes(session.id));
    const lapsAfter = (await lapsFor(request, "fm-2023")).filter((lap) => lapIds.includes(lap.id));
    expect(sessionsAfter).toEqual(sessionsBefore.map((session) => {
      // This source-derived span is unavailable without the recording. Stored
      // session metadata and lap timing must still match their original values.
      const cleaned = { ...session, telemetryAvailable: false, elapsedSeconds: null };
      delete cleaned.captureSplit;
      return cleaned;
    }));
    expect(lapsAfter).toEqual(lapsBefore.map((lap) => ({ ...lap, telemetryAvailable: false, standaloneCaptureReady: false })));
    expect(browserErrors.errors).toEqual([]);
  } finally {
    await cleanDisposable(request, disposable);
  }
});

for (const favorite of ["session", "lap"] as const) {
  test(`favorited ${favorite} protects capture in real cleanup`, async ({ page, request }) => {
    const capturesDir = join(runtime.seeded.dataDir, "sessions", "fm-2023", "own");
    const capturesBefore = new Set(readdirSync(capturesDir).filter((name) => name.endsWith(".bin") || name.endsWith(".bin.gz")));
    let disposable: DisposableImport | undefined;
    try {
      disposable = await importDisposableLap(request, "fm-2023", `favorite-${favorite}`);
      expect(disposable.sessionIds).toHaveLength(1);
      const sessionId = disposable.sessionIds[0];
      const capturePaths = readdirSync(capturesDir).filter((name) => (name.endsWith(".bin") || name.endsWith(".bin.gz")) && !capturesBefore.has(name)).map((name) => join(capturesDir, name));
      expect(capturePaths.length).toBeGreaterThan(0);
      const favoriteId = favorite === "session" ? sessionId : disposable.lapIds[0];
      const update = await request.patch(`/api/${favorite === "session" ? "sessions" : "laps"}/${favoriteId}/favorite`, { data: { favorite: true } });
      expect(update.ok()).toBe(true);

      await page.goto("/fm23/sessions?tab=mine", { waitUntil: "domcontentloaded" });
      await page.getByPlaceholder("Search track, car, notes…").fill(disposable.note);
      const row = sessionRows(page);
      await expect(row).toHaveCount(1);
      await row.getByRole("checkbox").check();
      const previewResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/storage/session-cleanup/preview");
      await page.getByRole("button", { name: "Free space", exact: true }).click();
      const previewHttp = await previewResponse;
      expect(previewHttp.ok()).toBe(true);
      const preview = (await previewHttp.json()) as SessionCleanupPreview;
      expect(preview.protectedSessionIds).toContain(sessionId);
      expect(preview.candidateSessionIds).toEqual([]);
      await expect(page.getByRole("dialog").getByRole("button", { name: "Remove raw telemetry", exact: true })).toBeDisabled();

      const cleanupHttp = await request.post("/api/storage/session-cleanup", { data: { mode: "selected", sessionIds: [sessionId] } });
      expect(cleanupHttp.ok()).toBe(true);
      const result = (await cleanupHttp.json()) as SessionCleanupResult;
      expect(result.protectedSessionIds).toContain(sessionId);
      expect(result.cleanedSessionIds).toEqual([]);
      expect(result.deletedFiles).toBe(0);
      expect(capturePaths.every(existsSync), "favorited capture remains on disk").toBe(true);
      expect((await sessionsFor(request, "fm-2023")).some((session) => session.id === sessionId)).toBe(true);
      expect((await lapsFor(request, "fm-2023")).filter((lap) => disposable!.lapIds.includes(lap.id)).every((lap) => lap.telemetryAvailable)).toBe(true);
    } finally {
      await cleanDisposable(request, disposable);
    }
  });
}

test("selected-session cleanup previews protection and waits for confirmation", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  let executeCalls = 0;
  await page.route("**/api/storage/session-cleanup/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateSessionIds: [1],
        protectedSessionIds: [2],
        unavailableSessionIds: [],
        fileCount: 1,
        reclaimableBytes: 4096,
        games: [],
      }),
    });
  });
  await page.route("**/api/storage/session-cleanup", async (route) => {
    executeCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateSessionIds: [1],
        protectedSessionIds: [2],
        unavailableSessionIds: [],
        fileCount: 1,
        reclaimableBytes: 4096,
        games: [],
        cleanedSessionIds: [1],
        deletedFiles: 1,
        freedBytes: 4096,
        failed: [],
      }),
    });
  });

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const first = sessionRows(page).first();
  await first.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Free space", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Removes .bin recording files to free disk space. Session and lap details remain, and favorite sessions and laps are protected.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Protected sessions", { exact: true })).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Remove raw telemetry", exact: true });
  await expect(confirm).toBeEnabled();
  expect(executeCalls).toBe(0);
  await confirm.click();
  await expect.poll(() => executeCalls).toBe(1);
  expect(browserErrors.errors).toEqual([]);
});

test("missing capture can be cleaned when no file bytes remain", async ({ page }) => {
  let executeCalls = 0;
  await page.route("**/api/storage/session-cleanup/preview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateSessionIds: [1],
        protectedSessionIds: [],
        unavailableSessionIds: [],
        fileCount: 0,
        reclaimableBytes: 0,
        games: [],
      }),
    });
  });
  await page.route("**/api/storage/session-cleanup", async (route) => {
    executeCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidateSessionIds: [1],
        protectedSessionIds: [],
        unavailableSessionIds: [],
        fileCount: 0,
        reclaimableBytes: 0,
        games: [],
        cleanedSessionIds: [1],
        deletedFiles: 0,
        freedBytes: 0,
        failed: [],
      }),
    });
  });

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await sessionRows(page).first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Free space", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Remove raw telemetry", exact: true });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => executeCalls).toBe(1);
});
