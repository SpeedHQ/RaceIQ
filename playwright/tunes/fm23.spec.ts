import { test, expect } from "@playwright/test";
import { completeOnboarding, resetTunes, waitForTunesList } from "./helpers";

// Forza's tune schema has a specific TuneSettings shape the server validates,
// so we can't paste arbitrary JSON — create via the structured form instead.
test.describe("Forza Motorsport tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });

  test("create, duplicate, and delete a tune via the API + list UI", async ({ page }) => {
    // Seed through the API so we don't have to drive the 2-tab Forza form —
    // the duplicate button is what the user actually wants visible.
    const createRes = await page.request.post("/api/tunes", {
      data: {
        gameId: "fm-2023",
        name: "E2E Forza Tune",
        author: "Playwright",
        carOrdinal: 2860,
        category: "circuit",
        description: "Created by Playwright",
        settings: {
          tires: { frontPressure: 1.9, rearPressure: 1.9 },
          gearing: { finalDrive: 3.5 },
          alignment: { frontCamber: -1, rearCamber: -0.5, frontToe: 0, rearToe: 0 },
          antiRollBars: { front: 20, rear: 20 },
          springs: { frontRate: 100, rearRate: 100, frontHeight: 10, rearHeight: 10 },
          damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
          aero: { frontDownforce: 100, rearDownforce: 100 },
          differential: { rearAccel: 60, rearDecel: 30 },
          brakes: { balance: 50, pressure: 100 },
        },
      },
    });
    expect(createRes.ok()).toBeTruthy();

    await page.goto("/fm23/tunes");
    await waitForTunesList(page, "Tunes");

    // FM23 shows community + user tunes together, sorted by lap time.
    // The test tune has no lap time so it sinks to page 2+. Click the "Yours"
    // source tab to isolate it before asserting visibility.
    await page.getByRole("button", { name: /^yours$/i }).click();

    const card = page.getByText("E2E Forza Tune").first();
    await expect(card).toBeVisible();
    await card.click();

    await page.getByRole("button", { name: /duplicate/i }).first().click();
    await expect(page.getByText("E2E Forza Tune (copy)")).toBeVisible({ timeout: 10_000 });

    // Two cards present now — delete the copy via the row action.
    await page.getByText("E2E Forza Tune (copy)").first().click();
    await page.getByRole("button", { name: /^delete$/i }).first().click();
    await page.getByRole("button", { name: /^yes$/i }).first().click();
    await expect(page.getByText("E2E Forza Tune (copy)")).toHaveCount(0);
  });
});
