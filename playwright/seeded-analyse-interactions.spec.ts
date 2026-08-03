import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "fs";
import { z } from "zod";

import type { LapMeta, SessionMeta } from "../shared/types";
import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import {
  collectBrowserErrors,
  getSeededLapTarget,
} from "./seeded-e2e-helpers";

async function gameRows<T>(
  request: APIRequestContext,
  resource: "laps" | "sessions",
  gameId = "fm-2023",
): Promise<T[]> {
  const response = await request.get(`/api/${resource}?gameId=${gameId}`);
  expect(response.ok(), `${resource} fixture response`).toBe(true);
  return response.json() as Promise<T[]>;
}

test("Analyse supports selection, playback, notes, export, import, and delete cancellation", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const initialLap = await getSeededLapTarget(request, "fm-2023");
  const alternateSeededLap = (await gameRows<LapMeta>(request, "laps")).find(
    (lap) =>
      lap.id !== initialLap.id &&
      lap.trackOrdinal === initialLap.trackOrdinal &&
      lap.carOrdinal === initialLap.carOrdinal,
  );
  if (!alternateSeededLap) throw new Error("Missing alternate seeded FM lap");
  const sessionsBefore = await gameRows<SessionMeta>(request, "sessions");
  const initialQuery = new URLSearchParams({
    track: String(initialLap.trackOrdinal),
    car: String(initialLap.carOrdinal),
    lap: String(initialLap.id),
  });

  await page.goto(`/fm23/analyse?${initialQuery}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({
    timeout: 30_000,
  });

  const lapSelector = page.getByRole("combobox", { name: "Search laps..." });
  const originalUrl = page.url();
  await lapSelector.click();
  const alternateLap = page
    .getByRole("option")
    .filter({
      hasText: new RegExp(
        `^Lap ${alternateSeededLap.lapNumber} – `,
      ),
    })
    .first();
  await expect(alternateLap).toBeVisible();
  await alternateLap.click();
  await expect.poll(() => page.url()).not.toBe(originalUrl);
  await expect(page.getByText(/Packet 1\/\d+/)).toBeVisible({ timeout: 30_000 });

  const selectedLapId = Number(new URL(page.url()).searchParams.get("lap"));
  expect(selectedLapId).toBeGreaterThan(0);
  const selectedLap = (await gameRows<LapMeta>(request, "laps")).find(
    (lap) => lap.id === selectedLapId,
  );
  if (!selectedLap) throw new Error(`Selected lap ${selectedLapId} not found`);
  const originalTuneId = selectedLap.tuneId ?? null;
  let tuneChanged = false;
  for (const placeholder of ["Search tracks...", "Search cars..."]) {
    const selector = page.getByRole("combobox", { name: placeholder });
    await selector.click();
    await expect(page.getByRole("option", { selected: true }).first()).toBeVisible();
    await selector.press("Escape");
  }
  const tuneSelector = page.getByRole("combobox", { name: "Tune:" });
  if (await tuneSelector.count()) {
    await tuneSelector.click();
    const tuneOptions = page.getByRole("option");
    if (await tuneOptions.count()) {
      const tuneSave = page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().endsWith(`/api/laps/${selectedLapId}/tune`),
      );
      await tuneOptions.first().click();
      expect((await tuneSave).ok()).toBe(true);
      tuneChanged = true;
      await expect(tuneSelector).toHaveValue(/.+/);
    } else {
      await tuneSelector.press("Escape");
    }
  }


  const slider = page.getByRole("slider", { name: "Lap timeline" });
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  for (const speed of [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5]) {
    const speedButton = page.getByRole("button", { name: `${speed}x`, exact: true });
    await speedButton.click();
    await expect(speedButton).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "2x", exact: true }).click();

  await page.getByTitle("Play (Space)").click();
  await expect
    .poll(() => slider.getAttribute("aria-valuenow"), { timeout: 10_000 })
    .not.toBe("0");
  await page.getByTitle("Pause (Space)").click();
  const beforeKeyboardStep = Number(await slider.getAttribute("aria-valuenow"));
  await slider.press("ArrowRight");
  await expect
    .poll(
      async () => Number(await slider.getAttribute("aria-valuenow")),
    )
    .toBeGreaterThan(beforeKeyboardStep);

  const chart = page.locator("canvas.cursor-crosshair").first();
  await expect(chart).toBeVisible();
  const beforeChartSeek = Number(await slider.getAttribute("aria-valuenow"));
  await chart.click({ position: { x: 120, y: 40 } });
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
    .not.toBe(beforeChartSeek);

  const insightsTab = page.getByRole("tab", { name: /Insights/ });
  await insightsTab.click();
  await expect(page.getByText("No issues detected").first()).toBeVisible();
  await page.getByRole("tab", { name: "Data", exact: true }).click();

  const followButton = page.getByRole("button", { name: "Fixed", exact: true });
  await followButton.click();
  await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
  for (const overlay of ["Inputs", "Segments", "Sectors", "Overlay"]) {
    await page.getByRole("button", { name: overlay, exact: true }).click();
    await expect(page.getByRole("button", { name: overlay, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Zoom in map" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("analyse-mapZoom")))
    .toBe("1.25");
  await page.getByRole("button", { name: "Zoom out map" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("analyse-mapZoom")))
    .toBe("1");

  await page.getByRole("tab", { name: "3D", exact: true }).click();
  await expect(page.getByRole("tab", { name: "3D", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "2D", exact: true }).click();

  await page.getByRole("button", { name: "Guide", exact: true }).click();
  const guideDialog = page.getByRole("dialog", { name: "Data Guide" });
  await expect(guideDialog).toBeVisible();
  await guideDialog.getByRole("button", { name: "Close" }).click();
  await expect(guideDialog).toHaveCount(0);

  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Configure AI to use this feature", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();


  const replacementNote = `analyse-e2e-note-${Date.now()}`;
  await page.getByRole("button", { name: /^(Add Notes|Notes)$/ }).click();
  const noteDialog = page.getByRole("dialog");
  await noteDialog.getByRole("textbox").fill(replacementNote);
  const noteSaveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/api/laps/${selectedLapId}/notes`),
  );
  await noteDialog.getByRole("button", { name: "Save" }).click();
  expect((await noteSaveResponse).ok()).toBe(true);

  const importedLapIds: number[] = [];
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Notes" })).toHaveAttribute(
      "title",
      replacementNote,
    );

    await page.getByRole("button", { name: "Export / Import" }).click();
    const csvDownloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export CSV" }).click();
    const csvDownload = await csvDownloadPromise;
    expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/);

    await page.getByRole("button", { name: "Export / Import" }).click();
    const binDownloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export .bin" }).click();
    const binDownload = await binDownloadPromise;
    const binPath = await binDownload.path();
    if (!binPath) throw new Error("Exported lap download has no local path");
    expect(binDownload.suggestedFilename()).toMatch(/\.bin(?:\.gz)?$/);

    await page.getByRole("button", { name: "Export / Import" }).click();
    await page.getByRole("menuitem", { name: "Import session (.bin or .ibt)" }).click();
    const importResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/laps/import"),
      { timeout: 120_000 },
    );
    await page.locator('input[type="file"][accept*=".bin"]').setInputFiles({
      name: binDownload.suggestedFilename(),
      mimeType: "application/octet-stream",
      buffer: readFileSync(binPath),
    });
    const importResponse = await importResponsePromise;
    expect(importResponse.ok()).toBe(true);
    const importPayload = z.object({
      laps: z.array(z.object({ lapId: z.number() })),
    }).parse(await importResponse.json());
    importedLapIds.push(...importPayload.laps.map(({ lapId }) => lapId));
    expect(importedLapIds.length).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "Import Complete" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    const disposableLap = (await gameRows<LapMeta>(request, "laps")).find((lap) =>
      importedLapIds.includes(lap.id),
    );
    if (!disposableLap) throw new Error("Imported disposable lap missing from list");
    await page.goto(
      `/fm23/analyse?track=${disposableLap.trackOrdinal}&car=${disposableLap.carOrdinal}&lap=${disposableLap.id}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({
      timeout: 30_000,
    });
    page.once("dialog", (dialog) => dialog.accept());
    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/api/laps/${disposableLap.id}`),
    );
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect((await deleteResponse).ok()).toBe(true);
    await expect
      .poll(async () => (await gameRows<LapMeta>(request, "laps")).some((lap) => lap.id === disposableLap.id))
      .toBe(false);
    importedLapIds.splice(importedLapIds.indexOf(disposableLap.id), 1);


    await page.goto(
      `/fm23/analyse?track=${selectedLap.trackOrdinal}&car=${selectedLap.carOrdinal}&lap=${selectedLapId}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({
      timeout: 30_000,
    });

    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();

    await page.getByRole("button", { name: "Notes" }).click();
    const restoreDialog = page.getByRole("dialog");
    await restoreDialog.getByRole("textbox").fill(selectedLap.notes ?? "");
    const restoreNoteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/laps/${selectedLapId}/notes`),
    );
    await restoreDialog.getByRole("button", { name: "Save" }).click();
    expect((await restoreNoteResponse).ok()).toBe(true);

    expect(browserErrors.errors, "unexpected browser errors in Analyse flow").toEqual([]);
  } finally {
    const restoreNote = await request.patch(`/api/laps/${selectedLapId}/notes`, {
      data: { notes: selectedLap.notes ?? null },
    });
    expect(restoreNote.ok(), `restore lap ${selectedLapId} note`).toBe(true);
    if (tuneChanged) {
      const restoreTune = await request.patch(`/api/laps/${selectedLapId}/tune`, {
        data: { tuneId: originalTuneId },
      });
      expect(restoreTune.ok(), `restore lap ${selectedLapId} tune`).toBe(true);
    }


    for (const lapId of importedLapIds) {
      const cleanupLap = await request.delete(`/api/laps/${lapId}`);
      expect(cleanupLap.ok(), `delete imported lap ${lapId}`).toBe(true);
    }

    const sessionIdsBefore = new Set(sessionsBefore.map((session) => session.id));
    const importedSessionIds = (await gameRows<SessionMeta>(request, "sessions"))
      .filter((session) => !sessionIdsBefore.has(session.id))
      .map((session) => session.id);
    if (importedSessionIds.length > 0) {
      const cleanupSessions = await request.post("/api/sessions/bulk-delete", {
        data: { ids: importedSessionIds },
      });
      expect(cleanupSessions.ok(), "delete imported sessions").toBe(true);
    }
  }
});
test("Analyse shared controls work across seeded game recordings", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const browserErrors = collectBrowserErrors(page);

  for (const game of SEEDED_GAME_CASES) {
    const target = await getSeededLapTarget(request, game.gameId);
    await page.goto(
      `/${game.prefix}/analyse?track=${target.trackOrdinal}&car=${target.carOrdinal}&lap=${target.id}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(
      page.getByRole("heading", { name: "Metrics at Cursor" }),
    ).toBeVisible({ timeout: 30_000 });
    for (const placeholder of ["Search tracks...", "Search cars..."]) {
      const selector = page.getByRole("combobox", { name: placeholder });
      await selector.click();
      await expect(page.getByRole("option", { selected: true }).first()).toBeVisible();
      await selector.press("Escape");
    }
    const tuneSelector = page.getByRole("combobox", { name: "Tune:" });
    if (await tuneSelector.count()) {
      await expect(tuneSelector).toBeVisible();
    }


    const insightsTab = page.getByRole("tab", { name: /Insights/ });
    await insightsTab.click();
    await expect(insightsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("No issues detected").first()).toBeVisible();
    await page.getByRole("tab", { name: "Data", exact: true }).click();

    for (const speed of [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5]) {
      const speedButton = page.getByRole("button", {
        name: `${speed}x`,
        exact: true,
      });
      await speedButton.click();
      await expect(speedButton).toHaveAttribute("aria-pressed", "true");
    }

    await page.getByRole("tab", { name: "3D", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "3D", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "2D", exact: true }).click();

    await page.getByRole("button", { name: "Guide", exact: true }).click();
    const guideDialog = page.getByRole("dialog", { name: "Data Guide" });
    await expect(guideDialog).toBeVisible();
    await guideDialog.getByRole("button", { name: "Close" }).click();

    if (game.gameId === "f1-2025" && target.telemetry[0]?.f1?.setup) {
      await page.getByRole("button", { name: "Car Setup", exact: true }).click();
      const setupDialog = page.getByRole("dialog", { name: "Car Setup" });
      await expect(setupDialog).toBeVisible();
      await expect(setupDialog.getByText("Aerodynamics", { exact: true })).toBeVisible();
      await setupDialog.getByRole("button", { name: "Close" }).click();
    }

    await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
    await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  }

  expect(
    browserErrors.errors,
    "unexpected browser errors in seeded Analyse matrix",
  ).toEqual([]);
});

test("Analyse exposes loading and parse-error states", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const browserErrors = collectBrowserErrors(page);
  const target = await getSeededLapTarget(request, "fm-2023");
  let releaseLoading!: () => void;
  const loadingGate = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await page.route(new RegExp(`/api/laps/${target.id}$`), async (route) => {
    await loadingGate;
    await route.continue();
  });
  await page.goto(
    `/fm23/analyse?track=${target.trackOrdinal}&car=${target.carOrdinal}&lap=${target.id}`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.getByText("Loading lap telemetry...", { exact: true })).toBeVisible();
  releaseLoading();
  await expect(
    page.getByRole("heading", { name: "Metrics at Cursor" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.unroute(new RegExp(`/api/laps/${target.id}$`));

  await page.route(new RegExp(`/api/laps/${target.id}$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        telemetry: [],
        parseError: "seeded-e2e parse failure",
      }),
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Failed to parse lap telemetry", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect(browserErrors.errors, "unexpected browser errors in Analyse states").toEqual([]);
});
test("Analyse renders seeded no-telemetry lap state when available", async ({
  page,
  request,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const rows = await gameRows<LapMeta>(request, "laps");
  let emptyLap: LapMeta | undefined;
  for (const row of rows.filter((candidate) => !candidate.isValid)) {
    const response = await request.get(`/api/laps/${row.id}`, {
      headers: { "X-Game-Id": "fm-2023" },
    });
    if (!response.ok()) continue;
    const payload = (await response.json()) as {
      telemetry?: unknown[];
      parseError?: string;
    };
    if (!payload.parseError && payload.telemetry?.length === 0) {
      emptyLap = row;
      break;
    }
  }
  test.skip(!emptyLap, "seed has no FM lap without telemetry");
  if (!emptyLap) return;
  await page.goto(
    `/fm23/analyse?track=${emptyLap.trackOrdinal}&car=${emptyLap.carOrdinal}&lap=${emptyLap.id}`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(
    page.getByText("No telemetry data for this lap.", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect(browserErrors.errors, "unexpected browser errors in no-telemetry state").toEqual([]);
});
