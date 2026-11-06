import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapMeta, getSeededLapTarget } from "../../support/seeded/laps";
import { exerciseCrossGameControls } from "./controls";
import { openAnalyseLap } from "./fixtures";

test("Analyse shared controls work across seeded game recordings", async ({ page, request }) => {
  test.setTimeout(260_000);
  const browserErrors = collectBrowserErrors(page);

  for (const game of SEEDED_GAME_CASES) {
    const target = await getSeededLapMeta(request, game.gameId);
    await openAnalyseLap(page, target, game.prefix);
    await exerciseCrossGameControls(page, game.gameId === "f1-2025" && Boolean(target.carSetup), target.lapNumber);
  }

  expect(browserErrors.errors, "unexpected browser errors in seeded Analyse matrix").toEqual([]);
});
test("Session MoTeC import locks current game selection", async ({ page }) => {
  test.setTimeout(140_000);
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
  await expect(motecDialog).not.toContainText("Game Assetto Corsa Competizione");
  await expect(motecDialog.getByRole("combobox", { name: "Game" })).toHaveCount(0);
  await motecDialog.getByPlaceholder("Search cars...").click();
  await page.getByRole("option", { name: "Ferrari 296 GT3 2023", exact: true }).click();
  await expect(motecDialog.getByPlaceholder("Search cars...")).toHaveValue("Ferrari 296 GT3 2023");
  await expect(motecDialog.getByPlaceholder("Search setups...")).toBeVisible();
  await motecDialog.getByPlaceholder("Search tracks...").click();
  await expect(page.getByRole("option", { name: "Brands Hatch (GP)" })).toBeVisible();
});

test("F1 MoTeC import searches team cars and tracks without a setup picker", async ({ page }) => {
  await page.route("**/api/laps/detect-import", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ format: "motec", supported: true, gameIds: [], captureCount: 1, message: null }) });
  });
  await page.goto("/f125/sessions");
  await page.getByRole("button", { name: /import/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "sample.ld", mimeType: "application/octet-stream", buffer: Buffer.from("synthetic") });
  await expect(dialog).toContainText("Import MoTeC log");
  const cars = dialog.getByPlaceholder("Search cars...");
  await cars.click();
  await expect(page.getByRole("option", { name: "Ferrari", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Mercedes", exact: true })).toBeVisible();
  await cars.fill("F1 World");
  await page.getByRole("option", { name: "F1 World", exact: true }).click();
  await expect(cars).toHaveValue("F1 World");
  const tracks = dialog.getByPlaceholder("Search tracks...");
  await tracks.fill("Silverstone");
  await page.getByRole("option", { name: "Silverstone Circuit (Grand Prix)", exact: true }).click();
  await expect(tracks).toHaveValue("Silverstone Circuit (Grand Prix)");
  await expect(dialog.getByPlaceholder("Search setups...")).toHaveCount(0);
  await expect(dialog.getByPlaceholder("Pick a car first")).toHaveCount(0);
  await expect(dialog.getByText("Setup (optional)", { exact: true })).toHaveCount(0);
  await expect(dialog).toContainText("MoTeC import is not supported for F1 2025 yet.");
  await dialog.locator('input[accept=".ldx"]').setInputFiles({ name: "sample.ldx", mimeType: "application/octet-stream", buffer: Buffer.from("<LDX />") });
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("Replay model modes preserve wheels and racing-line overlays follow seeded availability", async ({ page, request }, testInfo) => {
  test.setTimeout(260_000);
  const browserErrors = collectBrowserErrors(page);
  for (const [gameId, prefix] of [["acc", "acc"], ["ac-evo", "ac-evo"], ["fm-2023", "fm23"]] as const) {
    const target = await getSeededLapTarget(request, gameId);
    const response = await request.get(`/api/track-boundaries/${encodeURIComponent(target.trackId)}?gameId=${gameId}`);
    expect(response.ok()).toBe(true);
    const boundaries = await response.json() as { raceLine?: unknown[] } | null;
    const hasRacingLine = Array.isArray(boundaries?.raceLine) && boundaries.raceLine.length > 1;
    await openAnalyseLap(page, target, prefix);
    const scene = page.locator("[data-replay-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true");
    await expect(page.getByRole("region", { name: "Circuit overview", exact: true })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Racing line", exact: true });
    const canvas = scene.locator("canvas[data-renderer-backend]");
    for (let step = 0; step < 32 && await canvas.getAttribute("data-native-view-visible") !== "true"; step++) {
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.48);
      await page.mouse.wheel(0, -360);
      await page.evaluate(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        return promise;
      });
    }
    await expect(canvas).toHaveAttribute("data-native-view-visible", "true");
    const modelToggle = scene.locator("[data-spectate-car-model-toggle]");
    await expect(modelToggle).toHaveCount(1);
    for (const mode of ["hidden", "wire", "solid"]) {
      await modelToggle.click();
      await expect(canvas).toHaveAttribute("data-car-model-mode", mode);
      await expect(canvas).toHaveAttribute("data-a-car-visible", String(mode !== "hidden"));
      await expect(canvas).toHaveAttribute("data-a-wheel-visible-count", "4");
      await expect(canvas).toHaveAttribute("data-a-chassis-visible", String(mode !== "solid"));
      if (gameId === "fm-2023") await page.screenshot({ path: testInfo.outputPath(`replay-native-${mode}-chassis.png`), animations: "disabled" });
    }
    if (gameId === "fm-2023") await page.screenshot({ path: testInfo.outputPath("replay-native-car-and-wheels.png"), animations: "disabled" });
    const tireInfo = scene.getByRole("switch", { name: "Tire Info", exact: true });
    await tireInfo.hover();
    await expect(page.getByRole("tooltip", { name: "Tire Info", exact: true })).toBeVisible();
    await tireInfo.click();
    await expect(tireInfo).toHaveAttribute("aria-checked", "true");
    await expect(canvas).toHaveAttribute("data-a-tire-info-visible-count", "4");
    if (gameId === "fm-2023") await page.screenshot({ path: testInfo.outputPath("replay-native-tire-info.png"), animations: "disabled" });
    await tireInfo.press("Enter");
    await expect(tireInfo).toHaveAttribute("aria-checked", "false");
    await expect(canvas).toHaveAttribute("data-a-tire-info-visible-count", "0");
    if (hasRacingLine) {
      if (await toggle.getAttribute("aria-checked") !== "true") await toggle.click();
      await expect.poll(async () => Number(await canvas.getAttribute("data-track-racing-line-dots"))).toBeGreaterThan(0);
      await expect(canvas).toHaveAttribute("data-track-racing-line-visible", "true");
      await toggle.click();
      await expect(canvas).toHaveAttribute("data-track-racing-line-visible", "false");
      await toggle.click();
    } else {
      await expect(canvas).toHaveAttribute("data-track-racing-line-visible", "false");
    }
  }
  expect(browserErrors.errors).toEqual([]);
});
