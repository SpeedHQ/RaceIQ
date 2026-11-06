import { expect, test } from "@playwright/test";
import type { LMUCatalogueCar } from "@raceiq/cars-catalogue/contracts";
import { collectBrowserErrors } from "raceiq-e2e/test-support/browser-errors";

test("Le Mans Ultimate cars preserve search and class filtering through the real API", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const response = await request.get("/api/cars", { headers: { "X-Game-Id": "lmu" } });
  expect(response.status()).toBe(200);
  const cars: LMUCatalogueCar[] = await response.json();
  await page.goto("/lmu/cars", { waitUntil: "domcontentloaded" });
  const cards = page.getByRole("article");
  const search = page.getByRole("searchbox");
  await expect(search).toBeVisible();
  await expect(cards).toHaveCount(cars.length);
  await search.fill("definitely-no-catalogue-car");
  await expect(cards).toHaveCount(0);
  await search.fill("");
  await expect(cards).toHaveCount(cars.length);
  const category = page.locator("button[data-catalog-category]").first();
  await expect(category).toBeVisible();
  const carClass = await category.getAttribute("data-catalog-category");
  await category.click();
  await expect(category).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(cars.filter((car) => car.class === carClass).length);
  await category.click();
  await expect(category).toHaveAttribute("aria-pressed", "false");
  await expect(cards).toHaveCount(cars.length);
  expect(browserErrors.errors).toEqual([]);
});
