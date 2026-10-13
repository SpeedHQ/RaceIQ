import { expect, test } from "@playwright/test";
import { mockLiveScreenshotTelemetry } from "../support/responsive/live-screenshot";

const SCREENSHOT_DIR = process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/app";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile live dashboard", async ({ page, request }) => {
  await mockLiveScreenshotTelemetry(page, request, "fm-2023");
  await page.goto("/live", { waitUntil: "networkidle" });
  await expect(page.locator("[data-live-dashboard-layout]")).toBeVisible();
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/mobile/dashboard.png`,
    fullPage: true,
    animations: "disabled",
  });
});
