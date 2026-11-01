import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { collectBrowserErrors } from "raceiq-e2e/test-support/browser-errors";

async function openOpponentSettings(page: Page, request: APIRequestContext) {
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
  await page.getByRole("tab", { name: "Opponent data", exact: true }).click();
}

test("LMU opponent recording defaults on and persists keyboard changes on desktop and mobile", async ({ page, request }) => {
  const errors = collectBrowserErrors(page);
  const response = await request.get("/api/settings");
  expect(response.ok()).toBe(true);
  const original = await response.json() as {
    recordLmuOpponents: boolean;
    recordingFrequencyHz: number;
    sessionDownsampleFrequencyHz: number;
  };
  expect(original.recordLmuOpponents).toBe(true);
  try {
    for (const [enabled, viewport] of [
      [false, { width: 1440, height: 900 }],
      [true, { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await openOpponentSettings(page, request);
      const preference = page.getByRole("switch", { name: "Record opponent data (LMU)" });
      const controls = page.locator("fieldset").filter({ has: preference });
      const save = controls.getByRole("button", { name: "Save", exact: true });
      await expect(controls.getByText("Changes apply to the next recording session.", { exact: true })).toBeVisible();
      await expect(save).toBeDisabled();
      await expect(preference).toBeChecked({ checked: !enabled });
      await expect(preference).toBeEnabled();
      await preference.focus();
      await page.keyboard.press("Space");
      await expect(preference).toBeChecked({ checked: enabled });
      expect(await (await request.get("/api/settings")).json()).toMatchObject({ recordLmuOpponents: !enabled });
      const saved = page.waitForResponse((result) => result.url().endsWith("/api/settings") && result.request().method() === "PUT");
      await save.click();
      const result = await saved;
      expect(result.ok()).toBe(true);
      expect(result.request().postDataJSON()).toEqual({ recordLmuOpponents: enabled });
      await expect(save).toBeDisabled();
      await openOpponentSettings(page, request);
      await expect(preference).toBeChecked({ checked: enabled });
      expect(await (await request.get("/api/settings")).json()).toMatchObject({
        recordLmuOpponents: enabled,
        recordingFrequencyHz: original.recordingFrequencyHz,
        sessionDownsampleFrequencyHz: original.sessionDownsampleFrequencyHz,
      });
    }
    expect(errors.errors).toEqual([]);
  } finally {
    const restored = await request.put("/api/settings", { data: { recordLmuOpponents: original.recordLmuOpponents } });
    expect(restored.ok()).toBe(true);
  }
});

test("LMU opponent recording restores the saved preference after a save failure", async ({ page, request }) => {
  const response = await request.get("/api/settings");
  expect(response.ok()).toBe(true);
  const original = await response.json() as { recordLmuOpponents: boolean };
  await openOpponentSettings(page, request);
  const preference = page.getByRole("switch", { name: "Record opponent data (LMU)" });
  const controls = page.locator("fieldset").filter({ has: preference });
  const save = controls.getByRole("button", { name: "Save", exact: true });
  await expect(preference).toBeChecked({ checked: original.recordLmuOpponents });
  await preference.focus();
  await page.keyboard.press("Space");
  await expect(save).toBeEnabled();
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 503, json: { error: "Controlled settings save failure" } });
    } else {
      await route.continue();
    }
  });
  try {
    await save.click();
    await expect(controls.getByRole("alert")).toHaveText("Save failed");
    await expect(preference).toBeChecked({ checked: original.recordLmuOpponents });
    await expect(save).toBeDisabled();
    expect(await (await request.get("/api/settings")).json()).toMatchObject({
      recordLmuOpponents: original.recordLmuOpponents,
    });
  } finally {
    await page.unroute("**/api/settings");
  }
});
