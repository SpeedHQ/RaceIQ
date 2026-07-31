import { expect, test } from "@playwright/test";
import { DASHBOARD_SNAPSHOT_CASES } from "./snapshot-cases";
import { openStoryForSnapshot, warmStorybook } from "./storybook-ready";

// Story IDs come from Storybook title + export name.
// Inventory lives in snapshot-cases.ts so CI and local comparison cannot drift.
test.setTimeout(180_000);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmStorybook(browser, `/iframe.html?id=${DASHBOARD_SNAPSHOT_CASES[0].id}&viewMode=story`);
});

for (const story of DASHBOARD_SNAPSHOT_CASES) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    if (story.viewport) await page.setViewportSize(story.viewport);
    await openStoryForSnapshot(page, `/iframe.html?id=${story.id}&viewMode=story`);

    await expect(page).toHaveScreenshot(`${story.name}.png`, {
      fullPage: false,
      animations: "disabled",
    });
  });
}
