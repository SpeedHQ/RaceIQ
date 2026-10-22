import { expect, test } from "@playwright/test";
import { StrategyRuntime } from "./runtime";

test("strategy timeline opens from live F1 telemetry and stays within narrow screens", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-pit-estimate-dialog"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const replay = api.post("/api/dev/replay/f1-2025-2026-04-22T11-42-43-029Z?packets=240&intervalMs=50", { timeout: 60_000 });
    const openButton = page.getByRole("button", { name: "Open strategy timeline" });
    await expect(openButton).toBeVisible();
    const replayResponse = await replay;
    expect(replayResponse.ok(), await replayResponse.text()).toBe(true);
    const pitRow = page.locator(".col-span-2").filter({ has: openButton });
    const leftColumn = page.locator("[data-live-dashboard-layout] > div").first();
    const desktopWidths = await Promise.all([pitRow.evaluate((element) => element.getBoundingClientRect().width), leftColumn.evaluate((element) => element.getBoundingClientRect().width)]);
    expect(Math.abs(desktopWidths[0]! - desktopWidths[1]!)).toBeLessThanOrEqual(1);

    await openButton.click();
    const dialog = page.getByRole("dialog", { name: "Plan against the lap horizon" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Projected horizon" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Tire readings" })).toBeVisible();
    await expect(dialog.getByRole("table").getByRole("rowheader", { name: "FL" })).toBeVisible();
    await dialog.getByText("Projection evidence", { exact: true }).click();
    await expect(dialog.getByText("Positions describe projected thresholds, not observed events.")).toBeVisible();
    await dialog.getByText("Projection history", { exact: true }).click();
    await expect(dialog.getByText("No saved pit estimates yet.").or(dialog.getByText("Recent pit estimates"))).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath("pit-timeline-desktop.png") });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidths = await Promise.all([pitRow.evaluate((element) => element.getBoundingClientRect().width), leftColumn.evaluate((element) => element.getBoundingClientRect().width)]);
    expect(Math.abs(mobileWidths[0]! - mobileWidths[1]!)).toBeLessThanOrEqual(1);
    await openButton.click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath("pit-timeline-mobile.png") });
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});
