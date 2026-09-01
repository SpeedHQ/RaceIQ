import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("settings persist through reload and can be restored", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const originalResponse = await request.get("/api/settings");
  expect(originalResponse.ok()).toBe(true);
  const original = (await originalResponse.json()) as {
    unit: "metric" | "imperial";
    temperatureUnit: "C" | "F";
  };
  const nextUnit = original.unit === "metric" ? "imperial" : "metric";
  const nextTemperature = original.temperatureUnit === "C" ? "F" : "C";

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "RaceIQ" })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Units" }).click();
    await page.getByRole("button", { name: nextUnit === "metric" ? "Metric" : "Imperial" }).click();
    await page.getByRole("button", { name: `°${nextTemperature}` }).click();

    const saveResponse = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save" }).click();
    expect((await saveResponse).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Units" }).click();
    const selectedUnit = page.getByRole("button", {
      name: nextUnit === "metric" ? "Metric" : "Imperial",
    });
    const selectedTemperature = page.getByRole("button", {
      name: `°${nextTemperature}`,
    });
    await expect(selectedUnit).toHaveAttribute("aria-pressed", "true");
    await expect(selectedUnit).toHaveClass(/border-app-accent/);
    await expect(selectedTemperature).toHaveAttribute("aria-pressed", "true");
    await expect(selectedTemperature).toHaveClass(/border-app-accent/);

    const persistedResponse = await request.get("/api/settings");
    expect(persistedResponse.ok()).toBe(true);
    expect(await persistedResponse.json()).toMatchObject({
      unit: nextUnit,
      temperatureUnit: nextTemperature,
    });
    expect(browserErrors.errors, "unexpected browser errors in settings flow").toEqual([]);
  } finally {
    const restore = await request.put("/api/settings", {
      data: {
        unit: original.unit,
        temperatureUnit: original.temperatureUnit,
      },
    });
    expect(restore.ok()).toBe(true);
  }
});
