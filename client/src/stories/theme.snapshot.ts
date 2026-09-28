import { expectScreenshot, test } from "./snapshot-test";
import { THEME_SNAPSHOT_CASE } from "./snapshot-cases";
import { openStory } from "./storybook-ready";

const themeStoryUrl = `/iframe.html?id=${THEME_SNAPSHOT_CASE.id}&viewMode=story`;

test(`snapshot: ${THEME_SNAPSHOT_CASE.name}`, async ({ page }) => {
  await openStory(page, themeStoryUrl);
  await page.getByRole("heading", { name: THEME_SNAPSHOT_CASE.readyText }).waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: THEME_SNAPSHOT_CASE.hoverLabel }).hover();

  await expectScreenshot(page, "ThemeContract.png", {
    fullPage: false,
    animations: "disabled",
  });
});
