import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { findNoTelemetryLap } from "./fixtures";

test("Analyse exposes loading and parse-error states", async ({ page, request }) => {
  test.setTimeout(60_000);
  const browserErrors = collectBrowserErrors(page);
  const target = await getSeededLapTarget(request, "fm-2023");
  let releaseLoading!: () => void;
  const loadingGate = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  const telemetryUrl = new RegExp(`/api/laps/${target.id}/semantic-telemetry$`);
  await page.route(telemetryUrl, async (route) => {
    await loadingGate;
    await route.continue();
  });
  await page.goto(`/fm23/analyse?track=${target.trackOrdinal}&car=${target.carOrdinal}&lap=${target.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading lap telemetry...", { exact: true })).toBeVisible();
  releaseLoading();
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
  await page.unroute(telemetryUrl);

  await page.route(telemetryUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        parseError: "seeded-e2e parse failure",
      }),
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("seeded-e2e parse failure", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(browserErrors.errors, "unexpected browser errors in Analyse states").toEqual([]);
});

test("Analyse renders seeded no-telemetry lap state when available", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const emptyLap = await findNoTelemetryLap(request);
  test.skip(!emptyLap, "seed has no FM lap without telemetry");
  if (!emptyLap) return;
  await page.goto(`/fm23/analyse?track=${emptyLap.trackOrdinal}&car=${emptyLap.carOrdinal}&lap=${emptyLap.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("No telemetry data for this lap.", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(browserErrors.errors, "unexpected browser errors in no-telemetry state").toEqual([]);
});
