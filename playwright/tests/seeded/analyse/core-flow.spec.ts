import { expect, test } from "@playwright/test";

import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { assertLapSelectors, exercise3dGuide, exerciseAiSetup, exerciseDynamicsTooltip, exerciseInsightsAndMap, exercisePlaybackControls } from "./controls";
import { gameRows, getAlternateSeededLap, openAnalyseLap } from "./fixtures";

test("Analyse supports selection, playback, and notes", async ({ page, request }) => {
  test.setTimeout(200_000);
  const browserErrors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__recording = true;
  });
  const initialLap = await getSeededLapTarget(request, "fm-2023");
  const alternateSeededLap = await getAlternateSeededLap(request, initialLap);

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
  const semanticResponse = await request.get(`/api/laps/${selectedLapId}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
  expect(semanticResponse.ok(), "selected lap semantic replay response").toBe(true);
  const semanticReplay = (await semanticResponse.json()) as {
    envelopes: Array<{ values: Array<{ semanticId: string; value: unknown }> }>;
  };
  const semanticFrames = semanticReplay.envelopes.map((envelope) => ({
    values: Object.fromEntries(envelope.values.map(({ semanticId, value }) => [semanticId, value])),
  }));
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

  await exerciseDynamicsTooltip(page, semanticFrames);
  await exercisePlaybackControls(page, semanticFrames);
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


  await page.getByRole("button", { name: "Notes" }).click();
  const restoreDialog = page.getByRole("dialog");
  await restoreDialog.getByRole("textbox").fill(selectedLap.notes ?? "");
  const restoreNoteResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/laps/${selectedLapId}/notes`));
  await restoreDialog.getByRole("button", { name: "Save" }).click();
  expect((await restoreNoteResponse).ok()).toBe(true);
  expect(browserErrors.errors, "unexpected browser errors in Analyse flow").toEqual([]);

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
});
