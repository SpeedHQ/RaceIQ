import { expect, test } from "@playwright/test";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "f1-2025")!;

test("compare exposes recorded telemetry categories with per-wheel A/B charts", async ({ page, request }, testInfo) => {
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=compare`);
  const panel = page.locator("#compare-body-compare");
  const channels = panel.getByTestId("compare-telemetry-channels");
  await expect(channels.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  if (await split.isVisible()) await split.click();
  await expect(panel.locator("select")).toHaveCount(0);
  await panel.locator("#compare-category-tires").click();
  await page.screenshot({ path: testInfo.outputPath("telemetry-channels-desktop.png"), animations: "disabled" });
  const wheelCharts = channels.locator('[data-channel$=":0"], [data-channel$=":1"], [data-channel$=":2"], [data-channel$=":3"]');
  await expect(wheelCharts.first()).toBeVisible();
  for (const component of [0, 1, 2, 3]) {
    await expect(channels.locator(`[data-channel$=":${component}"] .uplot`).first()).toBeAttached();
  }
  const chart = wheelCharts.first();
  await expect(chart.locator(".u-legend")).toContainText("A —");
  await expect(chart.locator(".u-legend")).toContainText("B —");
  const column = panel.getByTestId("compare-chart-column");
  const delta = panel.getByTestId("compare-time-delta");
  const deltaTop = (await delta.boundingBox())!.y;
  const categoryBottom = (await panel.locator('[role="tablist"]').boundingBox())!;
  expect(categoryBottom.y + categoryBottom.height).toBeLessThanOrEqual(deltaTop);
  await delta.locator(".u-over").hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => column.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
  expect(Math.abs((await delta.boundingBox())!.y - deltaTop)).toBeLessThan(2);
  expect(Math.abs((await panel.locator('[role="tablist"]').boundingBox())!.y - categoryBottom.y)).toBeLessThan(2);
  await panel.locator("#compare-category-tires").press("Home");
  await expect(panel.locator("#compare-category-inputs")).toBeFocused();
  await expect(panel.locator("#compare-category-inputs")).toHaveAttribute("aria-selected", "true");
  await expect(channels.locator('[data-channel="inputs.gear:"] .uplot')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.locator("#compare-category-inputs")).toBeVisible();
  await column.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("telemetry-channels-mobile.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Spectate precedes Focus View and Home/End follow visual order", async ({ page, request }) => {
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=compare`);
  const tabs = page.locator('[role="tablist"]').filter({ has: page.locator("#compare-tab-spectate") });
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("id", "compare-tab-spectate");
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  if (await split.isVisible()) await split.click();
  await page.getByRole("tab", { name: "Focus View", exact: true }).press("Home");
  await expect(page.locator("#compare-tab-spectate")).toBeFocused();
  await expect(page.locator("#compare-tab-spectate")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-spectate-playback]")).toBeVisible({ timeout: 30_000 });
  await page.locator("#compare-tab-spectate").press("End", { timeout: 30_000 });
  await expect(page.locator("#compare-tab-compare")).toBeFocused();
  await expect(page.locator("#compare-tab-compare")).toHaveAttribute("aria-selected", "true");
});

test("Spectate keeps time delta visible across categories and channel scrolling", async ({ page, request }, testInfo) => {
  const pair = await getDistinctPair(request, game.gameId);
  await page.addInitScript(() => {
    localStorage.setItem("spectate-telemetry-open", "true");
    localStorage.setItem("spectate-car-panel-open", "false");
  });
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`);
  const panel = page.locator("#spectate-telemetry-panel");
  const delta = panel.locator('[data-channel-id="comparison.time-delta"]');
  await expect(delta).toBeVisible({ timeout: 30_000 });
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  if (await split.isVisible()) await split.click();
  const categories = await panel.getByRole("tab").evaluateAll((elements) => elements.map((element) => element.id));
  for (const id of categories) {
    await panel.locator(`#${id}`).click();
    await expect(delta).toBeVisible();
    await expect(panel.locator('[data-channel-id="comparison.time-delta"]')).toHaveCount(1);
  }
  await panel.locator("#spectate-category-tires").click();
  const top = (await delta.boundingBox())!.y;
  await delta.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => panel.locator("[data-spectate-scroll]").evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  expect(Math.abs((await delta.boundingBox())!.y - top)).toBeLessThan(2);
  await expect(delta.locator("canvas")).toHaveAttribute("data-current-a", /^-?\d/);
  await page.screenshot({ path: testInfo.outputPath("spectate-sticky-delta.png"), animations: "disabled" });
});
