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

  const rawResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ac-evo/debug/raw");
  await page.getByRole("button", { name: /struct fields/i }).click();
  expect((await rawResponse).status()).toBe(503);
  await expect(page.getByText(/Page sizes:|Error:/)).toBeVisible({ timeout: 10_000 });

  const verifyResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ac-evo/debug/verify");
  await page.getByRole("button", { name: /verify/i }).click();
  expect((await verifyResponse).status()).toBe(503);
  await expect(page.getByText(/Every field:|Error:/)).toBeVisible({ timeout: 10_000 });

  const hexResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ac-evo/debug/hex");
  await page.getByRole("button", { name: /raw hex/i }).click();
  expect((await hexResponse).status()).toBe(503);
  for (const dataPage of ["physics", "graphics", "staticData"]) {
    await expect(page.getByRole("button", { name: dataPage, exact: true })).toBeVisible();
    await page.getByRole("button", { name: dataPage, exact: true }).click();
  }
  const nativeUnavailableConsole = "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
  // Assert the actual HTTP outcomes above; Chromium may deduplicate console
  // messages or deliver them after the corresponding response event.
  const unexpectedErrors = browserErrors.errors.filter((error) => error !== nativeUnavailableConsole && !/^http 503: .*\/api\/ac-evo\/debug\/(raw|verify|hex)$/.test(error));
  expect(unexpectedErrors, "unexpected AC Evo raw browser errors").toEqual([]);

  await page.getByRole("button", { name: /parsed packet/i }).click();
  await expect(page.getByText(/All Telemetry Values|Waiting for telemetry data/)).toBeVisible();
});
