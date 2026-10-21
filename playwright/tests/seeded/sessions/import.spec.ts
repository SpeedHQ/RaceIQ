import { expect, test, type Locator } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { collectBrowserErrors } from "../../support/browser-errors";
import { cleanDisposable, importDisposableLap, lapsFor, sessionsFor, sessionRows, type DisposableImport } from "./helpers";

async function dropFiles(target: Locator, files: { name: string; bytes: number[] }[]) {
  const dataTransfer = await target.page().evaluateHandle((entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([new Uint8Array(entry.bytes)], entry.name));
    return transfer;
  }, files);
  try {
    await target.dispatchEvent("dragenter", { dataTransfer });
    await target.dispatchEvent("dragover", { dataTransfer });
    await target.dispatchEvent("drop", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

test("session importer handles dropped files, sidecars and busy states through production detection", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const source = (await lapsFor(request, "fm-2023")).find((lap) => lap.isValid && lap.telemetryAvailable);
  if (!source) throw new Error("A replayable seeded Forza lap is required");
  const exported = await request.get(`/api/laps/${source.id}/export-bin`);
  expect(exported.ok()).toBe(true);
  const recording = { name: "drag-recording.bin", bytes: Array.from(await exported.body()) };
  const importedIds = new Set<number>();
  const importFinished = Promise.withResolvers<void>();
  let importStarted = false;
  const detectionGate = Promise.withResolvers<void>();
  const importGate = Promise.withResolvers<void>();
  let detectionCount = 0;
  await page.route("**/api/laps/detect-import", async (route) => {
    detectionCount++;
    if (detectionCount !== 1) return route.continue();
    const response = await route.fetch();
    await detectionGate.promise;
    await route.fulfill({ response });
  });
  await page.route("**/api/laps/import", async (route) => {
    importStarted = true;
    try {
      const response = await route.fetch();
      if (response.ok()) {
        const data = z.object({ laps: z.array(z.object({ sessionId: z.number() })) }).parse(await response.json());
        for (const lap of data.laps) importedIds.add(lap.sessionId);
      }
      await importGate.promise;
      await route.fulfill({ response });
    } finally {
      importFinished.resolve();
    }
  });
  try {
    await page.goto("/fm23/sessions?tab=mine", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import session data" });
    const dropZone = dialog.getByRole("group", { name: "Import session data" });
    const choose = dialog.getByRole("button", { name: "Choose file", exact: true });
    const importButton = dialog.getByRole("button", { name: "Import", exact: true });
    const chooser = page.waitForEvent("filechooser");
    const firstDetection = page.waitForResponse("**/api/laps/detect-import");
    await choose.press("Enter");
    await (await chooser).setFiles({ name: recording.name, mimeType: "application/octet-stream", buffer: Buffer.from(recording.bytes) });
    await expect(dropZone).toHaveAttribute("aria-busy", "true");
    await expect(choose).toBeDisabled();
    await dropFiles(dropZone, [{ name: "ignored.bin", bytes: [0] }]);
    await expect(dropZone).toContainText(recording.name);
    expect(detectionCount).toBe(1);
    detectionGate.resolve();
    expect((await firstDetection).ok()).toBe(true);
    await expect(importButton).toBeEnabled();
    await dropFiles(dropZone, []);
    await dropFiles(dropZone, [{ name: "orphan.wal", bytes: [0] }]);
    await expect(dropZone).toContainText(recording.name);
    expect(detectionCount).toBe(1);

    const sidecarRequest = page.waitForRequest("**/api/laps/detect-import");
    const sidecarDetection = page.waitForResponse("**/api/laps/detect-import");
    await dropFiles(dropZone, [
      { name: "unrelated.wal", bytes: [1] },
      { name: "sample.duckdb.WAL", bytes: [2] },
      { name: "sample.duckdb", bytes: [3] },
    ]);
    const uploaded = await sidecarRequest;
    const multipart = await new Response(new Uint8Array(uploaded.postDataBuffer()!), { headers: { "content-type": uploaded.headers()["content-type"] } }).formData();
    const sidecar = multipart.get("wal");
    if (!sidecar || typeof sidecar === "string") throw new Error("Matching WAL sidecar was not uploaded");
    expect(sidecar.name).toBe("sample.duckdb.WAL");
    await sidecarDetection;
    await expect(dropZone).toContainText("sample.duckdb + sample.duckdb.WAL");
    await expect(importButton).toBeDisabled();

    const droppedDetection = page.waitForResponse("**/api/laps/detect-import");
    await dropFiles(dropZone, [recording]);
    expect((await droppedDetection).ok()).toBe(true);
    await expect(importButton).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("session-import-dropzone.png") });
    const imported = page.waitForResponse("**/api/laps/import");
    await importButton.click();
    await expect(dropZone).toHaveAttribute("aria-busy", "true");
    await dropFiles(dropZone, [{ name: "ignored-during-import.bin", bytes: [0] }]);
    await expect(dropZone).toContainText(recording.name);
    expect(detectionCount).toBe(3);
    importGate.resolve();
    expect((await imported).ok()).toBe(true);
    await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    expect([...importedIds], "one dropped recording must create exactly one session").toHaveLength(1);
  } finally {
    detectionGate.resolve();
    importGate.resolve();
    if (importStarted) await importFinished.promise;
    if (importedIds.size) {
      const cleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: [...importedIds] } });
      expect(cleanup.ok()).toBe(true);
    }
  }
});

