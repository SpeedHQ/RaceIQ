import { expect, test } from "@playwright/test";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { getSeededLapMeta } from "../../../../../playwright/tests/support/seeded/laps"
import { collectBrowserErrors } from "../../../../../playwright/tests/support/browser-errors"

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Replay workspace panels preserve playback and insight seeks at ${viewport.width}px`, async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const browserErrors = collectBrowserErrors(page);
    const lap = await getSeededLapMeta(request, "fm-2023");
    const aiStatuses: number[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith(`/api/laps/${lap.id}/analyse/status`)) aiStatuses.push(response.status());
    });
    const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
    expect(response.ok()).toBe(true);
    const replay = await response.json() as { insights: LapInsight[]; envelopes: unknown[] };
    const finding = replay.insights.find((insight) => insight.frameIndices[0]! > 0);
    expect(finding, "seeded replay needs a seekable finding").toBeDefined();
    await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
    const scene = page.locator("[data-replay-scene]");
    await expect(scene.locator("canvas").first()).toBeVisible();
    const timeline = page.getByRole("slider", { name: "Lap timeline" });
    await expect(timeline).toHaveAttribute("aria-valuenow", "0");
    // Closing Data must not disable the replay clock or its timeline cursor.
    const dataToggle = page.locator('[data-panel-toggle="replay-data-panel"]');
    await dataToggle.click();
    await expect(dataToggle).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Play playback", exact: true }).click();
    await expect.poll(async () => Number(await timeline.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause playback", exact: true }).click();
    const paused = await timeline.getAttribute("aria-valuenow");
    await page.getByRole("button", { name: "2x", exact: true }).click();
    await expect(page.getByRole("button", { name: "2x", exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const id of ["telemetry", "car", "data", "insights", "ai"]) {
      const toggle = page.locator(`[data-panel-toggle="replay-${id}-panel"]`);
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(`#replay-${id}-panel`)).toBeVisible();
      await toggle.click();
      await expect(page.locator(`#replay-${id}-panel`)).toHaveCount(0);
    }
    await expect(timeline).toHaveAttribute("aria-valuenow", paused!);
    await expect.poll(() => aiStatuses).toContain(200);
    await expect(page.locator("[data-spectate-playback]")).toHaveCount(0);
    const insightsToggle = page.locator('[data-panel-toggle="replay-insights-panel"]');
    await insightsToggle.click();
    const insights = page.locator("#replay-insights-panel");
    await insights.getByRole("button").filter({ has: page.getByText(finding!.label, { exact: true }) }).filter({ has: page.getByText(finding!.detail, { exact: true }) }).click();
    await expect(timeline).toHaveAttribute("aria-valuenow", String(finding!.frameIndices[0]));
    await insightsToggle.click();
    await dataToggle.click();
    await expect(page.getByText(`Packet ${finding!.frameIndices[0]! + 1}/${replay.envelopes.length}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();
    await dataToggle.click();
    const telemetryToggle = page.locator('[data-panel-toggle="replay-telemetry-panel"]');
    await telemetryToggle.click();
    const separator = page.getByRole("separator", { name: "Resize telemetry panel" });
    await separator.focus();
    const beforeResize = Number(await separator.getAttribute("aria-valuenow"));
    await separator.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", String(Math.min(beforeResize + 20, Math.round(viewport.width * 0.88), 650)));
    await expect(timeline).toHaveAttribute("aria-valuenow", String(finding!.frameIndices[0]));
    await telemetryToggle.click();
    const lapList = await request.get("/api/laps?gameId=fm-2023");
    expect(lapList.ok()).toBe(true);
    const alternatives = await lapList.json() as { id: number; sessionId: number; lapNumber: number }[];
    const alternate = alternatives.find((candidate) => candidate.sessionId === lap.sessionId && candidate.id !== lap.id);
    expect(alternate, "seeded replay needs another lap in the same session").toBeDefined();
    await page.getByRole("combobox", { name: "Search laps..." }).click();
    await page.getByRole("option").filter({ hasText: new RegExp(`^Lap ${alternate!.lapNumber} – `) }).click();
    await expect(page).toHaveURL(new RegExp(`/replay/${alternate!.id}$`));
    await expect(timeline).toHaveAttribute("aria-valuenow", "0");
    await expect(page.getByRole("button", { name: "Play playback", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (viewport.width > 800) {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("[data-spectate-workspace] aside")).toHaveCSS("position", "absolute");
      await telemetryToggle.click();
      await page.setViewportSize(viewport);
      await expect(page.locator("[data-spectate-workspace] aside")).toHaveCSS("position", "relative");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(telemetryToggle).toHaveAttribute("aria-expanded", "false");
    }
    const renderer = scene.locator("canvas[data-renderer-backend]");
    await expect(renderer).toHaveCount(1);
    expect(await renderer.evaluate((canvas) => canvas.getBoundingClientRect().height)).toBeLessThanOrEqual(viewport.height);
    expect(browserErrors.errors).toEqual([]);
  });
}

test("Replay API preserves real recording, insight and error responses", async ({ request }) => {
  const lap = await getSeededLapMeta(request, "fm-2023");
  const headers = { "X-Game-Id": "fm-2023" };
  for (const endpoint of ["semantic-telemetry", "insights"]) {
    const url = `/api/laps/${lap.id}/${endpoint}`;
    const valid = await request.get(url, { headers });
    expect(valid.status()).toBe(200);
    expect(await valid.json()).toEqual(expect.objectContaining({ insights: expect.any(Array) }));
    const invalidHeaderCases: Record<string, string>[] = [{}, { "X-Game-Id": "not-a-game" }];
    for (const invalidHeaders of invalidHeaderCases) {
      const invalid = await request.get(url, { headers: invalidHeaders });
      expect(invalid.status()).toBe(400);
      expect(await invalid.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });
    }
    for (const missing of [
      await request.get(url, { headers: { "X-Game-Id": "acc" } }),
      await request.get(`/api/laps/2147483647/${endpoint}`, { headers }),
    ]) {
      expect(missing.status()).toBe(404);
      expect(await missing.json()).toEqual({ error: "Lap not found" });
    }
    expect((await request.get(`/api/laps/not-an-id/${endpoint}`, { headers })).status()).toBe(400);
  }
  const rerun = await request.post(`/api/laps/${lap.id}/insights/rerun`);
  expect(rerun.status()).toBe(200);
  const stored = await request.get(`/api/laps/${lap.id}/insights`, { headers });
  expect(stored.status()).toBe(200);
  expect(await stored.json()).toEqual(await rerun.json());
  const missing = await request.post("/api/laps/2147483647/insights/rerun");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: "Lap not found or has no telemetry" });
});
