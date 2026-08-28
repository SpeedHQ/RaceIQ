import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { exerciseCrossGameControls } from "./controls";
import { openAnalyseLap } from "./fixtures";

async function openOverlayMenu(page: Page, hasRacingLine: boolean): Promise<void> {
  await page.getByRole("button", { name: "Overlays", exact: true }).click();
  for (const label of ["Inputs", "Segments", "Sectors"]) {
    await expect(page.getByRole("menuitemcheckbox", { name: label, exact: true })).toBeVisible();
  }
  const racingLine = page.getByRole("menuitemcheckbox", { name: "Racing line", exact: true });
  if (hasRacingLine) await expect(racingLine).toBeVisible();
  else await expect(racingLine).toHaveCount(0);
}

async function openWireframeViewMenu(page: Page, hasRacingLine: boolean): Promise<void> {
  await page.getByRole("tabpanel", { name: "3D", exact: true }).getByRole("button", { name: "View", exact: true }).click();
  for (const label of ["Springs", "Trails", "Inputs", "Track", "Grid", "Drive", "Tire Info"]) {
    await expect(page.getByRole("menuitemcheckbox", { name: label, exact: true })).toBeVisible();
  }
  const racingLine = page.getByRole("menuitemcheckbox", { name: "Racing line", exact: true });
  if (hasRacingLine) await expect(racingLine).toBeVisible();
  else await expect(racingLine).toHaveCount(0);
}

async function seekToClosestRacingLine(page: Page, request: APIRequestContext, lapId: number, gameId: "acc" | "ac-evo", raceLine: Array<{ x: number; z: number }>): Promise<void> {
  const replayResponse = await request.get(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": gameId } });
  expect(replayResponse.ok(), `${gameId} semantic replay response`).toBe(true);
  const replay = (await replayResponse.json()) as {
    envelopes: Array<{
      values: Array<{ semanticId: string; value: unknown }>;
    }>;
  };
  let bestFrameIndex = 0;
  let bestDistanceSquared = Infinity;
  const frameDistances = new Array<number>(replay.envelopes.length).fill(Infinity);
  const frameTimes = replay.envelopes.map((envelope) => {
    const value = envelope.values.find((entry) => entry.semanticId === "timing.current-lap")?.value;
    return typeof value === "number" ? value : 0;
  });
  for (let frameIndex = 0; frameIndex < replay.envelopes.length; frameIndex++) {
    const values = replay.envelopes[frameIndex].values;
    const positionX = values.find((entry) => entry.semanticId === "motion.position-x")?.value;
    const positionZ = values.find((entry) => entry.semanticId === "motion.position-z")?.value;
    if (typeof positionX !== "number" || typeof positionZ !== "number") continue;
    let frameDistanceSquared = Infinity;
    for (const point of raceLine) {
      frameDistanceSquared = Math.min(frameDistanceSquared, (positionX + point.x) ** 2 + (positionZ - point.z) ** 2);
    }
    frameDistances[frameIndex] = Math.sqrt(frameDistanceSquared);
    if (frameDistanceSquared < bestDistanceSquared) {
      bestDistanceSquared = frameDistanceSquared;
      bestFrameIndex = frameIndex;
    }
  }
  expect(Math.sqrt(bestDistanceSquared), `${gameId} replay should cross its reference line`).toBeLessThan(1);

  const firstTime = frameTimes[0];
  const lastTime = frameTimes.at(-1)!;
  const bestTime = frameTimes[bestFrameIndex];
  const timeFraction = (bestTime - firstTime) / (lastTime - firstTime);
  const slider = page.getByRole("slider", { name: "Lap timeline" });
  const box = await slider.boundingBox();
  expect(box, "lap timeline bounds").not.toBeNull();
  await slider.click({ position: { x: Math.max(1, Math.min(box!.width - 1, box!.width * timeFraction)), y: box!.height / 2 } });
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  const selectedFrameIndex = Number(await slider.getAttribute("aria-valuenow"));
  expect(frameDistances[selectedFrameIndex], `${gameId} selected frame should place car over reference line`).toBeLessThan(2.5);
}

async function expectVisible3dRacingLine(page: Page): Promise<void> {
  for (const label of ["Springs", "Trails", "Inputs", "Track", "Grid", "Drive", "Tire Info"]) {
    await setOverlayChecked(page, label, false);
  }
  await setOverlayChecked(page, "Racing line", true);
  await page.keyboard.press("Escape");

  const carRenderMode = page.getByRole("button", { name: /^(Wire|Solid|Hidden)$/ });
  for (let attempt = 0; attempt < 2 && (await carRenderMode.textContent())?.trim() !== "Hidden"; attempt++) await carRenderMode.click();
  await expect(carRenderMode).toHaveText("Hidden");
  await page.getByRole("button", { name: /^Top$/i }).click();

  const canvas = page.getByRole("tabpanel", { name: "3D", exact: true }).locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      async () => {
        const screenshot = await canvas.screenshot();
        const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let racingLinePixels = 0;
        for (let index = 0; index < info.width * info.height * info.channels; index += info.channels) {
          const red = data[index];
          const green = data[index + 1];
          const blue = data[index + 2];
          if (red > 120 && blue > 150 && red > green * 1.15 && blue > green * 1.25) racingLinePixels++;
        }
        return racingLinePixels;
      },
      { message: "3D canvas should contain rendered purple racing-line pixels" },
    )
    .toBeGreaterThan(5);
}

async function setOverlayChecked(page: Page, label: string, checked: boolean): Promise<void> {
  const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
  if ((await item.getAttribute("aria-checked")) !== String(checked)) await item.click();
  await expect(item).toHaveAttribute("aria-checked", String(checked));
}

