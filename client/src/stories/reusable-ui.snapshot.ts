import { expect, test } from "@playwright/test";
import { REUSABLE_UI_SNAPSHOT_CASES } from "./snapshot-cases";
import { openStoryForSnapshot } from "./storybook-ready";

test.setTimeout(120_000);
const comparisonCaptureOnly = process.env.RACEIQ_UI_DIFF_CAPTURE === "1";

for (const story of REUSABLE_UI_SNAPSHOT_CASES) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    const playErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /(?:AssertionError|expect\()/.test(message.text())) playErrors.push(message.text());
    });

    if (story.viewport) await page.setViewportSize(story.viewport);
    await openStoryForSnapshot(page, `/iframe.html?id=${story.id}&viewMode=story`);

    if (story.clickLabel) {
      const readyState = story.readyRole ? page.getByRole(story.readyRole, { name: story.readyName }) : undefined;
      if (!readyState || !(await readyState.isVisible())) {
        await page.getByRole(story.clickRole ?? "button", { name: story.clickLabel }).click();
      }
    }
    if (story.readyRole) {
      await expect(
        page.getByRole(story.readyRole, {
          name: story.readyName,
        }),
      ).toBeVisible();
    }

    const screenshotTarget = story.screenshotTarget ? page.locator(story.screenshotTarget) : page;
    await expect(screenshotTarget).toHaveScreenshot(`${story.name}.png`, {
      fullPage: story.fullPage ?? false,
      animations: "disabled",
    });

    if (!comparisonCaptureOnly) {
      expect(playErrors).toEqual([]);
    }
  });
}
