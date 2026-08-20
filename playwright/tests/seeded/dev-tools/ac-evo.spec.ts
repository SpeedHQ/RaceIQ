import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { RecordingPacketsSchema } from "./helpers";

test("developer AC Evo raw inspector decodes replay telemetry values", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const recordingName = "ac-evo-2026-04-15T17-12-25-825Z";
  const packetsResponse = await request.get(`/api/dev/e2e-packets/${encodeURIComponent(recordingName)}`);
  expect(packetsResponse.ok()).toBe(true);
  const metadata = RecordingPacketsSchema.parse(await packetsResponse.json());
  expect(metadata.packets.length).toBeGreaterThan(10);
  expect(metadata.packets.some((packet) => packet.speed > 1)).toBe(true);
  const decodedSpeedValues = new Set(metadata.packets.map((packet) => packet.speed.toFixed(3)));

  await page.goto("/ac-evo/raw", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dev-telemetry-page")).toHaveAttribute("data-subscribed", "true", { timeout: 30_000 });
  const replayResponsePromise = request.post(`/api/dev/replay/${recordingName}?packets=120&intervalMs=0`);
  await expect(page.getByText(/All Telemetry Values \(\d+ fields\)/)).toBeVisible({
    timeout: 30_000,
  });
  const replayResponse = await replayResponsePromise;
  expect(replayResponse.ok()).toBe(true);

  const speedRow = page.locator('[data-telemetry-field="Speed"]');
  await expect(speedRow).toBeVisible();
  const speedText = await speedRow.locator("span").last().innerText();
  expect(Number.isFinite(Number(speedText)), `decoded Speed value: ${speedText}`).toBe(true);
  expect(decodedSpeedValues.has(Number(speedText).toFixed(3)), `Speed ${speedText} came from replay source`).toBe(true);

  for (const field of ["CurrentEngineRpm", "Gear", "Accel", "Brake", "Steer"]) {
    const row = page.locator(`[data-telemetry-field="${field}"]`);
    await expect(row, `decoded ${field} field`).toBeVisible();
    await expect(row.locator("span").last()).toHaveText(/^-?\d+(?:\.\d+)?$/);
  }

  for (const name of ["Parsed Packet", "Struct Fields (v0.6)", "Verify (bytes + interp)", "Raw Hex"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }

  const nativeRawResponse = await request.get("/api/ac-evo/debug/raw");
  if (nativeRawResponse.ok()) {
    await page.getByRole("button", { name: "Struct Fields (v0.6)", exact: true }).click();
    await expect(page.getByText(/Page sizes: physics \d+B/)).toBeVisible();
    await page.getByRole("button", { name: "Verify (bytes + interp)", exact: true }).click();
    await expect(page.getByText(/Every field: our expected offset/)).toBeVisible();
    await page.getByRole("button", { name: "Raw Hex", exact: true }).click();
    await expect(page.getByText(/physics: \d+ bytes/)).toBeVisible();
  }

  expect(browserErrors.errors, "unexpected browser errors in AC Evo raw inspector").toEqual([]);
});

test("developer AC Evo native inspection APIs report provider status honestly", async ({ request }) => {
  for (const endpoint of ["raw", "hex", "verify"]) {
    const response = await request.get(`/api/ac-evo/debug/${endpoint}`);
    if (response.status() === 503) {
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("AC Evo"),
      });
      continue;
    }

    expect(response.ok(), `${endpoint} inspection response`).toBe(true);
    const payload = await response.json();
    if (endpoint === "raw") {
      expect(payload.sizes.physics).toBeGreaterThan(0);
      expect(typeof payload.physics.speedKmh).toBe("number");
    } else if (endpoint === "hex") {
      expect(typeof payload.physics).toBe("string");
      expect(typeof payload.graphics).toBe("string");
      expect(typeof payload.staticData).toBe("string");
    } else {
      expect(payload.physics.length).toBeGreaterThan(0);
      expect(payload.graphics.length).toBeGreaterThan(0);
      expect(payload.static.length).toBeGreaterThan(0);
      expect(payload.physics[0]).toEqual(
        expect.objectContaining({
          field: expect.any(String),
          offset: expect.any(Number),
          hex: expect.any(String),
          value: expect.anything(),
        }),
      );
    }
  }
});
