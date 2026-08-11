import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("live dashboard mode toggle exposes selected route and no-data guide state", async ({ page }) => {
  test.setTimeout(60_000);
  const browserErrors = collectBrowserErrors(page);
  await page.routeWebSocket("**/ws", () => {});
  await page.goto("/fm23/live/driver", { waitUntil: "domcontentloaded" });
  const dashboardModes = page.getByRole("main");
  const driverLink = dashboardModes.getByRole("link", { name: "Driver", exact: true });
  const pitLink = dashboardModes.getByRole("link", { name: "Pit Crew", exact: true });
  await expect(driverLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Waiting for telemetry", { exact: false })).toBeVisible();
  const guide = page.getByRole("button", { name: /How to enable Data Out/ });
  await expect(guide).toHaveAttribute("aria-expanded", "false");
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "true");

  await pitLink.click();
  await expect(page).toHaveURL(/\/fm23\/live\/pit$/);
  await expect(pitLink).toHaveAttribute("aria-current", "page");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/fm23\/live\/pit$/);
  await expect(pitLink).toHaveAttribute("aria-current", "page");

  expect(browserErrors.errors, "unexpected browser errors in live dashboard mode flow").toEqual([]);
});
