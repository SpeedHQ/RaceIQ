import { expect, test } from "@playwright/test";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "f1-2025")!;

test("Focus View AI panel shares Spectate header controls and panel styling", async ({ page, request }, testInfo) => {
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=compare`);
  await expect(page.getByTestId("compare-telemetry-channels").locator(".uplot").first()).toBeVisible({ timeout: 30_000 });
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  if (await split.isVisible()) await split.click();
  const toggle = page.locator('[data-panel-toggle="compare-ai-panel"]');
  await expect(toggle).toBeEnabled({ timeout: 30_000 });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const panel = page.locator("#compare-ai-panel");
  const header = page.locator('[data-panel-header="compare-ai-panel"]');
  await expect(panel).toBeVisible();
  const collapse = header.getByRole("button", { name: "Collapse AI Analysis", exact: true });
  await collapse.click();
  await expect(header.getByRole("button", { name: "Expand AI Analysis", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(header.getByRole("button", { name: "Clear chat", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("telemetry-ai-panel.png"), animations: "disabled" });
  const style = async (selector: string) => page.locator(selector).evaluate((element) => {
    const value = getComputedStyle(element);
    return { width: value.width, background: value.backgroundColor, border: value.borderLeftColor };
  });
  const telemetryStyle = await style("#compare-ai-panel");
  const telemetryHeader = await style('[data-panel-header="compare-ai-panel"]');
  await page.locator("#compare-tab-spectate").click();
  const spectateToggle = page.locator('[data-panel-toggle="spectate-ai-panel"]');
  await expect(spectateToggle).toBeVisible({ timeout: 30_000 });
  await expect(spectateToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#spectate-ai-panel")).toBeVisible();
  expect(await style("#spectate-ai-panel")).toEqual(telemetryStyle);
  expect(await style('[data-panel-header="spectate-ai-panel"]')).toEqual(telemetryHeader);
  await expect(page.locator('[data-panel-header="spectate-ai-panel"]').getByRole("button", { name: "Collapse AI Analysis", exact: true })).toBeVisible();
  await page.locator("#compare-tab-compare").click();
  await expect(page.getByRole("tab", { name: "Focus View", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  const restoredToggle = page.getByRole("button", { name: "AI Analysis", exact: true });
  await expect(restoredToggle).toHaveAttribute("aria-controls", "compare-ai-panel");
  await restoredToggle.click();
  await expect(panel).toHaveCount(0);
  await expect(restoredToggle).toHaveAttribute("aria-expanded", "false");
});
