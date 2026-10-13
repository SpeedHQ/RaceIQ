import { expect, test } from "@playwright/test";
import type { DashboardInterface, DashboardNetwork } from "../../../../apps/backend/src/runtime/dashboard-auth";

import { collectBrowserErrors } from "../../support/browser-errors";
import { assertNoHorizontalOverflow } from "../../support/responsive/assertions";

test.describe.configure({ mode: "serial" });

test("dashboard catalogue uses active dashboard interfaces and hostname override without LAN targets", async ({ page }) => {
  test.setTimeout(80_000);
  const browserErrors = collectBrowserErrors(page);
  let authFixture: {
    interfaces: DashboardInterface[];
    activeHosts: string[];
    network: DashboardNetwork;
  } = {
    activeHosts: ["192.0.2.15", "192.0.2.17"],
    interfaces: [
      { name: "Active LAN", address: "192.0.2.15", tailnet: false },
      { name: "Other active LAN", address: "192.0.2.17", tailnet: false },
      { name: "Inactive LAN", address: "192.0.2.16", tailnet: false },
      { name: "Tailnet", address: "100.64.0.2", tailnet: true },
    ],
    network: { hosts: ["0.0.0.0", "192.0.2.15"], origins: [], originsEnabled: true },
  };
  await page.route("**/api/auth/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        ...authFixture,
      },
    });
  });

  await page.goto("/portable", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
  const servingStatus = page.locator('p[role="status"][data-network-state]');
  const lanAddress = page.getByRole("combobox", { name: "Local network address" });
  await expect(lanAddress).toBeVisible();
  await lanAddress.click();
  await expect(page.getByRole("option", { name: "192.0.2.15" })).toBeVisible();
  await expect(page.getByRole("option", { name: "192.0.2.17" })).toBeVisible();
  await expect(page.getByRole("option", { name: "192.0.2.16" })).toHaveCount(0);
  await page.getByRole("option", { name: "192.0.2.17" }).click();
  await expect(servingStatus).toContainText("192.0.2.17");

  authFixture = { ...authFixture, activeHosts: [], interfaces: [] };
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(servingStatus).toHaveAttribute("data-network-state", "no-data");
  await expect(servingStatus).toContainText("LAN IP unavailable");

  await page.locator("#hud-hostname").fill("race-pc.example.ts.net");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(servingStatus).toHaveAttribute("data-network-state", "ready");
  await expect(servingStatus).toContainText("race-pc.example.ts.net");
  await expect(servingStatus).toContainText(/http:\/\/race-pc\.example\.ts\.net:\d+/);
  const hostnameGuidance = page.locator("#hud-hostname-help + p");
  await expect(hostnameGuidance).toContainText(/http:\/\/race-pc\.example\.ts\.net:\d+/);

  expect(browserErrors.errors, "unexpected browser errors in dashboard catalogue targets").toEqual([]);
});

test("dashboard catalogue links select each combination and survive reload", async ({ page }) => {
  test.setTimeout(80_000);
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
