import { test, expect } from "@playwright/test";

// Storybook iframe URL format: /iframe.html?id=<story-id>&viewMode=story
// Story IDs are derived from title + export name: "Dashboards/F1LiveDashboard" + "Default" → "dashboards-f1livedashboard--default"

const stories = [
  {
    name: "F1LiveDashboard",
    id: "dashboards-f1livedashboard--default",
  },
  {
    name: "ForzaLiveDashboard",
    id: "dashboards-forzalivedashboard--default",
  },
  {
    name: "AccLiveDashboard",
    id: "dashboards-acclivedashboard--default",
  },
];

for (const story of stories) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    // Wait for the dashboard to be visible — look for the generic panel structure
    await page.waitForSelector("[class*='border']", { timeout: 10_000 });
    // Extra settle time for charts and animations
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot(`${story.name}.png`, {
      fullPage: false,
      animations: "disabled",
    });
  });
}
