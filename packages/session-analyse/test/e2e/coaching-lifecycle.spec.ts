import { expect, test, type APIRequestContext } from "@playwright/test";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { importCoachingRecording } from "./coaching-fixtures";
import { markLapInsightsStale, setCaptureSplitStatus } from "./coaching-db-fixtures";

const summaryUrl = (sessionId: number) => `/api/sessions/${sessionId}/3-to-improve`;
async function getSummary(request: APIRequestContext, sessionId: number) {
  const response = await request.get(summaryUrl(sessionId), { headers: { "X-Game-Id": "iracing" } });
  return { response, body: response.ok() ? ThreeToImproveResponseSchema.parse(await response.json()) : null };
}

test("processing guards block partial results, stale insight versions recompute, and UI scope cannot leak", async ({ page, request }) => {
  const coached = await importCoachingRecording(request, { label: `coaching-lifecycle-${Date.now()}`, lapCount: 1, signals: ["brake-drag"] });
  const empty = await importCoachingRecording(request, { label: `coaching-empty-${Date.now()}`, lapCount: 1, signals: [] });
  try {
    const initial = await getSummary(request, coached.sessionId);
    expect(initial.response.status()).toBe(200);
    expect(initial.body?.items.map(({ family }) => family)).toEqual(["brake-drag"]);

    await markLapInsightsStale(coached.lapIds[0]!);
    const refreshed = await getSummary(request, coached.sessionId);
    expect(refreshed.response.status()).toBe(200);
    expect(refreshed.body?.items).toEqual(initial.body?.items);

    const restoreSplitting = await setCaptureSplitStatus(coached.sessionId, "splitting");
    try {
      const processing = await request.get(summaryUrl(coached.sessionId), { headers: { "X-Game-Id": "iracing" } });
      expect(processing.status()).toBe(409);
      expect(await processing.json()).toEqual({ code: "RECORDING_PROCESSING", error: "Recording is queued or processing" });

      const restoreFailed = await setCaptureSplitStatus(coached.sessionId, "failed");
      try {
        const failed = await request.get(summaryUrl(coached.sessionId), { headers: { "X-Game-Id": "iracing" } });
        expect(failed.status()).toBe(422);
        const body = await failed.json() as { code: string; error: string };
        expect(body.code).toBe("RECORDING_PROCESSING_FAILED");
        expect(body.error).not.toContain("Controlled test failure");
      } finally {
        await restoreFailed();
      }
    } finally {
      await restoreSplitting();
    }

    const ready = await getSummary(request, coached.sessionId);
    expect(ready.response.status()).toBe(200);

    await page.goto(`/iracing/sessions/${coached.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
    const section = page.getByTestId("three-to-improve");
    await expect(section.locator('[data-coaching-family="brake-drag"]')).toBeVisible();
    await page.goto(`/iracing/sessions/${empty.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("three-to-improve").getByText(/No actionable patterns found in this session/)).toBeVisible();
    await expect(page.getByTestId("three-to-improve").locator("[data-coaching-family]")).toHaveCount(0);

    await empty.cleanup();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("three-to-improve")).toHaveCount(0);
  } finally {
    await empty.cleanup();
    await coached.cleanup();
  }
});
