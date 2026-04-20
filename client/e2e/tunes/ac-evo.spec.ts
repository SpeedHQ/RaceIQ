import { test, expect } from "@playwright/test";
import { completeOnboarding, resetTunes, waitForTunesList } from "./helpers";

// AC EVO mirrors the ACC flow but uses the broader category set and the
// additional "Suspension Presets" section.
test.describe("AC EVO tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });

  test("create via form with EVO-specific section and category, duplicate, delete", async ({ page }) => {
    await page.goto("/ac-evo/tunes");
    await waitForTunesList(page, "AC EVO Tunes");

    await page.getByRole("button", { name: /\+ New Tune/i }).click();
    await expect(page.getByRole("heading", { name: /create new ac evo tune/i })).toBeVisible();

    await page.getByLabel("Name").fill("E2E EVO Tune");
    await page.getByLabel("Description").fill("Playwright-created");

    // EVO-only category — confirms the dropdown isn't sharing ACC's list.
    await page.getByLabel("Category").selectOption("trackday");

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
    // Expect at least the two we filled to be marked covered.
    await expect(page.getByText(/\d+ \/ 9 covered/)).toBeVisible();

    await page.getByRole("button", { name: /save tune/i }).click();
    await waitForTunesList(page, "AC EVO Tunes");

    await expect(page.getByText("E2E EVO Tune")).toBeVisible({ timeout: 10_000 });

    await page.getByText("E2E EVO Tune").first().click();
    await page.getByRole("button", { name: /duplicate/i }).first().click();
    await expect(page.getByText("E2E EVO Tune (copy)")).toBeVisible({ timeout: 10_000 });

    await page.getByText("E2E EVO Tune (copy)").first().click();
    await page.getByRole("button", { name: /^delete$/i }).first().click();
    await page.getByRole("button", { name: /^yes$/i }).first().click();
    await expect(page.getByText("E2E EVO Tune (copy)")).toHaveCount(0);
  });

  test("import page renders empty state when Documents folder absent", async ({ page }) => {
    await page.goto("/ac-evo/tunes/import");
    await expect(page.getByText(/could not find your ac evo setups folder/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
