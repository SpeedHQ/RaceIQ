import { expect, test } from "@playwright/test";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { getSeededLapMeta } from "../../../../../playwright/tests/support/seeded/laps"
import { collectBrowserErrors } from "../../../../../playwright/tests/support/browser-errors"
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers";
import { decodeSemanticLapTelemetry, packSemanticLapTelemetry, SEMANTIC_REPLAY_MEDIA_TYPE } from "../../../contracts";

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Replay workspace panels preserve playback and insight seeks at ${viewport.width}px`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__recording = true;
    });
    const browserErrors = collectBrowserErrors(page);
    const lap = await getSeededLapMeta(request, "fm-2023");
    const aiStatuses: number[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith(`/api/laps/${lap.id}/analyse/status`)) aiStatuses.push(response.status());
    });
    const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
    expect(response.ok()).toBe(true);
    const replay = await response.json() as {
      insights: LapInsight[];
      envelopes: { values: { semanticId: string; value: unknown }[] }[];
    };
    const finding = replay.insights.find((insight) => insight.frameIndices[0]! > 0);
    expect(finding, "seeded replay needs a seekable finding").toBeDefined();
    await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
    const scene = page.locator("[data-replay-scene]");
    await expect(scene.locator("canvas").first()).toBeVisible();
    if (viewport.width < 640) await scene.getByRole("button", { name: "Close Circuit overview", exact: true }).click();
    const timeline = page.getByRole("slider", { name: "Replay position", exact: true });
    const clock = page.locator("[data-spectate-playback]");
    await timeline.press("Home");
    await expect(clock).toHaveAttribute("data-time", "0");
    const segmentsToggle = page.locator('[data-panel-toggle="replay-segments-panel"]');
    await segmentsToggle.click();
    const segmentsPanel = page.locator("#replay-segments-panel");
    const activeSegment = segmentsPanel.locator('[aria-current="true"]');
    await expect(activeSegment).toHaveCount(1);
    const firstSegment = (await activeSegment.textContent())!;
    await expect(activeSegment).toContainText(/\d+\.\d{3}s/);
    const segmentTimes = (await segmentsPanel.textContent())!;
    await timeline.press("End");
    await expect(activeSegment).toHaveCount(1);
    await expect(activeSegment).not.toHaveText(firstSegment);
    await expect(segmentsPanel).toHaveText(segmentTimes);
    await timeline.press("Home");
    await expect(activeSegment).toHaveText(firstSegment);
    await segmentsToggle.click();
    await expect(segmentsPanel).toHaveCount(0);
    await segmentsToggle.click();
    await expect(activeSegment).toHaveText(firstSegment);
    await segmentsToggle.click();
    // Closing Data must not disable the replay clock or its timeline cursor.
    const dataToggle = page.locator('[data-panel-toggle="replay-data-panel"]');
    if (viewport.width < 800) await dataToggle.click();
    await dataToggle.click();
    await expect(dataToggle).toHaveAttribute("aria-expanded", "false");
    await expect(scene.getByRole("toolbar", { name: "Follow", exact: true })).toBeVisible();
    await expect(scene.getByRole("img", { name: "A", exact: true })).toHaveCount(0);
    for (const [semanticId, token] of [["inputs.brake", "--ch-brake"], ["inputs.accel", "--ch-throttle"]]) {
      const pedal = page.locator(`[data-spectate-workspace] [data-pedal="${semanticId}"] i`);
      expect(await pedal.evaluate((element, colorToken) => {
        const reference = document.createElement("span");
        reference.style.color = `var(${colorToken})`;
        document.body.append(reference);
        const expected = getComputedStyle(reference).color;
        reference.remove();
        return getComputedStyle(element).backgroundColor === expected;
      }, token)).toBe(true);
    }
    const modelToggle = scene.locator("[data-spectate-car-model-toggle]");
    await expect(modelToggle).toHaveCount(1);
    await expect(modelToggle).toHaveAttribute("data-car-model-mode", "solid");
    for (const mode of ["hidden", "wire", "solid"]) {
      await modelToggle.click();
      await expect(modelToggle).toHaveAttribute("data-car-model-mode", mode);
      await expect(modelToggle).toHaveAttribute("aria-pressed", String(mode !== "hidden"));
      await expect(scene.locator("canvas[data-renderer-backend]")).toHaveAttribute("data-car-model-mode", mode);
    }
    await page.getByRole("button", { name: "Play replay", exact: true }).click();
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause replay", exact: true }).click();
    const paused = await clock.getAttribute("data-time");
    await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("2");
    await expect(page.getByRole("combobox", { name: "Playback speed", exact: true })).toHaveValue("2");
    for (const id of ["telemetry", "car", "data", "segments", "insights", "ai"]) {
      const toggle = page.locator(`[data-panel-toggle="replay-${id}-panel"]`);
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click({ position: { x: 10, y: 10 } });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(`#replay-${id}-panel`)).toBeVisible();
      await toggle.click();
      await expect(page.locator(`#replay-${id}-panel`)).toHaveCount(0);
    }
    await expect(clock).toHaveAttribute("data-time", paused!);
    await expect.poll(() => aiStatuses).toContain(200);
    await expect(page.getByRole("switch", { name: "Lock cars to same track position" })).toHaveCount(0);
    const insightsToggle = page.locator('[data-panel-toggle="replay-insights-panel"]');
    await insightsToggle.click();
    const insights = page.locator("#replay-insights-panel");
    await insights.getByRole("button").filter({ has: page.getByText(finding!.label, { exact: true }) }).filter({ has: page.getByText(finding!.detail, { exact: true }) }).click();
    const frame = replay.envelopes[finding!.frameIndices[0]!]!;
    const renderer = scene.locator("canvas[data-renderer-backend]");
    for (const axis of ["x", "z"]) {
      const expected = frame.values.find((entry) => entry.semanticId === `motion.position-${axis}`)?.value;
      expect(typeof expected).toBe("number");
      await expect.poll(async () => Math.abs(Number(await renderer.getAttribute(`data-a-${axis}`)) - Number(expected))).toBeLessThan(0.25);
    }
    if (viewport.width > 800) {
      const captureColors = await page.evaluate(async (index) => {
        const hooks = window as unknown as {
          __setFrame: (index: number) => Promise<void>;
          __captureSceneBitmap: () => Promise<ImageBitmap>;
        };
        await hooks.__setFrame(index);
        const bitmap = await hooks.__captureSceneBitmap();
        try {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
          const colors = new Set<number>();
          for (let i = 0; i < pixels.length; i += 64) colors.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
          return colors.size;
        } finally { bitmap.close(); }
      }, finding!.frameIndices[0]!);
      expect(captureColors, "GPU recording capture contains the rendered scene, not a blank canvas").toBeGreaterThan(3);
    }
    const findingTime = await clock.getAttribute("data-time");
    await insightsToggle.click();
    await dataToggle.click();
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();
    await dataToggle.click();
    const telemetryToggle = page.locator('[data-panel-toggle="replay-telemetry-panel"]');
    await telemetryToggle.click();
    const expectHeaderTracksPanel = async (id: string) => {
      if (viewport.width <= 800) return;
      const header = page.locator(`[data-replay-panel-header] [data-panel-header="${id}"]`);
      const body = page.locator(`#${id}`);
      await expect.poll(async () => {
        const [headerBox, bodyBox] = await Promise.all([header.boundingBox(), body.boundingBox()]);
        if (!headerBox || !bodyBox) return Infinity;
        return Math.max(
          Math.abs(headerBox.x - bodyBox.x),
          Math.abs(headerBox.width - bodyBox.width),
          Math.abs(headerBox.y + headerBox.height - bodyBox.y),
        );
      }, { message: `${id} tab follows its panel` }).toBeLessThanOrEqual(1);
    };
    await expect(telemetryToggle).toBeVisible();
    await expectHeaderTracksPanel("replay-telemetry-panel");
    if (viewport.width > 800) {
      const separator = page.getByRole("separator", { name: "Resize panels", exact: true });
      await separator.focus();
      const beforeResize = Number(await separator.getAttribute("aria-valuenow"));
      await separator.press("ArrowRight");
      await expect(separator).toHaveAttribute("aria-valuenow", String(Math.max(270, beforeResize - 20)));
      await expectHeaderTracksPanel("replay-telemetry-panel");
    }
    const aiToggle = page.locator('[data-panel-toggle="replay-ai-panel"]');
    await aiToggle.click();
    await expectHeaderTracksPanel("replay-telemetry-panel");
    await expectHeaderTracksPanel("replay-ai-panel");
    const aiHeader = page.locator('[data-panel-header="replay-ai-panel"]');
    await aiHeader.getByRole("button", { name: "Manage", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Clear chat only", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#replay-ai-panel").getByRole("button", { name: "Manage", exact: true })).toHaveCount(0);
    await aiToggle.click();
    if (viewport.width < 800) await telemetryToggle.click();
    await expect(clock).toHaveAttribute("data-time", findingTime!);
    const panel = page.locator("#replay-telemetry-panel");
    await expect(panel.getByRole("tablist", { name: "Category", exact: true })).toBeVisible();
    expect(await panel.locator("canvas[aria-label]").evaluateAll((canvases) =>
      canvases.map((canvas) => canvas.getAttribute("aria-label")!).filter((label) => /; A /.test(label)),
    )).toEqual([]);
    const range = page.getByRole("combobox", { name: "Range", exact: true });
    await range.selectOption("5");
    await expect(panel.locator("[data-channel-id]").first()).toHaveAttribute("data-axis-start", "-5");
    await panel.getByRole("tab", { name: "Tires", exact: true }).click();
    const wheelChannel = panel.locator('[data-channel-id][data-component-count="4"]').first();
    await expect(wheelChannel).toBeVisible();
    await expect(wheelChannel.locator("canvas")).toHaveCount(1);
    for (const wheel of ["FL", "FR", "RL", "RR"]) await expect(wheelChannel.locator(`[data-wheel="${wheel}"]`)).toContainText(wheel);
    await expect(wheelChannel.locator("[data-current-b]")).toHaveCount(0);
    if (viewport.width < 800) {
      const [playbackBox, panelBox] = await Promise.all([clock.boundingBox(), panel.boundingBox()]);
      expect(panelBox!.y).toBeGreaterThanOrEqual(playbackBox!.y + playbackBox!.height);
    }
    await page.screenshot({ path: testInfo.outputPath(`replay-wheel-charts-${viewport.width}.png`), animations: "disabled" });
    await telemetryToggle.click();
    const tireToggle = page.locator("[data-tire-panel-toggle]");
    await tireToggle.hover();
    await expect(page.getByRole("tooltip").filter({ hasText: /^Tires$/ })).toBeVisible();
    await tireToggle.click();
    await expect(tireToggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#replay-car-panel")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`replay-tire-panel-${viewport.width}.png`), animations: "disabled" });
    if (viewport.width < 800) await page.locator('[data-panel-toggle="replay-car-panel"]').click();
    else await tireToggle.click();
    await expect(tireToggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#replay-car-panel")).toHaveCount(0);
    const lapList = await request.get("/api/laps?gameId=fm-2023");
    expect(lapList.ok()).toBe(true);
    const alternatives = await lapList.json() as { id: number; sessionId: number; lapNumber: number }[];
    const alternate = alternatives.find((candidate) => candidate.sessionId === lap.sessionId && candidate.id !== lap.id);
    expect(alternate, "seeded replay needs another lap in the same session").toBeDefined();
    await page.getByRole("combobox", { name: "Search laps..." }).click();
    await page.getByRole("option").filter({ hasText: new RegExp(`^Lap ${alternate!.lapNumber} – `) }).click();
    await expect(page).toHaveURL(new RegExp(`/replay/${alternate!.id}$`));
    await expect(clock).toHaveAttribute("data-time", "0");
    await expect(page.getByRole("button", { name: "Play replay", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (viewport.width > 800) {
      await page.setViewportSize({ width: 390, height: 844 });
      await telemetryToggle.click();
      await page.setViewportSize(viewport);
      await expect(page.locator("[data-panel-rail]")).toHaveCSS("position", "relative");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(telemetryToggle).toHaveAttribute("aria-expanded", "false");
    }
    await expect(renderer).toHaveCount(1);
    expect(await renderer.evaluate((canvas) => canvas.getBoundingClientRect().height)).toBeLessThanOrEqual(viewport.height);
    expect(browserErrors.errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1600, height: 1000 }]) {
  test(`Replay and Spectate resize the right panel section and neighboring panels at ${viewport.width}px`, async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const pair = await getDistinctPair(request, "fm-2023");
    const orders: string[][] = [];
    for (const single of [true, false]) {
      const prefix = single ? "replay" : "spectate";
      const ids = ["telemetry", single ? "car" : "2d", "data", "insights", "ai"].map((name) => `${prefix}-${name}-panel`);
      await page.goto(single
        ? `/fm23/sessions/${pair.lapA.sessionId}/replay/${pair.lapA.id}`
        : `/fm23/compare?${compareQuery(pair)}&view=spectate`);
      const split = page.getByRole("button", { name: "Split recordings", exact: true });
      await page.addLocatorHandler(split, () => split.click());
      const workspace = page.locator("[data-spectate-workspace]");
      await expect(workspace).toBeVisible();
      const toggle = async (index: number, open: boolean) => {
        const button = page.locator(`[data-panel-toggle="${ids[index]}"]`);
        if (await button.getAttribute("aria-expanded") !== String(open)) {
          await button.scrollIntoViewIfNeeded();
          await button.click();
        }
      };
      for (let index = 0; index < ids.length; index++) await toggle(index, index === 2);
      const rail = workspace.locator("[data-panel-rail]");
      const outer = page.getByRole("separator", { name: "Resize panels", exact: true });
      const width = async (locator: typeof rail) => {
        const box = await locator.boundingBox();
        if (!box) throw new Error("Panel has no layout");
        return box.width;
      };
      const dragBy = async (locator: typeof outer, delta: number) => {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (!box) throw new Error("Resize edge has no layout");
        const x = box.x + box.width / 2, y = box.y + box.height * 0.25;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + delta, y, { steps: 5 });
        await page.mouse.up();
      };
      const aligned = async () => {
        await expect.poll(() => page.evaluate((panelIds) => {
          let difference = 0;
          for (const id of panelIds) {
            const panel = document.getElementById(id);
            if (!panel) continue;
            const header = document.querySelector(`[data-panel-header="${id}"]`)!;
            const a = header.getBoundingClientRect(), b = panel.getBoundingClientRect();
            difference = Math.max(difference, Math.abs(a.x - b.x), Math.abs(a.width - b.width), Math.abs(a.bottom - b.top));
          }
          return difference;
        }, ids)).toBeLessThanOrEqual(1);
      };
      const workspaceWidth = await width(workspace);
      const manualWidth = Math.min(Math.floor(workspaceWidth / 2) + 100, workspaceWidth - 320);
      expect(await width(rail)).toBeLessThanOrEqual(workspaceWidth / 2);
      await toggle(0, true);
      await toggle(2, false);
      const chart = page.locator(`#${ids[0]} canvas[aria-label]`).first();
      const initialChartWidth = await width(chart);
      await dragBy(outer, (await width(rail)) - manualWidth);
      await expect.poll(() => width(rail)).toBeCloseTo(manualWidth, 0);
      await expect.poll(() => width(page.locator(`#${ids[0]}`))).toBeCloseTo(manualWidth, 0);
      await expect.poll(() => width(chart)).toBeGreaterThan(initialChartWidth);
      await page.reload();
      await expect(workspace).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => width(rail)).toBeCloseTo(manualWidth, 0);
      await expect.poll(() => width(page.locator(`#${ids[0]}`))).toBeCloseTo(manualWidth, 0);
      await toggle(2, true);
      expect(await width(rail)).toBeLessThanOrEqual(workspaceWidth / 2);
      await toggle(0, false);
      // The outer edge must work with Telemetry closed, over the full rail height.
      const railBox = await rail.boundingBox(), edgeBox = await outer.boundingBox();
      expect(edgeBox!.height).toBeCloseTo(railBox!.height, 0);
      const before = await width(rail);
      expect(before).toBeLessThanOrEqual(workspaceWidth / 2);
      const delta = 40;
      await dragBy(outer, delta);
      await expect.poll(() => width(rail)).toBeCloseTo(before - delta, 0);
      expect(await width(page.locator(`#${ids[2]}`))).toBeCloseTo(before - delta, 0);
      await outer.press("ArrowRight");
      const keyboardWidth = Math.max(270, before - delta - 20);
      await expect.poll(() => width(rail)).toBeCloseTo(keyboardWidth, 0);
      await outer.press("ArrowLeft");
      await outer.press("ArrowLeft");
      await expect.poll(() => width(rail)).toBeCloseTo(Math.min(keyboardWidth + 40, Number(await outer.getAttribute("aria-valuemax"))), 0);
      expect(await width(page.locator(`#${ids[2]}`))).toBeCloseTo(await width(rail), 0);
      await aligned();
      await toggle(0, true);
      expect(await width(rail)).toBeLessThanOrEqual(workspaceWidth / 2);
      await dragBy(outer, (await width(rail)) - manualWidth);
      await expect.poll(() => width(rail)).toBeCloseTo(manualWidth, 0);
      const left = page.locator(`#${ids[0]}`), right = page.locator(`#${ids[2]}`);
      const inner = right.getByRole("separator");
      const leftBefore = await width(left), rightBefore = await width(right), railBefore = await width(rail);
      await dragBy(outer, 20);
      await expect.poll(() => width(rail)).toBeCloseTo(railBefore - 20, 0);
      expect(await width(left)).toBe(leftBefore);
      expect(await width(right)).toBe(rightBefore);
      await aligned();
      await outer.press("ArrowLeft");
      await expect.poll(() => width(rail)).toBeCloseTo(railBefore, 0);
      await dragBy(inner, 10);
      await expect.poll(() => width(left)).toBeCloseTo(leftBefore + 10, 0);
      await expect.poll(() => width(right)).toBeCloseTo(rightBefore, 0);
      expect(await width(rail)).toBeCloseTo(railBefore, 0);
      const keyboardLeft = Math.max(leftBefore - 10, Number(await inner.getAttribute("aria-valuemin")));
      await inner.press("ArrowLeft");
      await expect.poll(() => width(left)).toBeCloseTo(keyboardLeft, 0);
      await expect.poll(() => width(right)).toBeCloseTo(rightBefore, 0);
      const maximumLeft = Number(await inner.getAttribute("aria-valuemax"));
      for (let step = 0; step <= Math.ceil((maximumLeft - keyboardLeft) / 20); step++) await inner.press("ArrowRight");
      await expect.poll(() => width(left)).toBeCloseTo(maximumLeft, 0);
      await expect.poll(() => width(right)).toBeCloseTo(rightBefore, 0);
      expect(await width(left)).toBeGreaterThan(leftBefore + rightBefore - 270);
      const minimumLeft = Number(await inner.getAttribute("aria-valuemin"));
      for (let step = 0; step <= Math.ceil((maximumLeft - minimumLeft) / 20); step++) await inner.press("ArrowLeft");
      await expect.poll(() => width(left)).toBeCloseTo(minimumLeft, 0);
      await expect.poll(() => width(right)).toBeCloseTo(rightBefore, 0);
      expect(await width(rail)).toBeCloseTo(railBefore, 0);
      await aligned();
      await dragBy(outer, 120);
      await expect.poll(() => width(rail)).toBeCloseTo(railBefore - 120, 0);
      await aligned();
      await workspace.locator("aside").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await expect.poll(() => workspace.locator("aside").evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => Math.abs(
        document.querySelector("[data-spectate-panel-headers]")!.scrollLeft -
        document.querySelector("[data-panel-rail] aside")!.scrollLeft,
      ))).toBeLessThanOrEqual(1);
      await aligned();
      orders.push(await page.locator("[data-panel-toggle]").evaluateAll((tabs, panelIds) =>
        tabs.map((tab) => panelIds.indexOf(tab.getAttribute("data-panel-toggle")!)).filter((index) => index >= 0), ids).then((indices) => indices.map((index) => ["telemetry", "car", "data", "insights", "ai"][index]!)));
      const saved = { rail: await width(rail), left: await width(left), right: await width(right) };
      await page.reload();
      await expect(left).toBeVisible();
      await expect(right).toBeVisible();
      await expect.poll(() => width(rail)).toBeCloseTo(saved.rail, 0);
      await expect.poll(() => width(left)).toBeCloseTo(saved.left, 0);
      await expect.poll(() => width(right)).toBeCloseTo(saved.right, 0);
      await aligned();
      const handle = await outer.boundingBox();
      const x = handle!.x + handle!.width / 2, y = handle!.y + handle!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await outer.dispatchEvent("pointercancel", { pointerId: 1 });
      await page.mouse.move(x - 40, y, { steps: 3 });
      await page.mouse.up();
      expect(await width(rail)).toBeCloseTo(saved.rail, 0);
      await page.screenshot({ path: testInfo.outputPath(`${prefix}-panel-resize-${viewport.width}.png`), animations: "disabled" });
      await toggle(0, false);
      await expect(outer).toBeVisible();
      await aligned();
    }
    expect(orders[1]).toEqual(orders[0]);
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

test("Replay arrow shortcuts step native frames without stealing control keys", async ({ page, request }) => {
  const lap = await getSeededLapMeta(request, "fm-2023");
  const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
  expect(response.ok()).toBe(true);
  const replay = await response.json() as { envelopes: { values: { semanticId: string; value: unknown }[] }[] };
  const clocks = replay.envelopes.map(frame => frame.values.find(value => value.semanticId === "timing.current-lap")?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const times = [...new Set(clocks.map(time => time - clocks[0]!))];
  expect(times[1]).toBeGreaterThan(0.001);
  await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
  const clock = page.locator("[data-spectate-playback]");
  const timeline = page.getByRole("slider", { name: "Replay position", exact: true });
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const time = async () => Number(await clock.getAttribute("data-time"));
  await timeline.press("Home");
  await blur();
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeCloseTo(times[1]!, 6);
  await expect(clock).toHaveAttribute("data-playing", "false");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(time).toBe(0);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(time).toBe(0);
  await timeline.press("End");
  await blur();
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeCloseTo(times.at(-1)!, 6);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(time).toBeCloseTo(times.at(-2)!, 6);
  await timeline.press("Home");
  await timeline.press("ArrowRight");
  await expect.poll(time).toBeCloseTo(0.001, 6);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "keyboard-editable-fixture";
    input.value = "editable";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeCloseTo(0.001, 6);
  await page.locator("#keyboard-editable-fixture").evaluate(element => element.remove());
});

test("Replay segment timings retain position-based fallback without native distance", async ({ page, request }) => {
  const lap = await getSeededLapMeta(request, "fm-2023");
  let duration = 0;
  await page.route(`**/api/laps/${lap.id}/semantic-telemetry`, async route => {
    expect(route.request().headers().accept).toContain(SEMANTIC_REPLAY_MEDIA_TYPE);
    const response = await route.fetch();
    const replay = decodeSemanticLapTelemetry(await response.json());
    const clocks = replay.envelopes.map(frame => frame.values.find(value => value.semanticId === "timing.current-lap")?.value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    duration = clocks.at(-1)! - clocks[0]!;
    for (const frame of replay.envelopes) {
      frame.values = frame.values.filter(value => value.semanticId !== "timing.distance-traveled" && value.semanticId !== "timing.lap-fraction");
    }
    await route.fulfill({ response, contentType: SEMANTIC_REPLAY_MEDIA_TYPE, json: packSemanticLapTelemetry(replay) });
  });
  await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
  const clock = page.locator("[data-spectate-playback]");
  await expect(clock).toHaveAttribute("data-a-distance", "");
  const toggle = page.locator('[data-panel-toggle="replay-segments-panel"]');
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const panel = page.locator("#replay-segments-panel");
  const times = panel.getByText(/^\d+\.\d{3}s$/);
  await expect.poll(async () => (await times.allTextContents()).reduce((sum, time) => sum + Number.parseFloat(time), 0)).toBeCloseTo(duration, 1);
  await expect(panel.locator('[aria-current="true"]')).toHaveCount(1);
  const initial = await times.allTextContents();
  await page.getByRole("slider", { name: "Replay position", exact: true }).press("End");
  await expect(times).toHaveText(initial);
});


test("AMS2 reduced-rate Polo replay keeps the car and telemetry visible between recorded frames", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const response = await request.get("/api/laps?gameId=ams2");
  expect(response.ok()).toBe(true);
  const laps = await response.json() as { id: number; sessionId: number; lapNumber: number; lapTime: number }[];
  const lap = laps.find(lap => lap.lapNumber === 4 && lap.lapTime > 60);
  expect(lap, "uploaded Polo race fixture needs its fourth completed lap").toBeDefined();
  await page.goto(`/ams2/sessions/${lap!.sessionId}/replay/${lap!.id}?forceWebGL=true`);
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const scene = page.locator("[data-replay-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
  const clock = page.locator('[data-spectate-playback]');
  const data = page.locator("[data-spectate-data-side]");
  const timeline = page.getByRole("slider", { name: "Replay position", exact: true });
  await timeline.fill("33.512");
  await expect.poll(async () => Number(await page.locator("[data-spectate-playback]").getAttribute("data-time"))).toBeCloseTo(33.512, 2);
  const balanceRow = data.getByRole("button", { name: /Balance/ });
  await expect(balanceRow).toBeVisible();
  await expect(balanceRow.locator("xpath=..")).toContainText(/\b(?:Neutral|Understeer|Oversteer)\b/);
  const dashboardBalance = page.locator("[data-balance-state]");
  await expect(dashboardBalance).toHaveCount(1);
  await expect(dashboardBalance).toHaveAttribute("data-balance-state", /^(neutral|understeer|oversteer)$/);
  const dashboardTraction = page.locator('[data-traction-side="a"][data-traction-state]');
  await expect(dashboardTraction).toHaveCount(4);
  for (const status of await dashboardTraction.evaluateAll(elements => elements.map(element => element.getAttribute("data-traction-state")))) {
    expect(status).toMatch(/^(GRIP|SLIP|SLIDE|SPIN|LOCK|IDLE)$/);
  }
  const dynamicsTable = data.getByRole("table").first();
  const traction = dynamicsTable.getByRole("row", { name: /Traction/ });
  await expect(traction.locator("td")).toHaveCount(5);
  for (const status of await traction.locator("td").evaluateAll(elements => elements.slice(1).map(element => element.textContent?.trim()))) {
    expect(status).toMatch(/^(GRIP|SLIP|SLIDE|SPIN|LOCK|IDLE)$/);
  }
  const gripAsk = dynamicsTable.getByRole("row", { name: /Grip Ask/ });
  await expect(gripAsk.locator("td")).toHaveText(["Grip Ask", /\d+%/, /\d+%/, /\d+%/, /\d+%/]);
  const slipTable = data.getByRole("table").nth(1);
  const ratioRow = slipTable.getByRole("row", { name: /Ratio/ });
  const ratioCells = ratioRow.locator("td");
  await expect(ratioCells).toHaveCount(5);
  for (const cell of await ratioCells.all().then(cells => cells.slice(1))) {
    await expect(cell).toHaveText(/^-?\d+%$/);
  }
  await expect(ratioCells.first().locator("svg.text-status-warning")).toHaveCount(1);
  await ratioCells.first().hover();
  await expect(data.getByRole("tooltip")).toContainText("AMS2 does not output tire slip ratio");
  await expect(data.getByRole("tooltip")).toContainText("two slowest wheels");
  const angleRow = slipTable.getByRole("row", { name: /Angle/ });
  const angleCells = angleRow.locator("td");
  await expect(angleCells).toHaveCount(5);
  for (const cell of await angleCells.all().then(cells => cells.slice(1))) {
    await expect(cell).toHaveText(/-?\d+\.\d°/);
  }
  const angleInfo = angleCells.nth(0).locator("svg.text-status-warning");
  await expect(angleInfo).toHaveCount(1);
  await expect(angleInfo).toHaveClass(/text-status-warning/);
  await angleCells.nth(0).hover();
  await expect(data.getByRole("tooltip")).toContainText("Estimated geometry uses road-going Volkswagen Polo proxy dimensions");
  await expect(data.getByRole("tooltip")).toContainText("Not verified for AMS2 TSI Cup or game physics");
  for (const time of [5.055, 12.345, 20.025, 27.295, 41.035, 55.075]) {
    await timeline.fill(String(time));
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeCloseTo(time, 2);
    await expect(scene).toHaveAttribute("data-side-a-state", "ready");
    await expect(data.getByText("This pair has no usable recorded replay.", { exact: true })).toHaveCount(0);
  }
  const canvas = scene.locator("canvas").first();
  for (let step = 0; step < 24 && Number(await canvas.getAttribute("data-a-model-pixels")) < 350; step++) {
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width * .65, bounds!.y + bounds!.height * .5);
    const before = await canvas.getAttribute("data-render-count");
    await page.mouse.wheel(0, -500);
    await expect.poll(() => canvas.getAttribute("data-render-count")).not.toBe(before);
  }
  await expect(canvas).toHaveAttribute("data-a-car-visible", "true");
  await expect(canvas).toHaveAttribute("data-a-suspension-visible-count", "4");
  const heave: number[] = [];
  for (const time of [5.055, 12.345, 20.025]) {
    await timeline.fill(String(time));
    await expect.poll(async () => Number(await canvas.getAttribute("data-render-time"))).toBeCloseTo(time, 2);
    await expect(canvas).toHaveAttribute("data-a-suspension-visible-count", "4");
    heave.push(Number(await canvas.getAttribute("data-a-body-heave")));
  }
  expect(heave.every(Number.isFinite)).toBe(true);
  expect(Math.max(...heave) - Math.min(...heave)).toBeGreaterThan(.00001);
  await timeline.fill("20.025");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(20.525);
  await expect(scene).toHaveAttribute("data-side-a-state", "ready");
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("ams2-polo-replay.png"), animations: "disabled" });
});
