import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "./seeded-e2e-helpers";

const FM_RECORDING = "fm-2023-2026-04-09T21-55-03-186Z";

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
    await page.goto("/dash", { waitUntil: "domcontentloaded" });
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
  await page.goto("/dash", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Race HUD" })).toHaveAttribute(
    "href",
    "/dash/combo-1",
  );
  await expect(page.getByRole("link", { name: /Lap Times & Pace/ })).toHaveAttribute(
    "href",
    "/dash/combo-2",
  );

  await page.getByRole("link", { name: "Race HUD" }).click();
  await expect(page).toHaveURL(/\/dash\/combo-1$/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/dash\/combo-1$/);
  await expect(page.getByText("Waiting for lap data…", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for tire data…", { exact: true })).toBeVisible();

  await page.goto("/dash");
  await page.getByRole("link", { name: /Lap Times & Pace/ }).click();
  await expect(page).toHaveURL(/\/dash\/combo-2$/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/dash\/combo-2$/);
  await expect(page.getByText("Waiting for track…", { exact: true })).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in dashboard selection flow").toEqual([]);
});

test("dashboard combinations render replay-driven live values", async ({ page, request }) => {
  test.setTimeout(60_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dash/combo-1", { waitUntil: "domcontentloaded" });
  const speedTile = page.getByText("KM/H", { exact: true }).locator("..");
  const observedSpeeds = new Set<string>();
  const replayResponsePromise = request.post(
    `/api/dev/replay/${FM_RECORDING}?packets=240&intervalMs=12`,
  );
  await expect
    .poll(
      async () => {
        observedSpeeds.add(await speedTile.innerText());
        return observedSpeeds.size;
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBeGreaterThan(1);
  const replayResponse = await replayResponsePromise;
  expect(replayResponse.ok()).toBe(true);
  await expect(page.getByText("Waiting for lap data…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Waiting for tire data…", { exact: true })).toHaveCount(0);

  await page.goto("/dash/combo-2", { waitUntil: "domcontentloaded" });
  const secondReplay = request.post(
    `/api/dev/replay/${FM_RECORDING}?packets=120&intervalMs=12`,
  );
  await expect(page.getByText("Waiting for track…", { exact: true })).toHaveCount(0, {
    timeout: 20_000,
  });
  expect((await secondReplay).ok()).toBe(true);
  await expect(page.locator("canvas[data-visual-ready='ready']")).toHaveCount(1);

  expect(browserErrors.errors, "unexpected browser errors in dashboard replay flow").toEqual([]);
});

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
