import { test, expect } from "@playwright/test";
import { collectBrowserErrors } from "../support/browser-errors";
import { completeOnboarding, resetTunes, waitForTunesList } from "../support/tunes";

// AC Evo uses flat decoded settings and its own road/track categories.
test.describe("AC EVO tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });
  test.afterEach(async ({ page }) => {
    await resetTunes(page);
  });

  test("create setup, preserve values through edit, duplicate, delete", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    try {
      await page.goto("/ac-evo/setups");
      await waitForTunesList(page);

      await page.getByRole("button", { name: /\+ New Tune/i }).click();
      await expect(page.getByRole("heading", { name: /create new ac evo tune/i })).toBeVisible();

      await page.getByLabel("Name").fill("E2E EVO Tune");
      await page.getByLabel("Description").fill("Playwright-created");

      // EVO-only category — confirms the dropdown isn't sharing ACC's list.
      await page.getByLabel("Category").selectOption("trackday");

      await page.getByRole("spinbutton", { name: "Front left Tyre pressure", exact: true }).fill("28");
      await page.getByRole("spinbutton", { name: "Rear left Toe", exact: true }).fill("0");
      await page.getByRole("button", { name: /save setup/i }).click();
      await waitForTunesList(page);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await expect(page.getByText("E2E EVO Tune")).toBeVisible({ timeout: 10_000 });

      await page.getByText("E2E EVO Tune").first().click();
      await page.getByRole("button", { name: /^edit$/i }).click();
      await expect(page.getByRole("heading", { name: /edit: e2e evo tune/i })).toBeVisible();
      await expect(page.getByRole("spinbutton", { name: "Front left Tyre pressure", exact: true })).toHaveValue("28");
      await expect(page.getByRole("spinbutton", { name: "Rear left Toe", exact: true })).toHaveValue("0");
      await page.getByLabel("Name").fill("E2E EVO Edited");
      await page.getByRole("button", { name: /save setup/i }).click();
      await page.waitForURL(/\/ac-evo\/setups\/?$/);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await expect(page.getByText("E2E EVO Edited")).toBeVisible();
      await expect(page.getByText("E2E EVO Tune")).toHaveCount(0);

      await page.getByText("E2E EVO Edited").first().click();
      await page
        .getByRole("button", { name: /duplicate/i })
        .first()
        .click();
      await expect(page.getByText("E2E EVO Edited (copy)")).toBeVisible({ timeout: 10_000 });

      await page.getByText("E2E EVO Edited (copy)").first().click();
      await page
        .getByRole("button", { name: /^delete$/i })
        .first()
        .click();
      await page.getByRole("button", { name: /^yes$/i }).first().click();
      await expect(page.getByText("E2E EVO Edited (copy)")).toHaveCount(0);
    } finally {
      await resetTunes(page);
    }
    expect(browserErrors.errors, "unexpected browser errors in AC EVO tune CRUD").toEqual([]);
  });

  test("import page renders empty state when Documents folder absent", async ({ page }) => {
    await page.goto("/ac-evo/setups/import");
    await expect(page.getByText(/could not find your ac evo setups folder/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
