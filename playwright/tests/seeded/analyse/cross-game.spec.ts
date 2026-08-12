import { expect, test, type Page } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { exerciseCrossGameControls } from "./controls";
import { openAnalyseLap } from "./fixtures";

async function expectOverlaySequence(page: Page, labels: readonly string[]): Promise<void> {
  for (let index = 0; index < labels.length - 1; index++) {
    await page.getByRole("button", { name: labels[index], exact: true }).click();
    await expect(page.getByRole("button", { name: labels[index + 1], exact: true })).toBeVisible();
  }
}

async function expectTrackMapCanvases(page: Page): Promise<void> {
  const overlayControl = page.getByRole("button", { name: /^(Overlay|Inputs|Segments|Sectors|Racing line)$/ });
  const trackPanel = overlayControl.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' relative ')][1]");
  const canvases = trackPanel.locator("canvas");
  await expect(canvases).toHaveCount(3);
  for (let index = 0; index < 3; index++) await expect(canvases.nth(index)).toBeVisible();
}
test("Analyse shared controls work across seeded game recordings", async ({ page, request }) => {
  test.setTimeout(240_000);
  const browserErrors = collectBrowserErrors(page);

  for (const game of SEEDED_GAME_CASES) {
    const target = await getSeededLapTarget(request, game.gameId);
    await openAnalyseLap(page, target, game.prefix);
    await exerciseCrossGameControls(page, game.gameId === "f1-2025" && Boolean(target.telemetry[0]?.f1?.setup));
  }

  expect(browserErrors.errors, "unexpected browser errors in seeded Analyse matrix").toEqual([]);
});

test("Analyse racing-line overlay follows seeded track availability", async ({ page, request }) => {
  test.setTimeout(240_000);
  const browserErrors = collectBrowserErrors(page);

  const accTarget = await getSeededLapTarget(request, "acc");
  const accBoundariesResponse = await request.get(`/api/track-boundaries/${accTarget.trackOrdinal}?gameId=acc`);
  expect(accBoundariesResponse.ok(), "ACC track boundaries response").toBe(true);
  const accBoundaries = (await accBoundariesResponse.json()) as { raceLine?: unknown };
  expect(Array.isArray(accBoundaries.raceLine), "ACC racing-line payload").toBe(true);
  expect((accBoundaries.raceLine as unknown[]).length).toBeGreaterThan(1);
  await openAnalyseLap(page, accTarget, "acc");
  await expectTrackMapCanvases(page);
  await expectOverlaySequence(page, ["Overlay", "Inputs", "Segments", "Sectors", "Racing line", "Overlay"]);

  const acEvoTarget = await getSeededLapTarget(request, "ac-evo");
  const acEvoBoundariesResponse = await request.get(`/api/track-boundaries/${acEvoTarget.trackOrdinal}?gameId=ac-evo`);
  expect(acEvoBoundariesResponse.ok(), "AC Evo track boundaries response").toBe(true);
  const acEvoBoundaries = (await acEvoBoundariesResponse.json()) as { raceLine?: unknown };
  expect(Array.isArray(acEvoBoundaries.raceLine), "AC Evo racing-line payload").toBe(true);
  expect((acEvoBoundaries.raceLine as unknown[]).length).toBeGreaterThan(1);
  await openAnalyseLap(page, acEvoTarget, "ac-evo");
  await expectTrackMapCanvases(page);
  await expectOverlaySequence(page, ["Overlay", "Inputs", "Segments", "Sectors", "Racing line"]);

  const fmTarget = await getSeededLapTarget(request, "fm-2023");
  await openAnalyseLap(page, fmTarget, "fm23");
  await expectTrackMapCanvases(page);
  await expect(page.getByRole("button", { name: "Overlay", exact: true })).toBeVisible();
  await expectOverlaySequence(page, ["Overlay", "Inputs", "Segments", "Sectors", "Overlay"]);

  expect(browserErrors.errors, "unexpected browser errors while cycling racing-line overlays").toEqual([]);
});
