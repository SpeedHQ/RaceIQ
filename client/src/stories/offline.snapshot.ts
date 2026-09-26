import { expect, test } from "./snapshot-test";
import { openStory } from "./storybook-ready";

const STORY_IDS = [
  "dashboards-f1livedashboard--visual-contract",
  "dashboards-forzalivedashboard--visual-contract",
  "dashboards-acclivedashboard--visual-contract",
  "dashboards-home-dashboard--per-game",
  "dashboards-sessions--recorded",
  "dashboards-sessions--imported",
  "dashboards-experiments-livetestdashboard--default",
  "dashboards-experiments-workspace--default",
  "dashboards-experiments-flow--workspace-car-focus",
  "dashboards-experiments-flow--workspace-driver-focus",
  "dashboards-experiments-sessionreviewdashboard--default",
] as const;

test.setTimeout(300_000);

test("covered stories use only fixture-backed API requests", async ({ page }) => {
  for (const id of STORY_IDS) {
    await openStory(page, `/iframe.html?id=${id}&viewMode=story`);
    await page.waitForTimeout(100);
  }
  await page.goto("about:blank");
});
