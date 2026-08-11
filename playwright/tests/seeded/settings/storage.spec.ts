import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("storage renders true-empty and recovers from controlled API error", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.route("**/api/storage/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 0,
        binCount: 0,
        gzCount: 0,
        totalBytes: 0,
        binBytes: 0,
        gzBytes: 0,
        byGame: {},
        diskTotal: 0,
        diskFree: 0,
      }),
    });
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await expect(page.getByText("No recording files yet.")).toBeVisible();

    await page.unroute("**/api/storage/sessions");
    await page.route("**/api/storage/sessions", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "seeded failure" }) });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Failed to load storage stats." })).toBeVisible();

    await page.unroute("**/api/storage/sessions");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await expect(page.getByText("Total size")).toBeVisible();
    expect(
      browserErrors.errors.filter(
        (error) => !error.includes("/api/storage/sessions") && error !== "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
      ),
    ).toEqual([]);
  } finally {
    await page.unroute("**/api/storage/sessions");
  }
});
