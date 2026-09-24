import { expect, test } from "@playwright/test";
import { DASHBOARD_SNAPSHOT_CASES } from "./snapshot-cases";
import { openStoryForSnapshot } from "./storybook-ready";

// Story IDs come from Storybook title + export name.
// Inventory lives in snapshot-cases.ts so CI and local comparison cannot drift.
const LIVE_DASHBOARD_NAMES: Record<string, true> = { F1LiveDashboard: true, ForzaLiveDashboard: true, AccLiveDashboard: true, AcEvoLiveDashboard: true, IRacingLiveDashboard: true };
const comparisonCaptureOnly = process.env.RACEIQ_UI_DIFF_CAPTURE === "1";

test.setTimeout(300_000);

for (const story of DASHBOARD_SNAPSHOT_CASES) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    const missingRouterWarnings: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("useRouter must be used inside a <RouterProvider>")) missingRouterWarnings.push(text);
    });

    if (story.viewport) await page.setViewportSize(story.viewport);
    await openStoryForSnapshot(page, `/iframe.html?id=${story.id}&viewMode=story`);

    if (!comparisonCaptureOnly && LIVE_DASHBOARD_NAMES[story.name]) {
      const workspace = page.locator("[data-responsive-workspace]");
      const layout = page.locator("[data-live-dashboard-layout]");
      const racePanel = page.locator("[data-live-dashboard-race]");

      await expect(workspace).toHaveCount(1);
      await expect(workspace).toBeVisible();
      await expect(layout).toBeVisible();
      await expect(racePanel).toBeVisible();

      const columns = await layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean));
      expect(columns).toHaveLength(2);

      const viewport = page.viewportSize();
      const raceBox = await racePanel.boundingBox();
      if (!viewport || !raceBox) throw new Error(`${story.name} race panel has no viewport geometry`);
      expect(raceBox.x).toBeGreaterThanOrEqual(viewport.width / 2 - 1);
      expect(raceBox.width).toBeGreaterThanOrEqual(viewport.width / 2 - 1);
      expect(raceBox.y).toBeLessThan(viewport.height);

      const raceHeading = racePanel.getByRole("heading", { name: "Race", exact: true });
      await expect(raceHeading).toBeVisible();
      const headingBox = await raceHeading.boundingBox();
      if (!headingBox) throw new Error(`${story.name} Race heading has no viewport geometry`);
      expect(headingBox.x).toBeGreaterThanOrEqual(raceBox.x);
      expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(raceBox.x + raceBox.width);
      expect(
        await raceHeading.evaluate((heading) => {
          const box = heading.getBoundingClientRect();
          const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return painted === heading || heading.contains(painted);
        }),
      ).toBe(true);
    }

    if (!comparisonCaptureOnly && story.name === "GearingDashboard") {
      const layout = page.locator("[data-live-dashboard-layout]");
      await expect(layout).toHaveCount(1);
      await expect(layout).toBeVisible();
      const columns = await layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean));
      expect(columns).toHaveLength(2);

      const powerBand = page.getByRole("heading", { name: "Power Band", exact: true });
      const trackSpeed = page.getByRole("heading", { name: "Track Speed", exact: true });
      const [layoutBox, powerBandBox, trackSpeedBox] = await Promise.all([layout.boundingBox(), powerBand.boundingBox(), trackSpeed.boundingBox()]);
      if (!layoutBox || !powerBandBox || !trackSpeedBox) throw new Error("Gearing dashboard has no viewport geometry");
      expect(powerBandBox.x).toBeLessThan(layoutBox.x + layoutBox.width / 2);
      expect(trackSpeedBox.x).toBeGreaterThanOrEqual(layoutBox.x + layoutBox.width / 2);
    }

    await expect(page).toHaveScreenshot(`${story.name}.png`, {
      fullPage: false,
      animations: "disabled",
    });

    if (!comparisonCaptureOnly) expect(missingRouterWarnings).toEqual([]);
  });
}
