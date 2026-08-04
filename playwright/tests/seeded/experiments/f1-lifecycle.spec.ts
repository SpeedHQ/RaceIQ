import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { ExperimentSchema, ImportLapsResponseSchema } from "./schemas";

test("F1 experiment creates, switches focus, imports laps, uses history, and archives", async ({ page, request }) => {
  page.setDefaultTimeout(10_000);
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const seededLap = await getSeededLapTarget(request, "f1-2025");
  const trackResponse = await request.get(`/api/track-name/${seededLap.trackOrdinal}?gameId=f1-2025`);
  const carResponse = await request.get(`/api/car-name/${seededLap.carOrdinal}?gameId=f1-2025`);
  expect(trackResponse.ok()).toBe(true);
  expect(carResponse.ok()).toBe(true);
  const trackName = await trackResponse.text();
  const carName = await carResponse.text();
  let pendingUndoCount = 0;
  const experimentName = `Seeded F1 experiment ${Date.now()}`;
  let experimentId: number | null = null;

  try {
    await page.goto("/f125/experiments", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();
    await page.getByRole("button", { name: "+ New experiment" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByRole("heading", { name: "New experiment" })).toBeVisible();
    await createDialog.getByRole("button", { name: /^Driver / }).click();
    await createDialog.getByPlaceholder("Car name").fill(carName);
    await createDialog.getByRole("combobox", { name: "Search tracks…" }).click();
    await page.getByRole("option", { name: trackName, exact: true }).click();
    await createDialog.getByPlaceholder(new RegExp(`${carName} @ `)).fill(experimentName);
    const createResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/experiments");
    await createDialog.getByRole("button", { name: "Create session" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    experimentId = ExperimentSchema.parse(await createResponse.json()).id;

    await expect(page).toHaveURL(new RegExp(`/f125/experiments/${experimentId}$`));
    await expect(page.getByRole("heading", { name: new RegExp(experimentName) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Driver", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Car", exact: true }).click();
    await page.getByPlaceholder("Why the switch? (optional)").fill("Seeded focus transition");
    const focusResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/api\/experiments\/\d+\/focus$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Switch", exact: true }).click();
    expect((await focusResponse).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Car", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Add laps from history" }).click();
    const importDialog = page.getByRole("dialog");
    await expect(importDialog.getByText(/Importable laps \([1-9]\d*\)/)).toBeVisible();
    await importDialog.getByRole("button", { name: "Select all" }).click();
    const importResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/experiments\/\d+\/import-laps$/.test(new URL(response.url()).pathname));
    await importDialog.getByRole("button", { name: /Import \d+ laps?/ }).click();
    const importApiResponse = await importResponse;
    expect(importApiResponse.ok()).toBe(true);
    const imported = ImportLapsResponseSchema.parse(await importApiResponse.json());
    expect(imported.importedIds.length).toBeGreaterThan(0);
    pendingUndoCount += 1;
    await expect(page.getByText("Laps", { exact: true }).locator("..")).toContainText(`Laps${imported.importedIds.length}`);

    await page.getByRole("button", { name: "History", exact: true }).click();
    const historyDialog = page.getByRole("dialog");
    await expect(historyDialog.getByText("Imported laps", { exact: true })).toBeVisible();
    const undoImport = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/experiments\/\d+\/undo$/.test(new URL(response.url()).pathname));
    await historyDialog.getByRole("button", { name: "Undo last" }).click();
    expect((await undoImport).ok()).toBe(true);
    pendingUndoCount -= 1;
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "History", exact: true }).click();
    const focusHistory = page.getByRole("dialog");
    await expect(focusHistory.getByText("Nothing left to undo.", { exact: true })).toBeVisible();
    await expect(focusHistory.getByText("Driver", { exact: true })).toBeVisible();
    await expect(focusHistory.getByText("Car", { exact: true })).toBeVisible();
    await expect(focusHistory.getByText(/Seeded focus transition/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Car", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await expect(page.getByText("Current stint", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
  } finally {
    while (pendingUndoCount > 0 && experimentId != null) {
      const undo = await request.post(`/api/experiments/${experimentId}/undo`);
      expect(undo.ok(), `undo pending action for experiment ${experimentId}`).toBe(true);
      pendingUndoCount -= 1;
    }
    if (experimentId != null) {
      const archive = await request.patch(`/api/experiments/${experimentId}`, {
        data: { status: "archived" },
      });
      expect(archive.ok(), `archive experiment ${experimentId}`).toBe(true);
    }
  }

  expect(browserErrors.errors, "unexpected browser errors in experiment flow").toEqual([]);
});
