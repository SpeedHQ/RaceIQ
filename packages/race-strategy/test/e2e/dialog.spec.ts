import { expect, test } from "@playwright/test";
import { StrategyRuntime } from "./runtime";
import { ingestNativeRun } from "./native-source";

test("strategy timeline opens from live Forza telemetry and stays within narrow screens", async ({ browser }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-pit-estimate-dialog"));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    await ingestNativeRun({ carId: 639, laps: [] }, runtime.udpPort);
    const openButton = page.getByRole("button", { name: "Open strategy timeline" });
    await expect(openButton).toBeVisible();

    await openButton.click();
    const dialog = page.getByRole("dialog", { name: "Plan against the lap horizon" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Projected horizon" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Tire readings" })).toBeVisible();
    await expect(dialog.getByRole("table").getByRole("rowheader", { name: "FL" })).toBeVisible();
    await dialog.getByText("Projection evidence", { exact: true }).click();
    await dialog.getByText("Projection history", { exact: true }).click();
    await dialog.screenshot({ path: testInfo.outputPath("pit-timeline-desktop.png") });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await openButton.click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath("pit-timeline-mobile.png") });
  } finally {
    await runtime.stop();
    await context.close();
  }
});
