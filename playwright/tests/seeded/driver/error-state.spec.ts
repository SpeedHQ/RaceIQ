import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("Driver profile presents deterministic API error state", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.route("**/api/drivers/profile*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "seeded profile failure" }) }));
  try {
    await page.goto("/f125/driver", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Measured profile unavailable.", { exact: true })).toBeVisible();
  } finally {
    await page.unroute("**/api/drivers/profile*");
  }
  const expectedResourceError = "console.error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
  expect(
    browserErrors.errors.filter((error) => error !== expectedResourceError && !/^http 500: .*\/api\/drivers\/profile\?/.test(error)),
    "unexpected browser errors in Driver error state",
  ).toEqual([]);
});
