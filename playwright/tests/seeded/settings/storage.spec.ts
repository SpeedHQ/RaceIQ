import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("storage renders true-empty and recovers from controlled API error", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.route("**/api/storage/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 0,
        binCount: 0,
        gzCount: 0,
        totalBytes: 0,
        binBytes: 0,
        gzBytes: 0,
        byGame: {},
        diskTotal: 0,
        diskFree: 0,
      }),
    });
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await page.getByRole("tab", { name: "Storage" }).click();
    await expect(page.getByText("No recording files yet.")).toBeVisible();

    await page.unroute("**/api/storage/sessions");
    await page.route("**/api/storage/sessions", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "seeded failure" }) });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await page.getByRole("tab", { name: "Storage" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Failed to load storage stats." })).toBeVisible();

    await page.unroute("**/api/storage/sessions");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await page.getByRole("tab", { name: "Storage" }).click();
    await expect(page.getByText("Total size")).toBeVisible();
    expect(
      browserErrors.errors.filter(
        (error) => !error.includes("/api/storage/sessions") && error !== "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
      ),
    ).toEqual([]);
  } finally {
    await page.unroute("**/api/storage/sessions");
  }
});

test("compression conflict is announced and can be retried", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/storage/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 1,
        binCount: 1,
        gzCount: 0,
        totalBytes: 1024,
        binBytes: 1024,
        gzBytes: 0,
        byGame: {},
        diskTotal: 0,
        diskFree: 0,
      }),
    });
  });
  await page.route("**/api/storage/compress", async (route) => {
    attempts++;
    await route.fulfill({
      status: attempts === 1 ? 409 : 200,
      contentType: "application/json",
      body: JSON.stringify(attempts === 1
        ? { code: "MOVE_ACTIVE", error: "Recording storage operation is active" }
        : { ok: true }),
    });
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Storage" }).click();
    await page.getByRole("tab", { name: "Storage" }).click();
    const compress = page.getByRole("button", { name: "Compress now" });
    await expect(compress).toBeVisible();
    await compress.click();
    await expect(page.getByRole("alert")).toContainText("Recording storage operation is active");
    await expect(compress).toBeEnabled();
    await compress.click();
    await expect(page.getByText("Compression complete")).toBeVisible();
    expect(attempts).toBe(2);
  } finally {
    await page.unroute("**/api/storage/sessions");
    await page.unroute("**/api/storage/compress");
  }
});

test("storage and cache totals refresh while settings stay open", async ({ page }) => {
  await page.clock.install();
  let cacheRequests = 0;
  let storageRequests = 0;
  await page.route("**/api/cache/status", async (route) => {
    cacheRequests++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bytesUsed: cacheRequests * 1024, maxBytes: 1024 * 1024, entries: cacheRequests }),
    });
  });
  await page.route("**/api/storage/sessions", async (route) => {
    storageRequests++;
    const totalBytes = storageRequests * 1024;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 1,
        binCount: 1,
        gzCount: 0,
        totalBytes,
        binBytes: totalBytes,
        gzBytes: 0,
        byGame: {},
        diskTotal: 0,
        diskFree: 0,
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Storage" }).click();
  await expect(page.getByText("1.0 KB / 1.0 MB")).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(page.getByText("2.0 KB / 1.0 MB")).toBeVisible();

  await page.getByRole("tab", { name: "Storage" }).click();
  await expect(page.getByText("1.0 KB", { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.getByText("2.0 KB", { exact: true }).first()).toBeVisible();
});

test("LMU opponent recording defaults on and persists keyboard changes on desktop and mobile", async ({ page, request }) => {
  const errors = collectBrowserErrors(page);
  const response = await request.get("/api/settings");
  expect(response.ok()).toBe(true);
  const original = await response.json() as { recordLmuOpponents: boolean };
  expect(original.recordLmuOpponents).toBe(true);
  const openStorage = async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      const status = await (await request.get("/api/sessions/classification-migration-status")).json();
      return status.pending + status.running;
    }, { timeout: 60_000 }).toBe(0);
    await expect(page.getByRole("button", { name: /^(Open navigation|Settings)$/ }).filter({ visible: true }).first()).toBeVisible();
    const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
    if (await navigation.isVisible()) await navigation.click();
    await page.locator('button[data-slot="button"][aria-label="Settings"]').filter({ visible: true }).click();
    await expect(page.getByRole("button", { name: /^(Open settings menu|Storage)$/ }).filter({ visible: true }).first()).toBeVisible();
    const settingsMenu = page.getByRole("button", { name: "Open settings menu", exact: true });
    if (await settingsMenu.isVisible()) await settingsMenu.click();
    await page.getByRole("button", { name: "Storage", exact: true }).click();
    await page.getByRole("tab", { name: "Storage", exact: true }).click();
  };
  try {
    for (const [enabled, viewport] of [
      [false, { width: 1440, height: 900 }],
      [true, { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await openStorage();
      const preference = page.getByRole("switch", { name: "Record opponent data (LMU)" });
      await expect(preference).toBeChecked({ checked: !enabled });
      await expect(preference).toBeEnabled();
      await preference.focus();
      await page.keyboard.press("Space");
      await expect(preference).toBeChecked({ checked: enabled });
      expect(await (await request.get("/api/settings")).json()).toMatchObject({ recordLmuOpponents: !enabled });
      const saved = page.waitForResponse((result) => result.url().endsWith("/api/settings") && result.request().method() === "PUT");
      await page.locator("fieldset").filter({ has: preference }).getByRole("button", { name: "Save", exact: true }).click();
      expect((await saved).ok()).toBe(true);
      await openStorage();
      await expect(preference).toBeChecked({ checked: enabled });
      expect(await (await request.get("/api/settings")).json()).toMatchObject({ recordLmuOpponents: enabled });
    }
    expect(errors.errors).toEqual([]);
  } finally {
    const restored = await request.put("/api/settings", { data: { recordLmuOpponents: original.recordLmuOpponents } });
    expect(restored.ok()).toBe(true);
  }
});
