import { expect, test } from "@playwright/test";

test("snapshot: theme semantic states", async ({ page }) => {
  await page.goto("/iframe.html?id=design-system-theme-contract--states&viewMode=story");
  await page.getByRole("heading", { name: "Theme contract" }).waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Hover state" }).hover();

  await expect(page).toHaveScreenshot("ThemeContract.png", {
    fullPage: false,
    animations: "disabled",
  });
});
