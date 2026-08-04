import { test, expect } from "@playwright/test";
import { collectBrowserErrors } from "../seeded-e2e-helpers";
import { completeOnboarding, resetTunes, waitForTunesList } from "./helpers";

function validFmSettings() {
  return {
    tires: { frontPressure: 1.9, rearPressure: 1.9 },
    gearing: { finalDrive: 3.5, ratios: [3.5, 2.5, 1.9, 1.5, 1.2, 1], topSpeedKph: 250 },
    alignment: { frontCamber: -1, rearCamber: -0.5, frontToe: 0, rearToe: 0 },
    antiRollBars: { front: 20, rear: 20 },
    springs: { frontRate: 100, rearRate: 100, frontHeight: 10, rearHeight: 10 },
    damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
    aero: { frontDownforce: 100, rearDownforce: 100 },
    differential: { rearAccel: 60, rearDecel: 30 },
    brakes: { balance: 50, pressure: 100 },
  };
}

// Forza's tune schema has a specific TuneSettings shape the server validates,
// so we can't paste arbitrary JSON — create via the structured form instead.
test.describe("Forza Motorsport tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });
  test.afterEach(async ({ page }) => {
    await resetTunes(page);
  });

  test("create, duplicate, and delete a tune via the API + list UI", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
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

    await page.goto("/fm23/setups");
    await waitForTunesList(page);

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
    expect(browserErrors.errors, "unexpected browser errors in FM tune list").toEqual([]);
  });
  test("browser filters, pagination, clone, and refresh preserve persisted tune state", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    try {
      for (let i = 0; i < 12; i += 1) {
        const response = await page.request.post("/api/tunes", {
          data: {
            gameId: "fm-2023",
            name: `E2E FM Bulk ${i}`,
            author: i === 11 ? "E2E Secondary Author" : "E2E Primary Author",
            carOrdinal: i === 11 ? 2861 : 2860,
            trackOrdinal: i === 11 ? 6 : 5,
            category: "circuit",
            settings: validFmSettings(),
          },
        });
        expect(response.ok()).toBeTruthy();
        await response.json();
      }

      await page.goto("/fm23/setups");
      await waitForTunesList(page);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await expect(page.getByText(/1[–-]10 of 12.*page 1\/2/i)).toBeVisible();
      await page.getByRole("button", { name: /next/i }).click();
      await expect(page.getByText(/11[–-]12 of 12.*page 2\/2/i)).toBeVisible();
      await expect(page.getByText("E2E FM Bulk 0")).toBeVisible();
      await page.getByRole("button", { name: /prev/i }).click();

      const authorFilter = page.getByPlaceholder(/search author/i);
      await authorFilter.fill("Secondary Author");
      await expect(page.getByText(/1[–-]1 of 1.*page 1\/1/i)).toBeVisible();
      await expect(page.getByText("E2E FM Bulk 11")).toBeVisible();
      await authorFilter.fill("");

      const setupFilters = page.locator('input[role="combobox"]');
      const trackFilter = setupFilters.nth(0);
      await trackFilter.click();
      const trackOptions = page.getByRole("listbox", { name: "Any track" }).getByRole("option");
      await trackOptions.nth(1).click();
      await expect(page.getByText(/1[–-]10 of 11.*page 1\/2/i)).toBeVisible();
      await trackFilter.click();
      await page.getByRole("listbox", { name: "Any track" }).getByRole("option").first().click();

      const carFilter = setupFilters.nth(1);
      await carFilter.click();
      await page.getByRole("listbox", { name: "Any car" }).getByRole("option").nth(1).click();
      await expect(page.getByText(/1[–-]10 of 11.*page 1\/2/i)).toBeVisible();

      const refreshResponse = page.waitForResponse(
        (response) => response.url().includes("/api/tunes/community/refresh") && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: /refresh/i }).click();
      expect((await refreshResponse).ok()).toBeTruthy();

      await page.goto("/fm23/setups");
      await waitForTunesList(page);
      await page.getByRole("button", { name: /^community$/i }).click();
      const communityRow = page.locator("tbody tr").first();
      if (await communityRow.count()) {
        await communityRow.click();
        const cloneButton = page.getByRole("button", { name: /clone/i }).first();
        await expect(cloneButton).toBeVisible();
        await cloneButton.click();
        await page.getByRole("button", { name: /^yours$/i }).click();
        await expect(async () => {
          const response = await page.request.get("/api/tunes?gameId=fm-2023");
          const payload: unknown = await response.json();
          if (!Array.isArray(payload)) throw new Error("Expected tune list response");
          const rows = payload.filter((row): row is { source?: string } => typeof row === "object" && row !== null);
          expect(rows.some((row) => row.source === "catalog-clone")).toBeTruthy();
        }).toPass({ timeout: 10_000 });
      }
    } finally {
      await resetTunes(page);
    }
    expect(browserErrors.errors, "unexpected browser errors in FM tune browser").toEqual([]);
  });

  test("browser edit, JSON import, and required-name validation persist state", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    try {
      const response = await page.request.post("/api/tunes", {
        data: {
          gameId: "fm-2023",
          name: "E2E FM Editable",
          author: "E2E Editor",
          carOrdinal: 2860,
          category: "circuit",
          settings: validFmSettings(),
        },
      });
      expect(response.ok()).toBeTruthy();

      await page.goto("/fm23/setups");
      await waitForTunesList(page);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await page.getByText("E2E FM Editable").click();
      await page.getByRole("button", { name: /^edit$/i }).click();
      await expect(page.getByRole("heading", { name: /edit: e2e fm editable/i })).toBeVisible();
      await page.getByRole("button", { name: /^info$/i }).click();
      await page.getByLabel("Name").fill("E2E FM Edited");
      await page.getByRole("button", { name: /save tune/i }).click();
      await page.waitForURL(/\/fm23\/setups\/?$/);
      await page.getByRole("button", { name: /^yours$/i }).click();
      await expect(page.getByText("E2E FM Edited")).toBeVisible();
      await expect(page.getByText("E2E FM Editable")).toHaveCount(0);

      const importedPayload = {
        name: "E2E FM Imported",
        author: "E2E Importer",
        carOrdinal: 2860,
        category: "circuit",
        settings: validFmSettings(),
      };
      const fileInput = page.locator('input[type="file"][accept=".json,application/json"]');
      await fileInput.setInputFiles({
        name: "e2e-import.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(importedPayload)),
      });
      await expect(async () => {
        const listResponse = await page.request.get("/api/tunes?gameId=fm-2023");
        const payload: unknown = await listResponse.json();
        if (!Array.isArray(payload)) throw new Error("Expected tune list response");
        const rows = payload.filter((row): row is { name: string } => typeof row === "object" && row !== null && typeof row.name === "string");
        expect(rows.map((row) => row.name)).toContain("E2E FM Imported");
      }).toPass({ timeout: 10_000 });
      await expect(page.getByText("E2E FM Imported")).toBeVisible();

      await page.goto("/fm23/setups/new");
      await expect(page.getByRole("heading", { name: /create new tune/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /save tune/i })).toBeDisabled();
      await page.getByRole("button", { name: /^info$/i }).click();
      await expect(page.getByLabel("Name")).toHaveValue("");
      await expect(page.getByRole("button", { name: /save tune/i })).toBeDisabled();
    } finally {
      await resetTunes(page);
    }
    expect(browserErrors.errors, "unexpected browser errors in FM tune CRUD").toEqual([]);
  });
});
