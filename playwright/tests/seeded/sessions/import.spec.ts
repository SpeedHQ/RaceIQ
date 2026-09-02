import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { collectBrowserErrors } from "../../support/browser-errors";
import { cleanDisposable, importDisposableLap, lapsFor, sessionsFor, sessionRows, type DisposableImport } from "./helpers";

test("session lap context action rechecks disposable imported lap", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  let disposable: DisposableImport | undefined;
  try {
    disposable = await importDisposableLap(request, "fm-2023", "sessions-context");
    await page.goto("/fm23/sessions?tab=mine", { waitUntil: "domcontentloaded" });
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

const MOTEC_FIXTURES = ["test/fixtures/motec.ld", "test/fixtures/motec.ldx", "test-data-seeded/motec/example.ld"] as const;
const motecLd = MOTEC_FIXTURES.find((path) => path.endsWith(".ld") && existsSync(path));
const motecLdx = MOTEC_FIXTURES.find((path) => path.endsWith(".ldx") && existsSync(path));
const motecZip = resolve(__dirname, "../../../../test/artifacts/motec/acc-barcelona-porsche-992.zip");

test("session importer sends a MoTeC ZIP directly to configuration", async ({ page }) => {
  test.skip(!existsSync(motecZip), "No repository MoTeC ZIP fixture available");
  let stageRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/laps/stage-motec") {
      stageRequests++;
    }
  });

  await page.goto("/acc/sessions?tab=mine", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(motecZip);

  await expect(page.getByRole("heading", { name: "Import MoTeC log" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("acc-barcelona-porsche-992.zip", { exact: true })).toBeVisible();
  await expect(page.getByText("Barcelona-porsche_992_gt3_r-4-2024.12.06-14.54.26.ld", { exact: true })).toBeVisible();
  await expect(page.getByText("Barcelona-porsche_992_gt3_r-4-2024.12.06-14.54.26.ldx", { exact: true })).toBeVisible();
  expect(stageRequests).toBe(1);
});

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
