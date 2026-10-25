import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "raceiq-e2e/test-support/browser-errors";
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
