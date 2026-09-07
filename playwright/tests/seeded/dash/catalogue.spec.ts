import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { assertNoHorizontalOverflow } from "../../support/responsive/assertions";

test.describe.configure({ mode: "serial" });

test("dashboard catalogue exposes loading, no-data, and error network states", async ({ page }) => {
  test.setTimeout(60_000);
  const browserErrors = collectBrowserErrors(page);
  let releaseLoading!: () => void;
  const loadingResponse = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });

  await page.route("**/api/network/info", async (route) => {
    await loadingResponse;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ lanIps: [], port: 3000 }),
    });
  });

  try {
    await page.goto("/portable", { waitUntil: "domcontentloaded" });
    const status = page.locator('p[role="status"]');
    await expect(status).toHaveAttribute("data-network-state", "loading");
    await expect(status).toContainText("Loading");
    releaseLoading();
    await expect(status).toHaveAttribute("data-network-state", "no-data");
    await expect(status).toContainText("LAN IP unavailable");
    await page.unroute("**/api/network/info");

    await page.route("**/api/network/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{",
      }),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(status).toHaveAttribute("data-network-state", "error");
    await expect(status).toContainText("LAN IP unavailable");
  } finally {
    releaseLoading();
    await page.unroute("**/api/network/info");
  }

  expect(browserErrors.errors, "unexpected browser errors in dashboard catalogue states").toEqual([]);
});

test("dashboard catalogue links select each combination and survive reload", async ({ page }) => {
  test.setTimeout(60_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/portable", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Race HUD" })).toHaveAttribute("href", "/portable/combo-1");
  await expect(page.getByRole("link", { name: /Lap Times & Pace/ })).toHaveAttribute("href", "/portable/combo-2");

  await page.getByRole("link", { name: "Race HUD" }).click();
  await expect(page).toHaveURL(/\/portable\/combo-1$/);
  await expect(page.getByRole("heading", { name: /"?Dashboards"?/ }))
    .not.toBeVisible({ timeout: 1_000 })
    .catch(() => void 0);
  await expect(page.getByText(/KM\/H|MPH/)).toBeVisible({ timeout: 20_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/portable\/combo-1$/);
  await expect(page.getByText("Waiting for lap data…", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for tire data…", { exact: true })).toBeVisible();

  await page.goto("/portable");
  await page.getByRole("link", { name: /Lap Times & Pace/ }).click();
  await expect(page).toHaveURL(/\/portable\/combo-2$/);
  await expect(page.getByRole("heading", { name: /"?Dashboards"?/ }))
    .not.toBeVisible({ timeout: 1_000 })
    .catch(() => void 0);
  await expect(page.getByText("Complete a lap to see lap times", { exact: true })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/portable\/combo-2$/);
  await expect(page.getByText("Complete a lap to see lap times", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for track…", { exact: true })).toBeVisible();
  await page.goto("/portable");
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in dashboard selection flow").toEqual([]);
});

test("dash responsive accessibility and no overflow on catalogue and combo routes", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const viewports = [
    { width: 360, height: 780 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ];
  const routes = ["/portable", "/portable/combo-1", "/portable/combo-2"];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);

    for (const path of routes) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-responsive-workspace]")).toHaveCount(1);
      await expect(page.locator("[data-responsive-workspace]")).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await expect(page.getByText(/Desktop required/i)).toHaveCount(0);
      await expect(page.getByText(/Rotate your device/i)).toHaveCount(0);

      if (path === "/portable") {
        await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Race HUD" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Lap Times & Pace" })).toBeVisible();
      }

      if (path === "/portable/combo-1") {
        await expect(page.getByText(/KM\/H|MPH/)).toBeVisible({ timeout: 20_000 });
      }

      if (path === "/portable/combo-2") {
        await expect(page.getByText(/^(?:Waiting for track…|No completed laps yet)$/)).toBeVisible({ timeout: 20_000 });
      }
    }
  }

  expect(browserErrors.errors, "unexpected browser errors in dash responsive accessibility flow").toEqual([]);
});
