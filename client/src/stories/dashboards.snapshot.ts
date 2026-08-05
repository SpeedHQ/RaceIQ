import { expect, test } from "@playwright/test";
import { openStoryForSnapshot, warmStorybook } from "./storybook-ready";

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
    name: "SetupBrowser",
    id: "setups-setupbrowser--default",
  },
  {
    name: "SetupBrowserReadOnly",
    id: "setups-setupbrowser--read-only",
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

// Pay cold Storybook preview compilation before whichever dashboard runs first.
test.setTimeout(180_000);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmStorybook(browser, `/iframe.html?id=${stories[0].id}&viewMode=story`);
});

for (const story of stories) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    if (story.viewport) await page.setViewportSize(story.viewport);
    await openStoryForSnapshot(page, `/iframe.html?id=${story.id}&viewMode=story`);

    await expect(page).toHaveScreenshot(`${story.name}.png`, {
      fullPage: false,
      animations: "disabled",
    });
  });
}