test("session importer previews and confirms a dropped original IBT with selected ownership", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const original = resolve(__dirname, "../../../../test/artifacts/sessions/iracing-navarra-mx5-2026-10-19.ibt");
  let importedIds: number[] = [];
  try {
    await page.goto("/iracing/sessions?tab=mine", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import session data" });
    await dialog.getByRole("radio", { name: "Others", exact: true }).check();
    const detected = page.waitForResponse("**/api/laps/detect-import");
    const input = dialog.locator('input[type="file"]');
    await input.setInputFiles(original);
    expect((await detected).ok()).toBe(true);
    await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
    const dataTransfer = await input.evaluateHandle((element: HTMLInputElement) => {
      const transfer = new DataTransfer();
      if (!element.files?.[0]) throw new Error("Original IBT was not selected");
      transfer.items.add(element.files[0]);
      return transfer;
    });
    try {
      const dropped = page.waitForResponse("**/api/laps/detect-import");
      await dialog.getByRole("group", { name: "Import session data" }).dispatchEvent("drop", { dataTransfer });
      expect((await dropped).ok()).toBe(true);
    } finally {
      await dataTransfer.dispose();
    }
    const previewed = page.waitForResponse("**/api/laps/import-ibt/preview", { timeout: 60_000 });
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    expect((await previewed).ok()).toBe(true);
    const preview = page.getByRole("dialog");
    await expect(preview.getByText("Circuito de Navarra", { exact: true })).toBeVisible();
    await expect(preview.getByRole("radio", { name: "Others", exact: true })).toBeChecked();
    await expect(preview).toContainText("No BIN conversion");
    await page.screenshot({ path: testInfo.outputPath("session-original-ibt-preview.png") });
    const cancelled = page.waitForResponse("**/api/laps/import-ibt/cancel");
    await preview.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
    await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
    const previewedAgain = page.waitForResponse("**/api/laps/import-ibt/preview", { timeout: 60_000 });
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    expect((await previewedAgain).ok()).toBe(true);
    const committed = page.waitForResponse("**/api/laps/import-ibt/commit", { timeout: 60_000 });
    await page.getByRole("dialog").getByRole("button", { name: /^Import \d+ laps?$/ }).click();
    const response = await committed;
    expect(response.ok()).toBe(true);
    const imported = z.object({ laps: z.array(z.object({ sessionId: z.number(), lapId: z.number() })) }).parse(await response.json());
    importedIds = [...new Set(imported.laps.map((lap) => lap.sessionId))];
    const savedLaps = (await lapsFor(request, "iracing")).filter((lap) => importedIds.includes(lap.sessionId));
    expect(savedLaps.find((lap) => lap.lapNumber === 3)).toMatchObject({ ownership: "others", source: "ibt", rawFrameCount: 7507 });
    await expect(page.getByRole("dialog").getByRole("button", { name: "Done", exact: true })).toBeVisible();
  } finally {
    if (importedIds.length) {
      const cleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: importedIds } });
      expect(cleanup.ok()).toBe(true);
    }
  }
});
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


const MOTEC_FIXTURES = ["test/fixtures/motec.ld", "test/fixtures/motec.ldx", "test-data-seeded/motec/example.ld"] as const;
const motecLd = MOTEC_FIXTURES.find((path) => path.endsWith(".ld") && existsSync(path));
const motecLdx = MOTEC_FIXTURES.find((path) => path.endsWith(".ldx") && existsSync(path));
const motecZip = resolve(__dirname, "../../../../test/artifacts/motec/acc-barcelona-porsche-992.zip");

test("session importer sends a dropped MoTeC ZIP directly to configuration", async ({ page }) => {
  test.skip(!existsSync(motecZip), "No repository MoTeC ZIP fixture available");
  let stageRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/laps/stage-motec") {
      stageRequests++;
    }
  });

  await page.goto("/acc/sessions?tab=mine", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const staged = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/laps/stage-motec", { timeout: 30_000 });
  await dropFiles(page.getByRole("group", { name: "Import session data" }), [{ name: "motec-session.zip", bytes: Array.from(readFileSync(motecZip)) }]);
  expect((await staged).ok(), "MoTeC ZIP stages successfully").toBe(true);

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
  const cars = (await carsResponse.json()) as { id: string }[];
  const tracks = (await tracksResponse.json()) as { id: string }[];
  expect(cars.length).toBeGreaterThan(0);
  expect(tracks.length).toBeGreaterThan(0);
  const multipart: Parameters<typeof request.post>[1] = {
    multipart: {
      file: { name: "repository.ld", mimeType: "application/octet-stream", buffer: readFileSync(motecLd) },
      ...(motecLdx ? { ldx: { name: "repository.ldx", mimeType: "application/xml", buffer: readFileSync(motecLdx) } } : {}),
      gameId: "ac-evo",
      carId: cars[0].id,
      trackId: tracks[0].id,
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
