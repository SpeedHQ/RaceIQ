import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("shared live routes resolve without game-specific URL prefixes", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.routeWebSocket("**/ws", () => {});
  await page.goto("/live", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/live$/);
  await expect(page.getByRole("main")).toBeVisible();

  await page.goto("/live/pit", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/live\/pit$/);
  await expect(page.getByRole("main")).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in shared live routes").toEqual([]);
});