async function expectTrackMapCanvases(page: Page): Promise<void> {
  const trackPanel = page.getByTestId("analyse-track-map-panel");
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
    await exerciseCrossGameControls(page, game.gameId === "f1-2025" && Boolean(target.telemetry[0]?.f1?.setup), target.lapNumber);
  }

  expect(browserErrors.errors, "unexpected browser errors in seeded Analyse matrix").toEqual([]);
});
test("Analyse MoTeC import follows selected game support", async ({ page, request }) => {
  test.setTimeout(240_000);
  for (const game of SEEDED_GAME_CASES) {
    const target = await getSeededLapTarget(request, game.gameId);
    await openAnalyseLap(page, target, game.prefix);
    await page.getByRole("button", { name: /Export \/ Import/ }).click();
    const motecItem = page.getByRole("menuitem", { name: "Import MoTeC log", exact: true });
    if (game.gameId === "acc" || game.gameId === "ac-evo") {
      await expect(motecItem).toHaveCount(1);
      await motecItem.click();
      await expect(page.getByRole("dialog")).toContainText(new RegExp(game.name, "i"));
      await expect(page.getByRole("dialog").getByText(/Which sim exported this log/)).toHaveCount(0);
      await page.keyboard.press("Escape");
    } else {
      await expect(motecItem).toHaveCount(1);
      await expect(motecItem).toBeDisabled();
      await expect(motecItem).toHaveAttribute("title", "MoTeC import is not supported for this game yet.");
      await page.keyboard.press("Escape");
    }
  }
});
test("Session MoTeC import reuses setup modal with current game default", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/api/laps/detect-import", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ format: "motec", supported: true, gameIds: [], captureCount: 1, message: null }) });
  });
  await page.goto("/acc/sessions");
  await page.getByRole("button", { name: /import/i }).click();
  const sessionDialog = page.getByRole("dialog");
  await sessionDialog.locator('input[type="file"]').setInputFiles({ name: "sample.ld", mimeType: "application/octet-stream", buffer: Buffer.from("synthetic") });
  const motecDialog = page.getByRole("dialog");
  await expect(motecDialog).toContainText("Import MoTeC log");
  await expect(motecDialog).toContainText("Assetto Corsa Competizione");
  await expect(motecDialog.getByRole("combobox", { name: "Game" })).toHaveValue("Assetto Corsa Competizione");
});

test("Analyse racing-line overlay follows seeded track availability", async ({ page, request }) => {
  test.setTimeout(240_000);
  const browserErrors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__recording = true;
  });

  const accTarget = await getSeededLapTarget(request, "acc");
  const accBoundariesResponse = await request.get(`/api/track-boundaries/${accTarget.trackOrdinal}?gameId=acc`);
  expect(accBoundariesResponse.ok(), "ACC track boundaries response").toBe(true);
  const accBoundaries = (await accBoundariesResponse.json()) as { raceLine?: Array<{ x: number; z: number }> };
  expect(Array.isArray(accBoundaries.raceLine), "ACC racing-line payload").toBe(true);
  expect(accBoundaries.raceLine!.length).toBeGreaterThan(1);
  await openAnalyseLap(page, accTarget, "acc");
  await expectTrackMapCanvases(page);
  await openOverlayMenu(page, true);
  await setOverlayChecked(page, "Inputs", true);
  await setOverlayChecked(page, "Segments", true);
  await setOverlayChecked(page, "Racing line", true);
  for (const label of ["Inputs", "Segments", "Racing line"]) {
    await expect(page.getByRole("menuitemcheckbox", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
  }
  await page.keyboard.press("Escape");
  await seekToClosestRacingLine(page, request, accTarget.id, "acc", accBoundaries.raceLine!);
  await page.getByRole("tab", { name: "3D", exact: true }).click();
  await openWireframeViewMenu(page, true);
  await expect(page.getByRole("menuitemcheckbox", { name: "Racing line", exact: true })).toHaveAttribute("aria-checked", "false");
  await expectVisible3dRacingLine(page);

  const acEvoTarget = await getSeededLapTarget(request, "ac-evo");
  const acEvoBoundariesResponse = await request.get(`/api/track-boundaries/${acEvoTarget.trackOrdinal}?gameId=ac-evo`);
  expect(acEvoBoundariesResponse.ok(), "AC Evo track boundaries response").toBe(true);
  const acEvoBoundaries = (await acEvoBoundariesResponse.json()) as { raceLine?: unknown };
  expect(Array.isArray(acEvoBoundaries.raceLine), "AC Evo racing-line payload").toBe(true);
  expect((acEvoBoundaries.raceLine as unknown[]).length).toBeGreaterThan(1);
  await openAnalyseLap(page, acEvoTarget, "ac-evo");
  await expectTrackMapCanvases(page);
  await openOverlayMenu(page, true);
  for (const label of ["Inputs", "Segments", "Racing line"]) {
    await expect(page.getByRole("menuitemcheckbox", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
  }
  await page.keyboard.press("Escape");
  await openWireframeViewMenu(page, true);
  await expect(page.getByRole("menuitemcheckbox", { name: "Racing line", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  const fmTarget = await getSeededLapTarget(request, "fm-2023");
  await openAnalyseLap(page, fmTarget, "fm23");
  await expectTrackMapCanvases(page);
  await openOverlayMenu(page, false);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "3D", exact: true }).click();
  await openWireframeViewMenu(page, false);

  expect(browserErrors.errors, "unexpected browser errors while toggling racing-line overlays").toEqual([]);
});
