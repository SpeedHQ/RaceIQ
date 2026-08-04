import { expect, test, type APIResponse } from "@playwright/test";
import { z } from "zod";

import { collectBrowserErrors } from "../../support/browser-errors";

const FM_RECORDING = "fm-2023-2026-04-09T21-55-03-186Z";
const ReplayResponseSchema = z.object({
  ok: z.literal(true),
  recordingName: z.string(),
  replayedPacketCount: z.number().int().positive(),
});

test.describe.configure({ mode: "serial" });

async function assertReplayCompleted(responsePromise: Promise<APIResponse>): Promise<void> {
  const response = await responsePromise;
  expect(response.ok(), "replay response ok").toBe(true);
  const payload = ReplayResponseSchema.parse(await response.json());
  expect(payload.replayedPacketCount, `replayed packets for ${payload.recordingName}`).toBeGreaterThan(1);
  expect(payload.replayedPacketCount, `max packets used by ${payload.recordingName}`).toBeLessThanOrEqual(240);
}

test("dash/fm-2023 replay binds combo-1 values and combo-2 track flow", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);

  const combo1Replay = request.post(`/api/dev/replay/${FM_RECORDING}?packets=240&intervalMs=12`);
  await page.goto("/dash/combo-1", { waitUntil: "domcontentloaded" });

  const speedTile = page.getByText(/KM\/H|MPH/, { exact: false }).locator("..");
  const observedValues = new Set<string>();
  await expect
    .poll(
      async () => {
        const value = (await speedTile.innerText()).trim();
        if (value) observedValues.add(value);
        return observedValues.size;
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBeGreaterThan(1);

  await assertReplayCompleted(combo1Replay);
  await expect(page.getByText("Waiting for lap data…", { exact: true })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Waiting for tire data…", { exact: true })).toHaveCount(0, { timeout: 20_000 });

  const combo2Replay = request.post(`/api/dev/replay/${FM_RECORDING}?packets=120&intervalMs=12`);
  await page.goto("/dash/combo-2", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Waiting for track…", { exact: true })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("No completed laps yet", { exact: true })).toBeVisible();

  await assertReplayCompleted(combo2Replay);
  await expect(page.locator("canvas[data-visual-ready='ready']")).toHaveCount(1);
  expect(browserErrors.errors, "unexpected browser errors in dash replay flow").toEqual([]);
});
