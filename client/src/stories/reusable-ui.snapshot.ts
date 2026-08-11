import { expect, test } from "@playwright/test";
import { REUSABLE_UI_SNAPSHOT_CASES } from "./snapshot-cases";
import { openStoryForSnapshot, warmStorybook } from "./storybook-ready";

test.setTimeout(120_000);
const comparisonCaptureOnly = process.env.RACEIQ_UI_DIFF_CAPTURE === "1";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmStorybook(browser, `/iframe.html?id=${REUSABLE_UI_SNAPSHOT_CASES[0].id}&viewMode=story`, { attempts: 18, attemptTimeoutMs: 15_000 });
});

for (const story of REUSABLE_UI_SNAPSHOT_CASES) {
  test(`snapshot: ${story.name}`, async ({ page }) => {
    const playErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /(?:AssertionError|expect\()/.test(message.text())) playErrors.push(message.text());
    });

    if (story.viewport) await page.setViewportSize(story.viewport);
    await openStoryForSnapshot(page, `/iframe.html?id=${story.id}&viewMode=story`);

    if (story.clickLabel) {
      await page.getByRole(story.clickRole ?? "button", { name: story.clickLabel }).click();
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

    if (!comparisonCaptureOnly) {
      expect(playErrors).toEqual([]);
    }
  });
}
