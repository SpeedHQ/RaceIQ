import { expect, test } from "@playwright/test";
import { openStory, warmStorybook } from "./storybook-ready";

const themeStoryUrl = "/iframe.html?id=design-system-theme-contract--states&viewMode=story";

// Storybook's first preview navigation can remain on its loading screen while
// Vite compiles the story graph. Warm the preview once and reload if that
// first request gets stuck, rather than charging the race to the snapshot.
test.setTimeout(120_000);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  await warmStorybook(browser, themeStoryUrl, {
    attempts: 12,
    attemptTimeoutMs: 10_000,
  });
});

test("snapshot: theme semantic states", async ({ page }) => {
  await openStory(page, themeStoryUrl);
  await page.getByRole("heading", { name: "Theme contract" }).waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Hover state" }).hover();

  await expect(page).toHaveScreenshot("ThemeContract.png", {
    fullPage: false,
    animations: "disabled",
  });
});
