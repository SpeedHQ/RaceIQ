import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { sessionsFor } from "./helpers";

test("sessions loading and API error states remain visible", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const seeded = await sessionsFor(request, "fm-2023");
  let releaseLoading!: () => void;
  const loading = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/sessions" || url.searchParams.get("gameId") !== "fm-2023") return route.continue();
    await loading;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(seeded) });
  });
  const navigation = page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading...", { exact: true }).last()).toBeVisible();
  releaseLoading();
  await navigation;
  await page.unroute("**/api/sessions**");
  expect(browserErrors.errors).toEqual([]);

  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/sessions" || url.searchParams.get("gameId") !== "fm-2023") return route.continue();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "seeded e2e outage" }) });
  });
  const errorPageErrors = collectBrowserErrors(page);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert").filter({ hasText: "Error" })).toBeVisible();
  expect(
    errorPageErrors.errors.filter((error) => error !== "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)" && !error.startsWith("http 503:")),
  ).toEqual([]);
  await page.unroute("**/api/sessions**");
});
