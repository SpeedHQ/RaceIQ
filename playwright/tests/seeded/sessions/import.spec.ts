import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { collectBrowserErrors } from "../../support/browser-errors";
import { cleanDisposable, importDisposableLap, lapsFor, sessionsFor, sessionRows, type DisposableImport } from "./helpers";
import type { GameId } from "../../../../shared/games/ids";

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
      .filter({ has: page.getByRole("button", { name: "Replay", exact: true }) })
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

test("imports all six games raw, then requires Convert and preserves Analyse replay", async ({ page, request }) => {
  test.setTimeout(300_000);
  const fixtures: ReadonlyArray<{ gameId: GameId; file: string }> = [
    { gameId: "fm-2023", file: "fm-2023-2026-04-09T21-55-03-186Z.bin.gz" },
    { gameId: "f1-2025", file: "f1-2025-2026-04-22T11-42-43-029Z.bin.gz" },
    { gameId: "acc", file: "acc-2026-04-23T16-42-16-158Z.bin.gz" },
    { gameId: "ac-evo", file: "session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz" },
    { gameId: "iracing", file: "iracing-road-america-gt3.bin.gz" },
    { gameId: "lmu", file: "lmu-spa-iron-lynx-gte.bin.gz" },
  ];
  const importedLapIds: number[] = [];
  const importedSessionIds: number[] = [];
  const replays: Array<{ gameId: GameId; lapId: number; before: unknown }> = [];
  try {
    for (const { gameId, file } of fixtures) {
      const sessionsBefore = await sessionsFor(request, gameId);
      const upload = await request.post("/api/laps/import", {
        multipart: {
          file: { name: file, mimeType: "application/octet-stream", buffer: readFileSync(resolve(__dirname, "../../../../test/artifacts/sessions", file)) },
          ownership: "mine",
          captureStorage: "raw",
        },
      });
      expect(upload.ok(), `${gameId} raw API import`).toBe(true);
      const imported = (await upload.json()) as { gameId: GameId; laps: Array<{ lapId: number; isValid: boolean }> };
      expect(imported.gameId).toBe(gameId);
      importedLapIds.push(...imported.laps.map(({ lapId }) => lapId));
      const lapId = imported.laps.find(({ isValid }) => isValid)?.lapId;
      expect(lapId, `${gameId} valid lap`).toBeDefined();
      const beforeIds = new Set(sessionsBefore.map(({ id }) => id));
      const newSessionIds = (await sessionsFor(request, gameId))
        .filter(({ id }) => !beforeIds.has(id)).map(({ id }) => id);
      expect(newSessionIds.length, `${gameId} raw sessions`).toBeGreaterThan(0);
      importedSessionIds.push(...newSessionIds);
      const replay = await request.get(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": gameId } });
      expect(replay.ok(), `${gameId} replay before conversion`).toBe(true);
      replays.push({ gameId, lapId: lapId!, before: await replay.json() });
    }

    const status = await request.get("/api/sessions/capture-migration-status");
    expect(status.ok()).toBe(true);
    expect((await status.json() as { sessionCount: number }).sessionCount).toBeGreaterThanOrEqual(importedSessionIds.length);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "Save space in older recordings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Not now" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const migrationResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/sessions/migrate-captures"), { timeout: 180_000 });
    await dialog.getByRole("button", { name: "Convert", exact: true }).click();
    const migrated = await migrationResponse;
    expect(migrated.ok()).toBe(true);
    const migration = await migrated.json() as { migrated: number; unchanged: number; failed: number; results: Array<{ rawFile: string; status: "migrated" | "unchanged" | "error" }> };
    expect(migration.failed).toBe(0);
    expect(migration.migrated + migration.unchanged).toBeGreaterThanOrEqual(fixtures.length);
    for (const result of migration.results) {
      expect(existsSync(result.rawFile)).toBe(result.status === "unchanged");
    }
    const remaining = await request.get("/api/sessions/capture-migration-status");
    expect(remaining.ok()).toBe(true);
    expect((await remaining.json() as { captureCount: number }).captureCount).toBe(0);
    await expect(dialog).toBeHidden();
    for (const { gameId, lapId, before } of replays) {
      const after = await request.get(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": gameId } });
      expect(after.ok(), `${gameId} replay after conversion`).toBe(true);
      expect(await after.json()).toEqual(before);
    }
  } finally {
    if (importedLapIds.length) {
      expect((await request.post("/api/laps/bulk-delete", { data: { ids: importedLapIds } })).ok()).toBe(true);
    }
    if (importedSessionIds.length) {
      expect((await request.post("/api/sessions/bulk-delete", { data: { ids: importedSessionIds } })).ok()).toBe(true);
    }
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
