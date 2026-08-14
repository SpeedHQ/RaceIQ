import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

import { collectBrowserErrors } from "../../support/browser-errors";
import { cleanDisposable, importDisposableLap, lapsFor, sessionsFor, sessionRows, type DisposableImport } from "./helpers";
import { createRecording, drivenRows } from "../../../../test/support/games/iracing-ibt";

test("session lap context action rechecks disposable imported lap", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  let disposable: DisposableImport | undefined;
  try {
    disposable = await importDisposableLap(request, "fm-2023", "sessions-context");
    await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder("Search track, car, notes…");
    await search.fill(disposable.note);
    const row = (await sessionRows(page)).first();
    await expect(row).toBeVisible();
    await row.click();
    const lapRow = page
      .locator("tbody tbody tr")
      .filter({ has: page.getByRole("button", { name: "Analyse", exact: true }) })
      .first();
    await expect(lapRow).toBeVisible();
    await lapRow.click({ button: "right" });
    await expect(page.getByRole("button", { name: "Recheck validity", exact: true })).toBeVisible();
    const recheck = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/laps\/\d+\/recheck$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Recheck validity", exact: true }).click();
    const recheckResponse = await recheck;
    expect(recheckResponse.ok()).toBe(true);
    const result = (await recheckResponse.json()) as { id: number; valid: boolean };
    const persisted = (await lapsFor(request, "fm-2023")).find((lap) => lap.id === result.id);
    expect(persisted?.isValid).toBe(result.valid);
    expect(browserErrors.errors).toEqual([]);
  } finally {
    await cleanDisposable(request, disposable);
  }
});

test("Sessions previews and imports iRacing IBT recordings", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const recording = createRecording("sessions-import.ibt", drivenRows(), {
    trackId: 18,
    trackName: "Road America",
    carId: 1,
    carName: "Skip Barber Formula 2000",
  });
  const lapsBefore = new Set((await lapsFor(request, "iracing")).map((lap) => lap.id));
  let disposable: DisposableImport | undefined;
  try {
    await page.goto("/iracing/sessions", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const importDialog = page.getByRole("dialog");
    await importDialog.locator('input[type="file"][accept*=".ibt"]').setInputFiles(recording.path);
    await expect(importDialog.getByText("Detected:")).toBeVisible();
    await expect(importDialog.getByText("iRacing telemetry (.ibt)", { exact: true })).toBeVisible();
    await importDialog.getByRole("button", { name: "Preview", exact: true }).click();

    const previewDialog = page.getByRole("dialog");
    await expect(previewDialog.getByText("iRacing IBT import preview", { exact: true })).toBeVisible();
    await expect(previewDialog.getByText("Road America", { exact: true })).toBeVisible();
    await expect(previewDialog.getByText("Skip Barber Formula 2000", { exact: false })).toBeVisible();
    const commitResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/laps/import-ibt/commit"));
    await previewDialog.getByRole("button", { name: "Import 1 lap", exact: true }).click();
    expect((await commitResponse).ok()).toBe(true);

    await expect(page.getByText("Imported 1 lap.", { exact: true })).toBeVisible();
    const importedLaps = (await lapsFor(request, "iracing")).filter((lap) => !lapsBefore.has(lap.id) && lap.trackOrdinal === 18 && lap.carOrdinal === 1);
    disposable = {
      lapIds: importedLaps.map((lap) => lap.id),
      sessionIds: [...new Set(importedLaps.map((lap) => lap.sessionId))],
      note: "",
    };
    expect(disposable.lapIds).toHaveLength(1);
    expect(disposable.sessionIds).toHaveLength(1);
    expect(browserErrors.errors).toEqual([]);
  } finally {
    await page.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 1_000 }).catch(() => undefined);
    if (!disposable) {
      const importedLaps = (await lapsFor(request, "iracing")).filter((lap) => !lapsBefore.has(lap.id) && lap.trackOrdinal === 18 && lap.carOrdinal === 1);
      disposable = importedLaps.length > 0
        ? {
            lapIds: importedLaps.map((lap) => lap.id),
            sessionIds: [...new Set(importedLaps.map((lap) => lap.sessionId))],
            note: "",
          }
        : undefined;
    }
    await cleanDisposable(request, disposable, "iracing");
    recording.cleanup();
  }
});

const MOTEC_FIXTURES = ["test/fixtures/motec.ld", "test/fixtures/motec.ldx", "test-data-seeded/motec/example.ld"] as const;
const motecLd = MOTEC_FIXTURES.find((path) => path.endsWith(".ld") && existsSync(path));
const motecLdx = MOTEC_FIXTURES.find((path) => path.endsWith(".ldx") && existsSync(path));

test("MoTeC import fixture creates disposable imported session when repository evidence exists", async ({ page, request }) => {
  test.skip(!motecLd, "No repository MoTeC .ld fixture available");
  if (!motecLd) return;
  const browserErrors = collectBrowserErrors(page);
  const sessionsBefore = await sessionsFor(request, "ac-evo");
  const carsResponse = await request.get("/api/ac-evo/cars");
  const tracksResponse = await request.get("/api/tracks?gameId=ac-evo");
  expect(carsResponse.ok()).toBe(true);
  expect(tracksResponse.ok()).toBe(true);
  const cars = (await carsResponse.json()) as { ordinal: number }[];
  const tracks = (await tracksResponse.json()) as { ordinal: number }[];
  expect(cars.length).toBeGreaterThan(0);
  expect(tracks.length).toBeGreaterThan(0);
  const multipart: Parameters<typeof request.post>[1] = {
    multipart: {
      file: { name: "repository.ld", mimeType: "application/octet-stream", buffer: readFileSync(motecLd) },
      ...(motecLdx ? { ldx: { name: "repository.ldx", mimeType: "application/xml", buffer: readFileSync(motecLdx) } } : {}),
      gameId: "ac-evo",
      carOrdinal: String(cars[0].ordinal),
      trackOrdinal: String(tracks[0].ordinal),
    },
  };
  let importedLapIds: number[] = [];
  let importedSessionIds: number[] = [];
  try {
    const importedResponse = await request.post("/api/laps/import-motec", multipart);
    expect(importedResponse.ok()).toBe(true);
    const imported = (await importedResponse.json()) as { laps?: { lapId: number }[] };
    importedLapIds = imported.laps?.map((lap) => lap.lapId) ?? [];
    expect(importedLapIds.length).toBeGreaterThan(0);
    const sessionsAfter = await sessionsFor(request, "ac-evo");
    const beforeIds = new Set(sessionsBefore.map((session) => session.id));
    importedSessionIds = sessionsAfter.filter((session) => !beforeIds.has(session.id)).map((session) => session.id);
    expect(importedSessionIds.length).toBeGreaterThan(0);
    await page.goto("/ac-evo/sessions?tab=imported", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("MoTeC", { exact: true }).last()).toBeVisible();
    expect(browserErrors.errors).toEqual([]);
  } finally {
    const lapCleanup = await request.post("/api/laps/bulk-delete", { data: { ids: importedLapIds } });
    expect(lapCleanup.ok()).toBe(true);
    const sessionCleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: importedSessionIds } });
    expect(sessionCleanup.ok()).toBe(true);
    const finalSessions = await sessionsFor(request, "ac-evo");
    const finalLaps = await lapsFor(request, "ac-evo");
    for (const id of importedSessionIds) expect(finalSessions.some((session) => session.id === id)).toBe(false);
    for (const id of importedLapIds) expect(finalLaps.some((lap) => lap.id === id)).toBe(false);
  }
});
