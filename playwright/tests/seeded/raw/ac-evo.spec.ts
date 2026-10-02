import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../../support/browser-errors";

test.describe.configure({ mode: "serial" });
test("Assetto Corsa EVO raw exposes parsed, fields, verify, hex, and data tabs", async ({ page }) => {
  test.setTimeout(45_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/ac-evo/raw", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: /parsed packet/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /struct fields/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /verify/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /raw hex/i })).toBeVisible();

  await page.getByRole("button", { name: /struct fields/i }).click();
  await expect(page.getByText(/Page sizes:|Error:/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByText(/Every field:|Error:/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /raw hex/i }).click();
  for (const dataPage of ["physics", "graphics", "staticData"]) {
    await expect(page.getByRole("button", { name: dataPage, exact: true })).toBeVisible();
    await page.getByRole("button", { name: dataPage, exact: true }).click();
  }
  const nativeUnavailableConsole = "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
  expect(
    browserErrors.errors.filter((error) => error === nativeUnavailableConsole),
    "each native AC Evo debug endpoint reports its expected 503",
  ).toHaveLength(3);
  const unexpectedErrors = browserErrors.errors.filter((error) => error !== nativeUnavailableConsole && !/^http 503: .*\/api\/ac-evo\/debug\/(raw|verify|hex)$/.test(error));
  expect(unexpectedErrors, "unexpected AC Evo raw browser errors").toEqual([]);

  await page.getByRole("button", { name: /parsed packet/i }).click();
  await expect(page.getByText(/All Telemetry Values|Waiting for telemetry data/)).toBeVisible();
});
