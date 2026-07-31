import { expect, test } from "@playwright/test";
import { THEME_SNAPSHOT_CASE } from "./snapshot-cases";
import { openStory, warmStorybook } from "./storybook-ready";

const themeStoryUrl = `/iframe.html?id=${THEME_SNAPSHOT_CASE.id}&viewMode=story`;

// Warm cold Storybook preview before charging compilation to this snapshot.
test.setTimeout(120_000);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  await warmStorybook(browser, themeStoryUrl, {
    attempts: 12,
    attemptTimeoutMs: 10_000,
  });
});

test(`snapshot: ${THEME_SNAPSHOT_CASE.name}`, async ({ page }) => {
  await openStory(page, themeStoryUrl);
  await page.getByRole("heading", { name: THEME_SNAPSHOT_CASE.readyText }).waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: THEME_SNAPSHOT_CASE.hoverLabel }).hover();

  await expect(page).toHaveScreenshot("ThemeContract.png", {
    fullPage: false,
    animations: "disabled",
  });
});
