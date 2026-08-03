import { test, expect } from "@playwright/test";
import { collectBrowserErrors } from "../seeded-e2e-helpers";
import { completeOnboarding, resetTunes, waitForTunesList } from "./helpers";

// AC EVO mirrors the ACC flow but uses the broader category set and the
// additional "Suspension Presets" section.
test.describe("AC EVO tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });
  test.afterEach(async ({ page }) => {
    await resetTunes(page);
  });

  test("create via form with EVO-specific section, edit, duplicate, delete", async ({ page }) => {
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

      // Switch from the default structured form to the raw JSON paste mode.
      await page.getByRole("radio", { name: "Paste JSON" }).click();

      // Populate both a core section and the EVO-only suspension presets section.
      const setupJson = {
        basicSetup: {
          tyres: { tyreCompound: 0, tyrePressure: [28, 28, 28, 28] },
        },
        advancedSetup: {
          suspension: { bumpstops: [10, 10, 10, 10], packers: [0, 0, 0, 0] },
        },
      };
      await page.getByLabel("Setup JSON").fill(JSON.stringify(setupJson, null, 2));
      await expect(page.getByText(/\d+ \/ 9 covered/)).toBeVisible();

      await page.getByRole("button", { name: /save tune/i }).click();
      await waitForTunesList(page);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await expect(page.getByText("E2E EVO Tune")).toBeVisible({ timeout: 10_000 });

      await page.getByText("E2E EVO Tune").first().click();
      await page.getByRole("button", { name: /^edit$/i }).click();
      await expect(page.getByRole("heading", { name: /edit: e2e evo tune/i })).toBeVisible();
      await page.getByLabel("Name").fill("E2E EVO Edited");
      await page.getByRole("button", { name: /save tune/i }).click();
      await page.waitForURL(/\/ac-evo\/setups\/?$/);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await expect(page.getByText("E2E EVO Edited")).toBeVisible();
      await expect(page.getByText("E2E EVO Tune")).toHaveCount(0);

      await page.getByText("E2E EVO Edited").first().click();
      await page.getByRole("button", { name: /duplicate/i }).first().click();
      await expect(page.getByText("E2E EVO Edited (copy)")).toBeVisible({ timeout: 10_000 });

      await page.getByText("E2E EVO Edited (copy)").first().click();
      await page.getByRole("button", { name: /^delete$/i }).first().click();
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
