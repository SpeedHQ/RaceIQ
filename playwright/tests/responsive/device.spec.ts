import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../support/browser-errors";
import { RESPONSIVE_DEVICE_CASES } from "../support/responsive/cases";

// Device projects exercise Playwright's real Chromium emulation (touch,
// mobile user agent, and descriptor viewport). CSS-only layout evidence stays
// mobile-screenshots.spec.ts so this gate remains semantic and compact.
for (const deviceCase of RESPONSIVE_DEVICE_CASES) {
  test(deviceCase.name, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== deviceCase.project, `owned by ${deviceCase.project}`);
    const browserErrors = collectBrowserErrors(page);

    await page.goto(deviceCase.path, { waitUntil: "networkidle" });
    await expect(page.locator("[data-responsive-workspace]")).toBeVisible();
    expect(page.viewportSize()).toEqual(deviceCase.expectedViewport);

    const deviceSignals = await page.evaluate(() => ({
      maxTouchPoints: navigator.maxTouchPoints,
      userAgent: navigator.userAgent,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    expect(deviceSignals.maxTouchPoints).toBeGreaterThan(0);
    expect(deviceSignals.innerWidth).toBe(deviceCase.expectedViewport.width);
    expect(deviceSignals.innerHeight).toBe(deviceCase.expectedViewport.height);
    expect(deviceSignals.userAgent).toMatch(/Mobile|iPad|Android/);

    expect(browserErrors.errors, `unexpected browser errors on ${deviceCase.path}`).toEqual([]);
  });
}
