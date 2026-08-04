import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { RecordingFilesSchema, RecordingPacketsSchema } from "./helpers";

test("developer recording viewer loads source packets and scrubs values", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const filesResponse = await request.get("/api/dev/e2e-files");
  expect(filesResponse.ok()).toBe(true);
  const { files } = RecordingFilesSchema.parse(await filesResponse.json());
  const recording = files.find((file) => file.name.startsWith("fm-2023-"));
  expect(recording).toBeDefined();

  const packetsResponse = await request.get(`/api/dev/e2e-packets/${encodeURIComponent(recording!.name)}`);
  expect(packetsResponse.ok()).toBe(true);
  const metadata = RecordingPacketsSchema.parse(await packetsResponse.json());
  expect(metadata.packets.length).toBeGreaterThan(100);
  const firstIndex = metadata.packets.findIndex((packet) => packet.speed > 0);
  const secondIndex = metadata.packets.findIndex((packet, index) => index > firstIndex && Math.abs(packet.speed - metadata.packets[firstIndex].speed) > 1);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);

  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "E2E Recordings" }).click();
  await page.getByRole("button").filter({ hasText: recording!.name }).click();
  await expect(page.locator('main svg[viewBox="0 0 800 600"] path')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d+ packets/)).toBeVisible();

  const scrubber = page.locator('input[type="range"]');
  await scrubber.fill(String(firstIndex + 1));
  await expect(page.locator("span").filter({ hasText: /^Speed:/ })).toContainText(metadata.packets[firstIndex].speed.toFixed(1));
  await scrubber.fill(String(secondIndex + 1));
  await expect(page.locator("span").filter({ hasText: /^Speed:/ })).toContainText(metadata.packets[secondIndex].speed.toFixed(1));

  const lapButton = page.getByRole("button", { name: /^L\d+/ }).first();
  await expect(lapButton).toBeVisible();
  await lapButton.click();
  await expect(page.getByText(/^Lap \d+ • /)).toBeVisible();
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(page.getByText("Raw recording", { exact: true })).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in recording viewer").toEqual([]);
});

test("developer state pause and resume controls update state view", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });

  const stateTab = page.getByRole("button", { name: "State", exact: true });
  await stateTab.click();
  const pauseButton = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in dev state controls").toEqual([]);
});
