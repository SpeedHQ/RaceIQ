import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { StrategyRuntime } from "./runtime";

type Settings = Record<string, unknown> & {
  tireThresholdOverrides?: Record<string, Record<string, { cliffPct: number; deadPct: number }>>;
};

test("tire thresholds save, reload, isolate, validate and reset one compound", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-threshold-settings"));
  const context = await browser.newContext({ baseURL: runtime.baseURL });
  const page = await context.newPage();
  const request = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const expectedInjectedErrors: RegExp[] = [];
  const browserErrors = collectBrowserErrors(page, expectedInjectedErrors);
  const originalResponse = await request.get("/api/settings", { timeout: 60_000 });
  expect(originalResponse.ok()).toBe(true);
  const original = (await originalResponse.json()) as Settings;
  const originalOverrides = original.tireThresholdOverrides ?? {};
  const gameId = "f1-2025";
  const compound = "soft";
  const unrelated = { cliffPct: 51, deadPct: 19 };

  try {
    await request.put("/api/settings", {
      data: {
        tireThresholdOverrides: {
          ...originalOverrides,
          "fm-2023": { ...(originalOverrides["fm-2023"] ?? {}), "unrelated-seed": unrelated },
        },
      },
    }).then((response) => expect(response.ok()).toBe(true));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Games" }).click();
    await page.getByLabel("Game", { exact: true }).selectOption(gameId);
    await page.getByLabel("Tire compound", { exact: true }).selectOption(compound);
    await page.getByLabel("Cliff health (%)").fill("43");
    await page.getByLabel("Dead health (%)").fill("0");
    const saveResponse = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    expect((await saveResponse).ok()).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "Tire thresholds saved." })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Games" }).click();
    await page.getByLabel("Game", { exact: true }).selectOption(gameId);
    await page.getByLabel("Tire compound", { exact: true }).selectOption(compound);
    await expect(page.getByLabel("Cliff health (%)")).toHaveValue("43");
    await expect(page.getByLabel("Dead health (%)")).toHaveValue("0");

    let persisted = (await (await request.get("/api/settings")).json()) as Settings;
    expect(persisted.tireThresholdOverrides?.[gameId]?.[compound]).toEqual({ cliffPct: 43, deadPct: 0 });
    expect(persisted.tireThresholdOverrides?.["fm-2023"]?.["unrelated-seed"]).toEqual(unrelated);
    expect(persisted).toMatchObject({ unit: original.unit, temperatureUnit: original.temperatureUnit });

    await page.getByLabel("Cliff health (%)").fill("44");
    expectedInjectedErrors.push(/^http 500: .*\/api\/settings$/, /^console\.error: Failed to load resource:.*status of 500/);
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected save failure" }) });
      else await route.continue();
    });
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not save" })).toBeVisible();
    await expect(page.getByLabel("Cliff health (%)")).toHaveValue("44");
    expect(((await (await request.get("/api/settings")).json()) as Settings).tireThresholdOverrides?.[gameId]?.[compound]).toEqual({ cliffPct: 43, deadPct: 0 });
    await page.unroute("**/api/settings");
    expectedInjectedErrors.length = 0;

    await page.getByLabel("Cliff health (%)").fill("20");
    await page.getByLabel("Dead health (%)").fill("20");
    await expect(page.getByRole("alert").filter({ hasText: "Enter values from 0 to 100" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeDisabled();

    await page.getByLabel("Cliff health (%)").fill("43");
    await page.getByLabel("Dead health (%)").fill("0");
    await page.getByRole("button", { name: "Reset selected compound" }).click();
    await expect.poll(async () => {
      persisted = (await (await request.get("/api/settings")).json()) as Settings;
      return persisted.tireThresholdOverrides?.[gameId]?.[compound];
    }).toBeUndefined();
    expect(persisted.tireThresholdOverrides?.["fm-2023"]?.["unrelated-seed"]).toEqual(unrelated);
    for (const nativeGame of ["acc", "ac-evo"]) {
      await page.getByLabel("Game", { exact: true }).selectOption(nativeGame);
      for (const [nativeCompound, cliffPct, deadPct] of [["dry_compound", 45, 15], ["wet_compound", 70, 30]] as const) {
        await page.getByLabel("Tire compound", { exact: true }).selectOption(nativeCompound);
        await page.getByLabel("Cliff health (%)").fill(String(cliffPct));
        await page.getByLabel("Dead health (%)").fill(String(deadPct));
        const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
        await page.getByRole("button", { name: "Save", exact: true }).last().click();
        expect((await saved).ok()).toBe(true);
        persisted = (await (await request.get("/api/settings")).json()) as Settings;
        expect(persisted.tireThresholdOverrides?.[nativeGame]?.[nativeCompound]).toEqual({ cliffPct, deadPct });
      }
    }
    expect(browserErrors.errors, "unexpected browser errors in threshold settings flow").toEqual([]);
  } finally {
    try {
      const restoreOverrides = { ...originalOverrides };
      await request.put("/api/settings", { data: { tireThresholdOverrides: restoreOverrides } }).then((response) => expect(response.ok()).toBe(true));
    } finally {
      await runtime.stop();
      await context.close();
      await request.dispose();
    }
  }
});
