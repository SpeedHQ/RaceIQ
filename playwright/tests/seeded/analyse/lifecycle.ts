import { readFileSync } from "node:fs";

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { z } from "zod";

import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { gameRows } from "./fixtures";

export async function exportImportAndDelete(page: Page, request: APIRequestContext, selectedLap: LapMeta, selectedLapId: number, importedLapIds: number[]): Promise<void> {
  await page.getByRole("button", { name: "Export / Import" }).click();
  const csvDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export CSV" }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/);

  await page.getByRole("button", { name: "Export / Import" }).click();
  const binDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export .bin" }).click();
  const binDownload = await binDownloadPromise;
  const binPath = await binDownload.path();
  if (!binPath) throw new Error("Exported lap download has no local path");
  expect(binDownload.suggestedFilename()).toMatch(/\.bin(?:\.gz)?$/);

  await page.getByRole("button", { name: "Export / Import" }).click();
  await page.getByRole("menuitem", { name: "Import session (.bin or .ibt)" }).click();
  await page.locator('input[type="file"][accept*=".bin"]').setInputFiles({
    name: binDownload.suggestedFilename(),
    mimeType: "application/octet-stream",
    buffer: readFileSync(binPath),
  });
  const ownershipDialog = page.getByRole("dialog", { name: "Choose lap ownership" });
  await expect(ownershipDialog).toBeVisible();
  const importResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/laps/import"), { timeout: 120_000 });
  await ownershipDialog.getByRole("button", { name: "Import", exact: true }).click();
  const importResponse = await importResponsePromise;
  expect(importResponse.ok()).toBe(true);
  const importPayload = z.object({ laps: z.array(z.object({ lapId: z.number() })) }).parse(await importResponse.json());
  importedLapIds.push(...importPayload.laps.map(({ lapId }) => lapId));
  expect(importedLapIds.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Import Complete" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  const disposableLap = (await gameRows<LapMeta>(request, "laps")).find((lap) => importedLapIds.includes(lap.id));
  if (!disposableLap) throw new Error("Imported disposable lap missing from list");
  await page.goto(`/fm23/analyse?track=${disposableLap.trackOrdinal}&car=${disposableLap.carOrdinal}&lap=${disposableLap.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
  page.once("dialog", (dialog) => dialog.accept());
  const deleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/api/laps/${disposableLap.id}`));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await deleteResponse).ok()).toBe(true);
  await expect.poll(async () => (await gameRows<LapMeta>(request, "laps")).some((lap) => lap.id === disposableLap.id)).toBe(false);
  importedLapIds.splice(importedLapIds.indexOf(disposableLap.id), 1);

  await page.goto(`/fm23/analyse?track=${selectedLap.trackOrdinal}&car=${selectedLap.carOrdinal}&lap=${selectedLapId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
}
