import { expect, test } from "@playwright/test";

import { getSeededLapTarget } from "../../support/seeded/laps";
import { openAnalyseLap } from "./fixtures";

const runQwenE2E = process.env.LM_STUDIO_E2E === "1" && !process.env.CI;

test("Analyse calls Qwen through the frontend and returns structured output", async ({ page, request }) => {
  test.skip(!runQwenE2E, "LM_STUDIO_E2E=1 and CI unset required");
  test.setTimeout(240_000);
  const originalSettingsResponse = await request.get("/api/settings");
  expect(originalSettingsResponse.ok()).toBe(true);
  const originalSettings = await originalSettingsResponse.json() as Record<string, unknown>;
  const lap = await getSeededLapTarget(request, "fm-2023");

  try {
    const settingsResponse = await request.put("/api/settings", {
      data: {
        aiProvider: "openai-compatible",
        aiModel: process.env.LM_STUDIO_MODEL || "qwen/qwen3.5-9b",
        localEndpoint: process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1",
      },
    });
    expect(settingsResponse.ok()).toBe(true);
    const deleteResponse = await request.delete(`/api/laps/${lap.id}/analyse`);
    expect(deleteResponse.ok()).toBe(true);

    await openAnalyseLap(page, lap);
    const resultResponse = await page.evaluate(async (lapId) => {
      const response = await fetch(`/api/laps/${lapId}/analyse?regenerate=true`, { method: "POST" });
      return { ok: response.ok, status: response.status, body: await response.text() };
    }, lap.id);
    expect(resultResponse.ok, `Analyse request failed (${resultResponse.status})`).toBe(true);
    const events = resultResponse.body.trim().split("\n").map((line) => JSON.parse(line));
    const result = events.findLast((event: { type?: string }) => event.type === "result") as { analysis?: string; cached?: boolean } | undefined;
    expect(result?.cached).toBe(false);
    expect(result?.analysis).toBeTruthy();
    expect(Object.keys(JSON.parse(result!.analysis!))).toEqual(["verdict", "pace", "handling", "corners", "technique", "setup"]);

  } finally {
    await request.delete(`/api/laps/${lap.id}/analyse`);
    await request.put("/api/settings", { data: originalSettings });
  }
});
