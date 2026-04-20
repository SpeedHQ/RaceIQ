import { test, expect } from "@playwright/test";
import { completeOnboarding, resetTunes, waitForTunesList } from "./helpers";

// ACC's setup JSON is arbitrary (server does not validate its internal shape),
// so the form's JSON paste + duplicate flow can be exercised end-to-end
// without a real setup file.
test.describe("ACC tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });

  test("create via form, see covered sections, duplicate, delete", async ({ page }) => {
    await page.goto("/acc/tunes");
    await waitForTunesList(page, "ACC Tunes");

    await page.getByRole("button", { name: /\+ New Tune/i }).click();
    await expect(page.getByRole("heading", { name: /create new acc tune/i })).toBeVisible();

    await page.getByLabel("Name").fill("E2E ACC Tune");
    await page.getByLabel("Description").fill("Playwright-created");

    // Populate every ACC tunable section so the "covered" counter hits 8/8.
    const setupJson = {
      basicSetup: {
        tyres: { tyreCompound: 0, tyrePressure: [26, 26, 26, 26] },
        alignment: { camber: [1, 1, 1, 1], toe: [0, 0, 0, 0], casterLF: 30, casterRF: 30, steerRatio: 6 },
        electronics: { tC1: 5, tC2: 5, abs: 3, ecuMap: 2, fuelMix: 1, telemetryLaps: 3 },
        strategy: { fuel: 30, tyreSet: 1, frontBrakePadCompound: 1, rearBrakePadCompound: 1, pitStrategy: [] },
      },
      advancedSetup: {
        mechanicalBalance: { aRBFront: 4, aRBRear: 4, brakeTorque: 80, brakeBias: 55, steerRatio: 6, wheelRate: [0, 0, 0, 0] },
        dampers: { bumpSlow: [5, 5, 5, 5], bumpFast: [5, 5, 5, 5], reboundSlow: [5, 5, 5, 5], reboundFast: [5, 5, 5, 5] },
        aeroBalance: { rideHeight: [55, 55], splitter: 1, rearWing: 6, brakeDuct: [3, 3] },
        drivetrain: { preload: 6 },
      },
    };
    await page.getByLabel("Setup JSON").fill(JSON.stringify(setupJson, null, 2));
    await expect(page.getByText(/8 \/ 8 covered/)).toBeVisible();

    await page.getByRole("button", { name: /save tune/i }).click();
    await waitForTunesList(page, "ACC Tunes");

    await expect(page.getByText("E2E ACC Tune")).toBeVisible({ timeout: 10_000 });

    await page.getByText("E2E ACC Tune").first().click();
    await page.getByRole("button", { name: /duplicate/i }).first().click();
    await expect(page.getByText("E2E ACC Tune (copy)")).toBeVisible({ timeout: 10_000 });

    await page.getByText("E2E ACC Tune (copy)").first().click();
    await page.getByRole("button", { name: /^delete$/i }).first().click();
    await page.getByRole("button", { name: /^yes$/i }).first().click();
    await expect(page.getByText("E2E ACC Tune (copy)")).toHaveCount(0);
  });

  test("import page renders empty state when Documents folder absent", async ({ page }) => {
    await page.goto("/acc/tunes/import");
    // Test DB has no mocked Documents folder — we expect the "not found" UI.
    await expect(page.getByText(/could not find your acc setups folder/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
