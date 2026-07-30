import { expect, test } from "@playwright/test";
const themeStoryUrl = "/iframe.html?id=design-system-theme-contract--states&viewMode=story";

// Storybook's first preview navigation can remain on its loading screen while
// Vite compiles the story graph. Warm the preview once and reload if that
// first request gets stuck, rather than charging the race to the snapshot.
test.setTimeout(120_000);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(themeStoryUrl, { waitUntil: "domcontentloaded" });
      try {
        await page.getByRole("heading", { name: "Theme contract" }).waitFor({ timeout: 60_000 });
        return;
      } catch {
        if (attempt === 1) throw new Error("Storybook never rendered the theme contract story");
      }
    }
  } finally {
    await page.close();
  }
});

test("snapshot: theme semantic states", async ({ page }) => {
  await page.goto(themeStoryUrl);
  await page.getByRole("heading", { name: "Theme contract" }).waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Hover state" }).hover();

  await expect(page).toHaveScreenshot("ThemeContract.png", {
    fullPage: false,
    animations: "disabled",
  });
});
