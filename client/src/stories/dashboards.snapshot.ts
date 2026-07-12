import { expect, test } from "@playwright/test";

// Storybook iframe URL format: /iframe.html?id=<story-id>&viewMode=story
// Story IDs are derived from title + export name: "Dashboards/F1LiveDashboard" + "Default" → "dashboards-f1livedashboard--default"

// iPhone 16 Pro landscape CSS viewport (6.3" display, logical 874 × 402).
const IPHONE_16_PRO_LANDSCAPE = { width: 874, height: 402 };

interface StoryCase {
  name: string;
  id: string;
  viewport?: { width: number; height: number };
}

const stories: StoryCase[] = [
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
  {
    name: "ComboDash1",
    id: "dashes-combo-combo-dash-1--fm-2023",
    viewport: IPHONE_16_PRO_LANDSCAPE,
  },
  {
    name: "ComboDash2",
    id: "dashes-combo-combo-dash-2--fm-2023",
    viewport: IPHONE_16_PRO_LANDSCAPE,
  },
];

for (const story of stories) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    if (story.viewport) await page.setViewportSize(story.viewport);
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    // Wait for the dashboard to be visible — look for the generic panel structure
    await page.waitForSelector("[class*='border']", { timeout: 10_000 });
    // Wait for web fonts to finish loading. Otherwise the capture can race the
    // font swap (Geist vs fallback) and every glyph shifts ~1px, producing a
    // full-frame text diff that has nothing to do with the actual change.
    await page.evaluate(() => document.fonts.ready);
    // Extra settle time for charts and animations
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot(`${story.name}.png`, {
      fullPage: false,
      animations: "disabled",
    });
  });
}
