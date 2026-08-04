import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("settings sections expose accessible controls and state changes", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const originalResponse = await request.get("/api/settings");
  expect(originalResponse.ok()).toBe(true);
  const original = (await originalResponse.json()) as Record<string, unknown>;
  let originalWheel: Record<string, string | null> = {};

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    originalWheel = await page.evaluate(() => ({
      steerLock: localStorage.getItem("forza-steer-lock"),
      wheelStyle: localStorage.getItem("forza-wheel-style"),
      soundEnabled: localStorage.getItem("forza-sound-enabled"),
      soundType: localStorage.getItem("forza-sound-type"),
      soundUrl: localStorage.getItem("forza-sound-url"),
      soundVolume: localStorage.getItem("forza-sound-volume"),
    }));
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const language = page.getByRole("combobox", { name: "Language" });
    await expect(language).toBeVisible();
    await language.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option", { name: /English/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("switch", { name: "Launch on login" })).toBeVisible();

    await page.getByRole("button", { name: "Connection" }).click();
    await expect(page.getByRole("heading", { name: "Forza Connection" })).toBeVisible();
    await expect(page.getByLabel("UDP Port")).toBeVisible();
    await expect(page.getByLabel("Live Refresh Rate")).toBeVisible();
    const refreshRate = page.getByLabel("Live Refresh Rate");
    const refreshSave = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
    await refreshRate.selectOption("30");
    expect((await refreshSave).ok()).toBe(true);
    await expect.poll(async () => ((await (await request.get("/api/settings")).json()) as Record<string, unknown>).wsRefreshRate).toBe("30");
    const frameCap = page.getByLabel("Render Frame Cap");
    const frameSave = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
    await frameCap.selectOption("45");
    expect((await frameSave).ok()).toBe(true);
    await expect.poll(async () => ((await (await request.get("/api/settings")).json()) as Record<string, unknown>).renderFpsCap).toBe(45);
    await expect(page.getByLabel("Render Frame Cap")).toBeVisible();
    await page.getByLabel("UDP Port").fill("1000");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Port must be between 1024-65535")).toBeVisible();
    await page.getByRole("button", { name: "How to enable Data Out in Forza Motorsport" }).click();
    await expect(page.getByText("Forza Motorsport (2023) — Data Out Setup")).toBeVisible();
    await page.getByRole("button", { name: "How to enable UDP Telemetry in F1 2025" }).click();
    await expect(page.getByText("EA Sports F1 2025 — UDP Telemetry Setup")).toBeVisible();

    await page.getByRole("button", { name: "Wheel" }).click();
    await expect(page.getByRole("heading", { name: "Steering Wheel" })).toBeVisible();
    const wheelOptions = page.locator("button").filter({ has: page.locator("img") });
    if (await wheelOptions.count()) {
      await wheelOptions.first().click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("forza-wheel-style"))).not.toBeNull();
    } else {
      await expect(page.getByText("No wheel images found in client/public/wheels/")).toBeVisible();
    }
    const steerLock = page.getByLabel("Steering Wheel Rotation (degrees)");
    await steerLock.fill("540");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("forza-steer-lock"))).toBe("540");

    await page.getByRole("button", { name: "Sound" }).click();
    await expect(page.getByRole("heading", { name: "Sound" })).toBeVisible();
    await page.getByRole("button", { name: "Off", exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("forza-sound-enabled"))).toBe("false");
    await page.getByRole("button", { name: "On", exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("forza-sound-enabled"))).toBe("true");
    await page.getByRole("button", { name: "Beep Short", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("button", { name: "Custom URL", exact: true }).click();
    const soundUrl = page.getByLabel("Sound URL");
    await soundUrl.fill("/sounds/beep-2.mp3");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("forza-sound-url"))).toBe("/sounds/beep-2.mp3");
    await page.getByLabel("Volume").fill("25");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("forza-sound-volume"))).toBe("0.25");

    await page.getByRole("button", { name: "Storage" }).click();
    await expect(page.getByText("Telemetry Cache")).toBeVisible();
    await expect(page.getByLabel("Cache size limit")).toBeVisible();
    await page.getByLabel("Cache size limit").fill("8");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Must be 16–2048 MB")).toBeVisible();

    await page.getByRole("button", { name: "Diagnostics" }).click();
    await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Diagnostics", exact: true }).click();
    await expect((await download).suggestedFilename()).toMatch(/^raceiq-diagnostics-/);
    await page.route("**/api/update/check", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.route("**/api/version", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ current: "seeded", latest: null, updateAvailable: false, checked: true, lastChecked: "2026-01-01T00:00:00.000Z" }),
      });
    });
    await page.getByRole("button", { name: "Updates" }).click();
    await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();
    await page.getByRole("button", { name: "Check for Updates" }).click();
    await expect(page.getByText("You're on the latest version.")).toBeVisible();

    await page.getByRole("button", { name: "About" }).click();
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await expect(page.getByText("Version")).toBeVisible();

    const developer = page.getByRole("button", { name: "Developer", exact: true });
    if (await developer.count()) {
      await developer.click();
      await expect(page.getByRole("heading", { name: "Forza Motorsport 2023 Extraction" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "F1 2025 Extraction" })).toBeVisible();
    } else {
      await expect(developer).toHaveCount(0);
    }

    expect(browserErrors.errors, "unexpected browser errors in settings controls").toEqual([]);
  } finally {
    await request.put("/api/settings", {
      data: {
        udpPort: original.udpPort,
        wsRefreshRate: original.wsRefreshRate,
        renderFpsCap: original.renderFpsCap,
        cacheMaxMB: original.cacheMaxMB,
        language: original.language,
      },
    });
    await page.evaluate(
      (values) => {
        for (const [key, value] of Object.entries(values)) {
          if (value === null) localStorage.removeItem(key);
          else if (value !== undefined) localStorage.setItem(key, value);
        }
      },
      {
        "forza-steer-lock": originalWheel.steerLock,
        "forza-wheel-style": originalWheel.wheelStyle,
        "forza-sound-enabled": originalWheel.soundEnabled,
        "forza-sound-type": originalWheel.soundType,
        "forza-sound-url": originalWheel.soundUrl,
        "forza-sound-volume": originalWheel.soundVolume,
      },
    );
  }
});
