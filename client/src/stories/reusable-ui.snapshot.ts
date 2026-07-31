import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { REUSABLE_UI_SNAPSHOT_CASES } from "./snapshot-cases";
import { openStoryForSnapshot, warmStorybook } from "./storybook-ready";

const snapshotDir = process.env.RACEIQ_SNAPSHOT_DIR ? resolve(process.env.RACEIQ_SNAPSHOT_DIR) : resolve(import.meta.dirname, "__snapshots__");
const hasCanonicalBaselines = REUSABLE_UI_SNAPSHOT_CASES.every((story) => existsSync(resolve(snapshotDir, story.outputName)));
const captureEnabled = process.env.RACEIQ_CANONICAL_SNAPSHOT_ENV === "1" || process.env.RACEIQ_CAPTURE_REUSABLE_UI === "1" || hasCanonicalBaselines;

test.skip(!captureEnabled, "Reusable UI baselines await generation in pinned Playwright Linux renderer");
test.setTimeout(120_000);

test.beforeAll(async ({ browser }) => {
  await warmStorybook(browser, `/iframe.html?id=${REUSABLE_UI_SNAPSHOT_CASES[0].id}&viewMode=story`);
});

for (const story of REUSABLE_UI_SNAPSHOT_CASES) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    if (story.viewport) await page.setViewportSize(story.viewport);
    await openStoryForSnapshot(page, `/iframe.html?id=${story.id}&viewMode=story`);

    if (story.clickLabel) {
      await page.getByRole("button", { name: story.clickLabel }).click();
    }
    if (story.readyRole) {
      await expect(
        page.getByRole(story.readyRole, {
          name: story.readyName,
        }),
      ).toBeVisible();
    }

    await expect(page).toHaveScreenshot(`${story.name}.png`, {
      fullPage: false,
      animations: "disabled",
    });
  });
}
