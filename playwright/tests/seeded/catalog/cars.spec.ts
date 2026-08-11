import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";

const CAR_CAPABILITY = {
  "fm-2023": { catalog: "forza", search: true, compare: true, classFilter: true, drivetrainFilter: true },
  "f1-2025": { catalog: "f1", viewModes: true },
  acc: { catalog: "acc", classFilter: true },
  "ac-evo": { catalog: "ac-evo", classFilter: true },
  iracing: { catalog: "iracing", search: true, categoryFilter: true },
} as const;

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} cars expose explicit catalog interactions`, async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    const capability = CAR_CAPABILITY[game.gameId];
    await page.goto(`/${game.prefix}/cars`, { waitUntil: "domcontentloaded" });

    if (capability.catalog === "forza") {
      const search = page.getByPlaceholder("Search name, division, engine...");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("definitely-no-seeded-car");
      await expect(page.getByText("No cars match filters", { exact: true })).toBeVisible();
      await search.fill("");
      await page.getByRole("button", { name: "RWD", exact: true }).click();
      await expect(page.getByRole("button", { name: "RWD", exact: true })).toHaveClass(/bg-app-accent\/20/);
      const cards = page.locator('[role="button"]').filter({ has: page.locator('input[type="checkbox"]') });
      await expect(cards.first()).toBeVisible();
      await cards.first().focus();
      await cards.first().press("Enter");
      const detail = page.getByRole("dialog");
      await expect(detail).toBeVisible();
      const model3d = detail.getByTitle("View 3D model");
      if (await model3d.count()) {
        await expect(model3d).toBeVisible();
        await expect(page).toHaveURL(/\/cars$/);
      }
      await detail.getByRole("button", { name: "Close" }).click();
      await cards.nth(0).locator('input[type="checkbox"]').check();
      await cards.nth(1).locator('input[type="checkbox"]').check();
      await page.getByRole("button", { name: "Compare (2)" }).click();
      await expect(page.getByRole("heading", { name: "Compare Cars" })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Clear" }).click();
      await page.getByTitle("Table view").click();
      const piHeader = page.getByRole("columnheader", { name: "PI" });
      await piHeader.click();
      await expect(piHeader).toHaveAttribute("aria-sort", /ascending|descending/);
      await expect(page.locator("tbody tr").first()).toBeVisible();
      await page.getByTitle("Grid view").click();
    } else if (capability.catalog === "f1") {
      await expect(page.getByRole("heading", { name: "Power Unit Suppliers" })).toBeVisible();
      await page.getByTitle("Table view").click();
      await expect(page.locator("tbody tr").first()).toBeVisible();
      await page.getByTitle("Grid view").click();
      await expect(page.getByRole("img", { name: "Red Bull Racing RB21" })).toBeVisible();
    } else if (capability.catalog === "iracing") {
      const search = page.getByPlaceholder("Search name, division, engine...");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("definitely-no-seeded-car");
      await expect(page.getByText("No cars match filters", { exact: true })).toBeVisible();
      await search.fill("");
      const category = page.locator("button[data-catalog-category]").first();
      await expect(category).toBeVisible();
      await category.click();
      await expect(category).toHaveAttribute("aria-pressed", "true");
    } else {
      const category = page.locator("button[data-catalog-category]").first();
      await expect(category).toBeVisible({ timeout: 20_000 });
      await category.click();
      await expect(category).toHaveAttribute("aria-pressed", "true");
    }
    expect(browserErrors.errors, `${game.name} cars browser errors`).toEqual([]);
  });
}
