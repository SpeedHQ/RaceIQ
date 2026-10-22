import { expect, test } from "@playwright/test";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { collectBrowserErrors } from "../../../../../playwright/tests/support/browser-errors"
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers"

type Replay = {
  insights: LapInsight[];
  envelopes: { values: { semanticId: string; value: unknown; state?: string; freshness?: string }[] }[];
};

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Spectate Insights switches A/B and seeks native events at ${viewport.width}px`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      for (const key of ["spectate-telemetry-open", "spectate-car-panel-open", "spectate-data-open", "compare-ai-open"]) localStorage.setItem(key, "false");
    });
    const errors = collectBrowserErrors(page);
    const pair = await getDistinctPair(request, "fm-2023");
    const recordings: Replay[] = [];
    for (const lap of [pair.lapA, pair.lapB]) {
      const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
      expect(response.ok()).toBe(true);
      recordings.push(await response.json());
    }
    await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate`);
    const scene = page.locator("[data-spectate-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 30_000 });
    const toggle = page.locator('[data-panel-toggle="spectate-insights-panel"]');
    await toggle.click();
    const panel = page.locator("#spectate-insights-panel");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const canvas = scene.locator("canvas").first();
    for (const [index, side] of ["a", "b"].entries()) {
      await panel.getByRole("tab", { name: side.toUpperCase(), exact: true }).click();
      await expect(panel.locator("[data-spectate-insights-side]")).toHaveAttribute("data-spectate-insights-side", side);
      await expect(panel.getByRole("tabpanel")).toHaveCount(1);
      await expect(panel.getByRole("heading", { name: "Suspension" })).toBeVisible();
      const replay = recordings[index]!;
      const finding = replay.insights.find((insight) => insight.frameIndices[0]! > 0 && replay.envelopes[insight.frameIndices[0]!]!.values.some((entry) => entry.semanticId === "motion.position-x" && typeof entry.value === "number"));
      expect(finding, `lap ${side} needs a localized finding`).toBeDefined();
      const frame = replay.envelopes[finding!.frameIndices[0]!]!;
      await panel.getByRole("button").filter({ has: page.getByText(finding!.label, { exact: true }) }).filter({ has: page.getByText(finding!.detail, { exact: true }) }).click();
      for (const axis of ["x", "z"]) {
        const value = frame.values.find((entry) => entry.semanticId === `motion.position-${axis}`)!.value as number;
        await expect.poll(async () => Math.abs(Number(await canvas.getAttribute(`data-${side}-${axis}`)) - value)).toBeLessThan(0.25);
      }
      await expect(page.locator("[data-spectate-playback]")).toHaveAttribute("data-playing", "false");
    }
    await page.screenshot({ path: testInfo.outputPath(`spectate-insights-${viewport.width}.png`), fullPage: true });
    await toggle.click();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors.errors).toEqual([]);
  });
}
