import { expect, test } from "@playwright/test";

import type { LapMeta, SessionMeta } from "../../../../shared/racing/sessions/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { assertLapSelectors, exercise3dGuide, exerciseAiSetup, exerciseInsightsAndMap, exercisePlaybackControls } from "./controls";
import { gameRows, getAlternateSeededLap, openAnalyseLap } from "./fixtures";
import { exportImportAndDelete } from "./lifecycle";

test("Analyse supports selection, playback, notes, export, import, and delete cancellation", async ({ page, request }) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const initialLap = await getSeededLapTarget(request, "fm-2023");
  const alternateSeededLap = await getAlternateSeededLap(request, initialLap);
  const sessionsBefore = await gameRows<SessionMeta>(request, "sessions");

  await openAnalyseLap(page, initialLap);
  const lapSelector = page.getByRole("combobox", { name: "Search laps..." });
  const originalUrl = page.url();
  await lapSelector.click();
  const alternateLap = page
    .getByRole("option")
    .filter({ hasText: new RegExp(`^Lap ${alternateSeededLap.lapNumber} – `) })
    .first();
  await expect(alternateLap).toBeVisible();
  await alternateLap.click();
  await expect.poll(() => page.url()).not.toBe(originalUrl);
  await expect(page.getByText(/Packet 1\/\d+/)).toBeVisible({ timeout: 30_000 });

  const selectedLapId = Number(new URL(page.url()).searchParams.get("lap"));
  expect(selectedLapId).toBeGreaterThan(0);
  const selectedLap = (await gameRows<LapMeta>(request, "laps")).find((lap) => lap.id === selectedLapId);
  if (!selectedLap) throw new Error(`Selected lap ${selectedLapId} not found`);
  const originalTuneId = selectedLap.tuneId ?? null;
  let tuneChanged = false;
  await assertLapSelectors(page, selectedLap.lapNumber);
  const tuneSelector = page.getByRole("combobox", { name: "Tune:" });
  if (await tuneSelector.count()) {
    await tuneSelector.click();
    const tuneOptions = page.getByRole("option");
    if (await tuneOptions.count()) {
      const tuneSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/laps/${selectedLapId}/tune`));
      await tuneOptions.first().click();
      expect((await tuneSave).ok()).toBe(true);
      tuneChanged = true;
      await expect(tuneSelector).toHaveValue(/.+/);
    } else {
      await tuneSelector.press("Escape");
    }
  }

  await exercisePlaybackControls(page);
  await exerciseInsightsAndMap(page);
  await exercise3dGuide(page);
  await exerciseAiSetup(page);

  const replacementNote = `analyse-e2e-note-${Date.now()}`;
  await page.getByRole("button", { name: /^(Add Notes|Notes)$/ }).click();
  const noteDialog = page.getByRole("dialog");
  await noteDialog.getByRole("textbox").fill(replacementNote);
  const noteSaveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/laps/${selectedLapId}/notes`));
  await noteDialog.getByRole("button", { name: "Save" }).click();
  expect((await noteSaveResponse).ok()).toBe(true);

  const importedLapIds: number[] = [];
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Notes" })).toHaveAttribute("title", replacementNote);
    await exportImportAndDelete(page, request, selectedLap, selectedLapId, importedLapIds);

    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();

    await page.getByRole("button", { name: "Notes" }).click();
    const restoreDialog = page.getByRole("dialog");
    await restoreDialog.getByRole("textbox").fill(selectedLap.notes ?? "");
    const restoreNoteResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/laps/${selectedLapId}/notes`));
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
    const importedSessionIds = (await gameRows<SessionMeta>(request, "sessions")).filter((session) => !sessionIdsBefore.has(session.id)).map((session) => session.id);
    if (importedSessionIds.length > 0) {
      const cleanupSessions = await request.post("/api/sessions/bulk-delete", {
        data: { ids: importedSessionIds },
      });
      expect(cleanupSessions.ok(), "delete imported sessions").toBe(true);
    }
  }
});
