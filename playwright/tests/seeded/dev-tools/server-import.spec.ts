import { expect, test } from "@playwright/test";
import { resolve } from "path";
import { z } from "zod";

import { collectBrowserErrors } from "../../support/browser-errors";
import { ImportResultSchema, SessionListSchema } from "./helpers";

test("developer disconnect control closes only isolated browser clients", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main").getByText("Server", { exact: true })).toBeVisible();

  const disconnectResponse = await request.post("/api/dev/disconnect");
  expect(disconnectResponse.ok()).toBe(true);
  const disconnectPayload = z.object({ ok: z.literal(true), disconnectedClients: z.number().int().nonnegative() }).parse(await disconnectResponse.json());
  expect(disconnectPayload.ok).toBe(true);

  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main").getByText("Server", { exact: true })).toBeVisible();
  expect(browserErrors.errors, "unexpected browser errors in dev disconnect flow").toEqual([]);
});

test("developer dump import runs production pipeline and cleans imported state", async ({ page, request }) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import Dump" }).click();
  const fixturePath = resolve(__dirname, "../../../../test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz");
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  const importResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/dev/import-dump");
  await page.getByRole("button", { name: "Import to Database", exact: true }).click();
  const importResponse = await importResponsePromise;
  expect(importResponse.ok()).toBe(true);
  const result = ImportResultSchema.parse(await importResponse.json());

  try {
    expect(result.ok).toBe(true);
    expect(result.packetCount).toBeGreaterThan(100);
    expect(result.laps.length).toBeGreaterThan(0);
    await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
    await expect(page.getByText("Laps saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open in Analyse" }).first()).toBeVisible();
  } finally {
    const sessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
    const cleanup = await request.post("/api/sessions/bulk-delete", {
      data: { ids: sessionIds },
    });
    expect(cleanup.ok(), `cleanup imported sessions ${sessionIds.join(", ")}`).toBe(true);
    const remainingSessionsResponse = await request.get("/api/sessions?gameId=fm-2023");
    expect(remainingSessionsResponse.ok()).toBe(true);
    const remainingSessionIds = new Set(SessionListSchema.parse(await remainingSessionsResponse.json()).map((session) => session.id));
    for (const sessionId of new Set(result.laps.map((lap) => lap.sessionId))) {
      expect(remainingSessionIds.has(sessionId), `imported session ${sessionId} remains`).toBe(false);
    }
  }

  expect(browserErrors.errors, "unexpected browser errors in dump import").toEqual([]);
});
