import { expect, test } from "@playwright/test";
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers"

test("Spectate panel headers stay aligned and remember opened panels", async ({ page, request }) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, "acc");
  await page.setViewportSize({ width: 2600, height: 1000 });
  await page.goto(`/acc/compare?${compareQuery(pair)}&view=spectate&forceWebGL=true`);
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const ids = ["spectate-telemetry-panel", "spectate-2d-panel", "spectate-data-panel", "spectate-insights-panel", "spectate-ai-panel"];
  const toggle = async (id: string, open: boolean) => {
    const button = page.locator(`[data-panel-toggle="${id}"]`);
    if ((await button.getAttribute("aria-expanded")) !== String(open)) await button.click();
  };
  await expect(page.locator("[data-spectate-panel-headers]")).toBeVisible();
  for (const mask of [0, 1, 3, 31, 29, 28, 30, 2]) {
    for (const [index, id] of ids.entries()) await toggle(id, Boolean(mask & (1 << index)));
    const layout = await page.evaluate((panelIds) => {
      const strip = document.querySelector("[data-spectate-panel-headers]")!;
      const clip = strip.getBoundingClientRect();
      return {
        headers: Array.from(document.querySelectorAll("[data-panel-header]"), (element) => {
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, height: box.height };
        }),
        panels: panelIds.filter((id) => document.getElementById(id)).map((id) => {
          const header = document.querySelector(`[data-panel-header="${id}"]`)!.getBoundingClientRect();
          const panel = document.getElementById(id)!.getBoundingClientRect();
          return { id, offset: Math.abs(header.left - panel.left), widthDifference: Math.abs(header.width - panel.width), clipped: Math.abs(Math.max(0, header.right - clip.right) - Math.max(0, panel.right - document.querySelector("[data-panel-rail]")!.getBoundingClientRect().right)) };
        }),
      };
    }, ids);
    for (const header of layout.headers) {
      expect(header.height).toBe(layout.headers[0]!.height);
      expect(header.top).toBe(layout.headers[0]!.top);
      expect(header.bottom).toBe(layout.headers[0]!.bottom);
    }
    for (const panel of layout.panels) {
      expect(panel.offset, `${panel.id} follows panel opening immediately`).toBeLessThanOrEqual(1);
      expect(panel.widthDifference, `${panel.id} header matches panel width`).toBeLessThanOrEqual(1);
      expect(panel.clipped, `${panel.id} header and panel share the same scroll clipping`).toBeLessThanOrEqual(1);
    }
  }
  await toggle("spectate-ai-panel", true);
  const aiHeader = page.locator('[data-panel-header="spectate-ai-panel"]');
  await expect(aiHeader.getByRole("button", { name: "Clear chat", exact: true })).toBeVisible();
  await aiHeader.getByRole("button", { name: "Collapse AI Analysis", exact: true }).click();
  await expect(aiHeader.getByRole("button", { name: "Expand AI Analysis", exact: true })).toHaveAttribute("aria-expanded", "false");
  await aiHeader.getByRole("button", { name: "Expand AI Analysis", exact: true }).click();
  await page.reload();
  for (const [index, open] of [false, true, false, false, true].entries()) {
    await expect(page.locator(`[data-panel-toggle="${ids[index]}"]`)).toHaveAttribute("aria-expanded", String(open));
  }
  const carPanel = page.getByTestId("spectate-car-panel");
  await expect(carPanel.getByRole("img")).toHaveCount(8);
  expect(await carPanel.evaluate((element) => element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth), "both cars fit without adding panel scrolling").toBe(true);
  await expect(carPanel.getByText("Distribution", { exact: true })).toHaveCount(0);
  await carPanel.locator('[data-slot="tooltip-trigger"]').first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Share of current shock compression; this is not measured tire load.");
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 700, height: 950 });
  for (const id of ids) await toggle(id, true);
  await page.reload();
  // Narrow workspaces show one panel at a time; the last selection survives reload.
  for (const id of ids) await expect(page.locator(`[data-panel-toggle="${id}"]`)).toHaveAttribute("aria-expanded", String(id === ids.at(-1)));
  await page.setViewportSize({ width: 900, height: 950 });
  await expect(page.locator("[data-mobile-panel-tabs]")).toHaveCount(0);
  for (const id of ids) await toggle(id, true);
  const compactLayout = await page.locator("[data-spectate-view]").evaluate((root) => {
    const rail = root.querySelector<HTMLElement>("aside")!;
    const scene = root.querySelector<HTMLElement>("main")!;
    const playback = root.querySelector<HTMLElement>("[data-spectate-playback]")!;
    return {
      workspace: root.getBoundingClientRect().width,
      rail: rail.getBoundingClientRect().width,
      railContent: rail.scrollWidth,
      scene: scene.getBoundingClientRect().width,
      playback: playback.getBoundingClientRect().width,
    };
  });
  const minSceneWidth = Math.min(320, compactLayout.workspace * 0.5);
  expect(compactLayout.scene, "open panels must leave scene space").toBeGreaterThanOrEqual(minSceneWidth);
  expect(compactLayout.playback, "playback controls remain visible").toBeGreaterThan(0);
  expect(compactLayout.rail, "panel rail must stay within scene-preserving width").toBeLessThanOrEqual(compactLayout.workspace - minSceneWidth + 1);
  expect(compactLayout.railContent, "overflowing panels remain horizontally scrollable").toBeGreaterThan(compactLayout.rail);
});

test("Spectate Data switches one recorded lap at a time and follows seeks", async ({ page, request }, testInfo) => {
  const pair = await getDistinctPair(request, "acc");
  await page.addInitScript(() => {
    localStorage.setItem("spectate-telemetry-open", "false");
    localStorage.setItem("spectate-car-panel-open", "false");
    localStorage.setItem("spectate-data-open", "false");
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/acc/compare?${compareQuery(pair)}&view=spectate&forceWebGL=true`);
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const toggle = page.locator('[data-panel-toggle="spectate-data-panel"]');
  await toggle.click();
  const panel = page.locator("#spectate-data-panel");
  const seek = page.getByRole("slider", { name: "Replay position" });
  await seek.press("Home");
  const packets: number[] = [];
  for (const [side, lap] of [["A", pair.lapA], ["B", pair.lapB]] as const) {
    await panel.getByRole("tab", { name: side, exact: true }).click();
    await expect(panel.getByRole("tab", { name: side, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tabpanel")).toHaveCount(1);
    await panel.getByRole("button", { name: "Copy telemetry JSON", exact: true }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "acc" } });
    expect(response.ok()).toBe(true);
    const replay = await response.json();
    const frame = replay.envelopes.find((entry: { sequence: number }) => entry.sequence === copied.packetNumber);
    expect(frame).toBeDefined();
    expect(copied.values["motion.speed"]).toBe(frame.values.find((entry: { semanticId: string }) => entry.semanticId === "motion.speed").value);
    packets.push(copied.packetNumber);
  }
  await seek.press("PageUp");
  await panel.getByRole("button", { name: "Copy telemetry JSON", exact: true }).click();
  const afterSeek = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(afterSeek.packetNumber).toBeGreaterThan(packets[1]!);
  await page.screenshot({ path: testInfo.outputPath("spectate-data-b.png"), animations: "disabled" });
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expect(panel.getByRole("tab", { name: "A", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(panel.getByRole("tab", { name: "B", exact: true })).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});


type ReplayEntry = { semanticId: string; value: unknown; state?: string; freshness?: string };
type Replay = { envelopes: Array<{ observedAt: { domain: string; milliseconds: number }; values: ReplayEntry[] }> };
const valid = (entry: ReplayEntry | undefined) => entry && (!entry.state || entry.state === "ok") && (!entry.freshness || entry.freshness === "fresh");

function recordedModeAt(replay: Replay, target: number): string {
  const firstObserved = replay.envelopes[0]!.observedAt;
  const nativeStart = replay.envelopes.find((frame) => {
    const entry = frame.values.find((value) => value.semanticId === "timing.current-lap");
    return valid(entry) && typeof entry!.value === "number" && entry!.value >= 0;
  });
  if (!nativeStart) throw new Error("F1 acceptance requires a recorded native lap clock");
  const firstClock = nativeStart.values.find((value) => value.semanticId === "timing.current-lap")!.value as number;
  const origin = firstClock - Math.max(0, (nativeStart.observedAt.milliseconds - firstObserved.milliseconds) / 1000);
  let previous = -Infinity, mode = "unavailable";
  for (const frame of replay.envelopes) {
    const clock = frame.values.find((value) => value.semanticId === "timing.current-lap");
    const time = valid(clock) && typeof clock!.value === "number" && clock!.value >= 0
      ? clock!.value - origin : (frame.observedAt.milliseconds - firstObserved.milliseconds) / 1000;
    if (time < 0) continue;
    if (time < previous - 0.001 || time > target + 1e-7) break;
    const entry = frame.values.find((value) => value.semanticId === "fuel.ers-deploy-mode");
    mode = valid(entry) && /^[0-3]$/.test(String(entry!.value)) ? String(entry!.value) : "unavailable";
    previous = time;
  }
  return mode;
}

test("Spectate remembers vertical toolbar toggles across view changes and reloads", async ({ page, request }, testInfo) => {
  test.setTimeout(360_000);
  const pair = await getDistinctPair(request, "acc");
  const url = `/acc/compare?${compareQuery(pair)}&view=spectate&forceWebGL=true`;
  await page.goto(url);
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const direction = page.getByRole("switch", { name: "Follow car A direction", exact: true });
  const trails = page.getByRole("switch", { name: "Tire trails", exact: true });
  const line = page.getByRole("switch", { name: "Racing line", exact: true });
  const position = page.getByRole("switch", { name: "Lock cars to same track position", exact: true });
  const overviewToggle = page.getByRole("switch", { name: "Circuit overview", exact: true });
  const overview = page.getByRole("region", { name: "Circuit overview", exact: true });
  await expect(overviewToggle).toBeChecked();
  await expect(overview).toBeVisible();
  await overviewToggle.click();
  await expect(overview).toHaveCount(0);
  await expect(direction).not.toBeChecked();
  await expect(trails).not.toBeChecked();
  await expect(line).not.toBeChecked();
  await expect(position).toBeChecked();
  await direction.click();
  await trails.click();
  await expect(line).toBeEnabled();
  await line.click();
  await position.click();
  const expectSaved = async () => {
    await expect(overviewToggle).not.toBeChecked();
    await expect(overview).toHaveCount(0);
    await expect(direction).toBeChecked();
    await expect(trails).toBeChecked();
    await expect(line).toBeChecked();
    await expect(position).not.toBeChecked();
    await expect(page.locator("[data-spectate-playback]")).toHaveAttribute("data-position-lock", "false");
  };
  await page.getByRole("tab", { name: "Focus View", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Focus View", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Spectate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Spectate", exact: true })).toHaveAttribute("aria-selected", "true");
  await expectSaved();
  await page.reload();
  await expectSaved();
  await page.screenshot({ path: testInfo.outputPath("spectate-saved-toolbar.png"), animations: "disabled" });
  const noLinePair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/compare?${compareQuery(noLinePair)}&view=spectate&forceWebGL=true`);
  await expect(line).toBeEnabled();
  await expect(line).toBeChecked();
  await expect(line.locator("svg")).toHaveCSS("opacity", "0.4");
  await line.click();
  await expect(line).not.toBeChecked();
  await page.reload();
  await expect(line).not.toBeChecked();
  await expect(line.locator("svg")).toHaveCSS("opacity", "0.4");
  await line.click();
  await expect(line).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("spectate-unavailable-racing-line.png"), animations: "disabled" });
  await page.goto(url);
  await expectSaved();
  await direction.click();
  await trails.click();
  await line.click();
  await position.click();
  await overviewToggle.focus();
  await page.keyboard.press("Enter");
  await expect(overview).toBeVisible();
  await expect(direction).not.toBeChecked();
  await expect(trails).not.toBeChecked();
  await expect(line).not.toBeChecked();
  await expect(position).toBeChecked();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("spectate-racing-line"))).toBe("false");
  await page.reload();
  await expect(direction).not.toBeChecked();
  await expect(trails).not.toBeChecked();
  await expect(line).not.toBeChecked();
  await expect(position).toBeChecked();
  await expect(overviewToggle).toBeChecked();
  await expect(overview).toBeVisible();
  await page.evaluate(() => {
    for (const key of ["spectate-direction-lock", "spectate-tire-trails", "spectate-racing-line", "spectate-position-lock", "spectate-track-overview"]) {
      localStorage.setItem(key, "invalid");
    }
  });
  await page.reload();
  await expect(direction).not.toBeChecked();
  await expect(trails).not.toBeChecked();
  await expect(line).not.toBeChecked();
  await expect(position).toBeChecked();
  await expect(overviewToggle).toBeChecked();
  await expect(overview).toBeVisible();
});

test("Compare toolbar controls telemetry and AI across both views", async ({ page, request }, testInfo) => {
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate`);
  const view = page.locator("[data-spectate-view]");
  const telemetry = page.getByRole("button", { name: "Telemetry", exact: true });
  const ai = page.getByRole("button", { name: "AI Analysis", exact: true });
  await expect(view).toBeVisible();
  await expect(ai).toHaveCount(1);
  const scene = view.locator("[data-spectate-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true");
  const originalCanvas = await scene.locator("canvas").elementHandle();
  if (!originalCanvas) throw new Error("Spectate canvas is missing");
  await originalCanvas.evaluate((canvas) => {
    canvas.dataset.unpaintedResizes = "0";
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.attributeName === "width" || record.attributeName === "height") &&
          !records.some((record) => record.attributeName === "data-render-count")) {
        canvas.dataset.unpaintedResizes = String(Number(canvas.dataset.unpaintedResizes) + 1);
      }
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height", "data-render-count"] });
  });
  const expectScenePreserved = async () => {
    expect(await originalCanvas.evaluate((canvas) => canvas.isConnected)).toBe(true);
    await expect(scene).toHaveAttribute("data-scene-ready", "true");
    expect(await originalCanvas.getAttribute("data-unpainted-resizes")).toBe("0");
  };
  await expect(telemetry).toHaveAttribute("aria-pressed", "true");
  const telemetryBox = await telemetry.boundingBox();
  const aiBox = await ai.boundingBox();
  const tabBox = await page.getByRole("tab", { name: "Spectate", exact: true }).boundingBox();
  if (!telemetryBox || !aiBox || !tabBox) throw new Error("Compare toolbar controls have no layout");
  expect(Math.abs(telemetryBox.y - aiBox.y)).toBeLessThan(2);
  expect(Math.abs(telemetryBox.y + telemetryBox.height - tabBox.y - tabBox.height)).toBeLessThanOrEqual(2);
  expect(telemetryBox.x + telemetryBox.width <= aiBox.x || aiBox.x + aiBox.width <= telemetryBox.x, "toolbar controls do not overlap").toBe(true);
  await telemetry.click();
  await expect(view).toHaveAttribute("data-panel-collapsed", "true");
  await expect(telemetry).toHaveAttribute("aria-pressed", "false");
  await expectScenePreserved();
  await telemetry.press("Enter");
  await expect(view).toHaveAttribute("data-panel-collapsed", "false");
  await expectScenePreserved();
  await telemetry.click();
  await expect(telemetry).toHaveAttribute("aria-pressed", "false");
  await telemetry.click();
  await ai.click();
  await expect(ai).toHaveAttribute("aria-pressed", "true");
  await expectScenePreserved();
  const prompt = page.getByText("Analyse both laps to start a comparison chat", { exact: true }).filter({ visible: true });
  await expect(prompt).toBeVisible();
  const clearChat = page.getByRole("button", { name: "Clear chat", exact: true });
  await expect(clearChat).toBeVisible();
  const collapse = page.getByRole("button", { name: "Collapse AI Analysis", exact: true });
  const clearBox = await clearChat.boundingBox();
  const collapseBox = await collapse.boundingBox();
  if (!clearBox || !collapseBox) throw new Error("AI header actions have no layout");
  expect(Math.abs(clearBox.y + clearBox.height / 2 - collapseBox.y - collapseBox.height / 2)).toBeLessThan(2);
  await collapse.click();
  await expect(clearChat).toBeVisible();
  await page.getByRole("button", { name: "Expand AI Analysis", exact: true }).click();
  const cleared = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}/chat`));
  await clearChat.click();
  expect((await cleared).ok()).toBe(true);
  await expect(prompt).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("compare-toolbar-desktop.png"), animations: "disabled" });
  await page.getByRole("tab", { name: "Focus View", exact: true }).click();
  await expect(telemetry).toBeHidden();
  await expect(ai).toHaveAttribute("aria-pressed", "true");
  await expect(prompt).toBeVisible();
  await ai.click();
  await expect(prompt).toBeHidden();
  await page.getByRole("tab", { name: "Spectate", exact: true }).click();
  await expect(ai).toHaveAttribute("aria-pressed", "false");
  await expect(prompt).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(telemetry).toHaveAttribute("aria-pressed", "false");
  await expect(view).toHaveAttribute("data-panel-collapsed", "true");
  await telemetry.click();
  await expect(view).toHaveAttribute("data-panel-collapsed", "false");
  await expect(telemetry).toHaveAttribute("aria-pressed", "true");
  await ai.click();
  await expect(ai).toHaveAttribute("aria-pressed", "true");
  await ai.click();
  await telemetry.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("compare-toolbar-narrow.png"), fullPage: true, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("Spectate categories filter channels and browser remembers the selected time window", async ({ page, request }) => {
  test.setTimeout(140_000);
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate`);
  const panel = page.getByRole("complementary", { name: "Telemetry", exact: true });
  const clock = page.locator("[data-spectate-playback]");
  await expect(panel).toBeVisible();
  await expect(page.getByText("Representative car model", { exact: true })).toHaveCount(0);
  const range = page.getByRole("combobox", { name: "Range", exact: true });
  const titleBox = await page.locator('[data-panel-header="spectate-telemetry-panel"]').boundingBox();
  const rangeBox = await range.boundingBox();
  expect(titleBox && rangeBox && Math.abs(titleBox.y + titleBox.height / 2 - rangeBox.y - rangeBox.height / 2) < 2).toBe(true);
  const original = await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-channel-id")}:${row.getAttribute("data-component")}`).sort());
  const tabs = panel.getByRole("tablist", { name: "Category", exact: true });
  await expect(tabs.getByRole("tab", { name: "All", exact: true })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "Inputs", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator("[data-channel-id]").first()).toBeVisible();
  expect(await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.every((row) => row.getAttribute("data-channel-id") === "comparison.time-delta" || row.getAttribute("data-channel-id")?.startsWith("inputs.")))).toBe(true);
  await tabs.getByRole("tab", { name: "Inputs", exact: true }).press("End");
  await tabs.getByRole("tab", { selected: true }).press("Home");
  await expect(tabs.getByRole("tab", { name: "Inputs", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-channel-id")}:${row.getAttribute("data-component")}`).sort())).toEqual(original);
  const before = await clock.getAttribute("data-time");
  await range.selectOption("5");
  await expect(panel.locator("[data-channel-id]").first()).toHaveAttribute("data-axis-start", "-5");
  expect(await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.every((row) => row.getAttribute("data-axis-start") === "-5" && row.getAttribute("data-axis-end") === "5"))).toBe(true);
  expect(await clock.getAttribute("data-time")).toBe(before);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("spectate-chart-window-seconds"))).toBe("5");
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  await expect(range).toHaveValue("5");
  await page.reload();
  await expect(range).toHaveValue("5");
  await expect(panel.locator("[data-channel-id]").first()).toHaveAttribute("data-axis-end", "5");
  await page.evaluate(() => localStorage.setItem("spectate-chart-window-seconds", "invalid"));
  await page.reload();
  await expect(range).toHaveValue("10");
  await expect(panel.locator("[data-channel-id]").first()).toHaveAttribute("data-axis-start", "-10");
  await expect(page.locator("[data-battery-mode-a]")).toHaveCount(0);
});

test("F1 Spectate displays recorded string enum modes and keeps locked B motion registered", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, "f1-2025");
  const recordings: Replay[] = [];
  for (const lap of [pair.lapA, pair.lapB]) {
    const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "f1-2025" } });
    expect(response.ok()).toBe(true);
    recordings.push(await response.json() as Replay);
  }
  await page.goto(`/f125/compare?${compareQuery(pair)}&view=spectate`);
  const clock = page.locator("[data-spectate-playback]");
  const scene = page.locator("[data-spectate-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 30_000 });
  const seek = page.getByRole("slider", { name: "Replay position" });
  await page.getByRole("switch", { name: "Lock cars to same track position" }).click();
  await seek.press("Home");
  await expect(clock).toHaveAttribute("data-time", "0");
  const rail = page.locator("[data-battery-mode-a]");
  await expect(rail).toHaveAttribute("data-battery-mode-a", recordedModeAt(recordings[0]!, 0));
  await expect(rail).toHaveAttribute("data-battery-mode-b", recordedModeAt(recordings[1]!, 0));
  expect(await rail.getAttribute("data-battery-mode-a")).not.toBe("unavailable");
  expect(await rail.getAttribute("data-battery-mode-b")).not.toBe("unavailable");
  const bounds = await seek.boundingBox();
  if (!bounds) throw new Error("F1 replay slider has no layout");
  const duration = Number(await clock.getAttribute("data-duration"));
  await seek.click({ position: { x: 8 + (bounds.width - 16) * 4.5 / duration, y: bounds.height / 2 } });
  await page.getByRole("switch", { name: "Lock cars to same track position" }).click();
  for (const [index, side] of ["a", "b"].entries()) {
    const time = Number(await clock.getAttribute(`data-${side}-time`));
    await expect(rail).toHaveAttribute(`data-battery-mode-${side}`, recordedModeAt(recordings[index]!, time));
  }
  await page.getByRole("button", { name: "Play replay" }).click();
  const motion = await scene.locator("canvas").first().evaluate((canvas) => new Promise<Array<{ time: number; ax: number; az: number; bx: number; bz: number }>>((resolve) => {
    const rows: Array<{ time: number; ax: number; az: number; bx: number; bz: number }> = [];
    const started = performance.now();
    let last = "";
    const collect = () => {
      const data = (canvas as HTMLCanvasElement).dataset;
      if (data.renderCount !== last && data.aX && data.bX) {
        last = data.renderCount ?? "";
        rows.push({ time: Number(data.renderTime), ax: Number(data.aX), az: Number(data.aZ), bx: Number(data.bX), bz: Number(data.bZ) });
      }
      if (performance.now() - started >= 1500 && rows.length > 10) resolve(rows); else requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
  }));
  await page.getByRole("button", { name: "Pause replay" }).press("Enter");
  await expect(clock).toHaveAttribute("data-playing", "false");
  expect(motion.length, "recorded car movement reaches actual rendered frames").toBeGreaterThan(10);
  for (let index = 1; index < motion.length; index++) {
    const previous = motion[index - 1]!, current = motion[index]!;
    expect(current.time).toBeGreaterThanOrEqual(previous.time);
    const aStep = Math.hypot(current.ax - previous.ax, current.az - previous.az);
    const bStep = Math.hypot(current.bx - previous.bx, current.bz - previous.bz);
    expect(bStep, "B must not amplify coarse alignment-clock steps on this recorded straight").toBeLessThanOrEqual(aStep * 1.5 + 0.1);
  }
  await testInfo.attach("native-motion", { body: JSON.stringify(motion), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("f1-spectate-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  const input = await page.getByRole("region", { name: "Driver input comparison" }).boundingBox();
  const overview = await page.getByRole("region", { name: "Circuit overview", exact: true }).boundingBox();
  const playback = await clock.boundingBox();
  if (!input || !overview || !playback) throw new Error("F1 responsive controls have no layout");
  expect(overview.y + overview.height).toBeLessThanOrEqual(input.y);
  expect(input.y + input.height).toBeLessThanOrEqual(playback.y);
  await expect(rail).toBeVisible();
  await rail.scrollIntoViewIfNeeded();
  await expect(rail).toBeInViewport();
  await seek.scrollIntoViewIfNeeded();
  await expect(seek).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("f1-spectate-narrow.png"), fullPage: true, animations: "disabled" });
});

test("3D toggle preferences persist across reloads and Replay/Spectate navigation", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, "fm-2023");
  const replayUrl = `/fm23/sessions/${pair.lapA.sessionId}/replay/${pair.lapA.id}`;
  const compareUrl = `/fm23/compare?${compareQuery(pair)}&view=spectate`;
  const scene = page.locator("[data-spectate-scene]");
  const canvas = scene.locator("canvas").first();
  const model = scene.locator("[data-spectate-car-model-toggle]");
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const ready = async () => {
    await expect(scene).toHaveAttribute("data-scene-ready", "true");
    const open = await page.locator('[data-panel-toggle][aria-expanded="true"]').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-panel-toggle")!));
    for (const id of open) await page.locator(`[data-panel-toggle="${id}"]`).click();
  };
  const restored = async (single: boolean, mode: string) => {
    await ready();
    await expect(model).toHaveAttribute("data-car-model-mode", mode);
    await expect(canvas).toHaveAttribute("data-car-model-mode", mode);
    await expect(scene.getByRole("switch", { name: "Circuit overview", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("region", { name: "Circuit overview", exact: true })).toHaveCount(0);
    await expect(scene.getByRole("switch", { name: single ? "Follow" : "Follow car A direction", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(scene.getByRole("switch", { name: "Tire Info", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(scene.getByRole("switch", { name: /tire trails/i })).toHaveAttribute("aria-checked", "true");
    await expect(scene.getByRole("switch", { name: "Racing line", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("toolbar", { name: "Focus mode", exact: true }).getByRole("button", { name: "Speed", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas).toHaveAttribute("data-focus-mode", "speed");
  };
  await page.goto(replayUrl);
  await ready();
  await model.click();
  await model.click();
  await scene.getByRole("switch", { name: "Circuit overview", exact: true }).click();
  await scene.getByRole("switch", { name: "Follow", exact: true }).click();
  await scene.getByRole("switch", { name: "Tire Info", exact: true }).click();
  await scene.getByRole("switch", { name: /tire trails/i }).click();
  await scene.getByRole("switch", { name: "Racing line", exact: true }).click();
  await page.getByRole("toolbar", { name: "Focus mode", exact: true }).getByRole("button", { name: "Speed", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-focus-mode", "speed");
  await page.reload();
  await restored(true, "wire");
  await page.goto(compareUrl);
  await restored(false, "wire");
  const positionLock = scene.getByRole("switch", { name: "Lock cars to same track position", exact: true });
  await expect(positionLock).toHaveAttribute("aria-checked", "true");
  await positionLock.click();
  await expect(positionLock).toHaveAttribute("aria-checked", "false");
  await model.click();
  await model.click();
  await expect(canvas).toHaveAttribute("data-car-model-mode", "hidden");
  await page.reload();
  await restored(false, "hidden");
  await expect(positionLock).toHaveAttribute("aria-checked", "false");
  await page.goto(replayUrl);
  await restored(true, "hidden");
  await page.goto(compareUrl);
  await restored(false, "hidden");
  await expect(positionLock).toHaveAttribute("aria-checked", "false");
  for (let step = 0; step < 32 && await canvas.getAttribute("data-native-view-visible") !== "true"; step++) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
    await page.mouse.wheel(0, -360);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  for (const side of ["a", "b"]) {
    await expect(canvas).toHaveAttribute(`data-${side}-car-visible`, "false");
    await expect(canvas).toHaveAttribute(`data-${side}-chassis-visible`, "true");
    await expect(canvas).toHaveAttribute(`data-${side}-tire-info-visible-count`, "4");
  }
  await page.screenshot({ path: testInfo.outputPath("persisted-3d-toggle-settings.png"), animations: "disabled" });
});

test("3D toggle preferences recover from invalid stored modes", async ({ page, request }) => {
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/sessions/${pair.lapA.sessionId}/replay/${pair.lapA.id}`);
  await expect(page.locator("[data-replay-scene]")).toHaveAttribute("data-scene-ready", "true");
  await page.evaluate(() => {
    localStorage.setItem("spectate-car-model-mode", '{"invalid":true}');
    localStorage.setItem("spectate-focus-mode", "future-mode");
    localStorage.setItem("spectate-tire-info", "invalid");
  });
  await page.reload();
  const scene = page.locator("[data-replay-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true");
  const model = scene.locator("[data-spectate-car-model-toggle]");
  await expect(model).toHaveAttribute("data-car-model-mode", "solid");
  await expect(scene.getByRole("switch", { name: "Tire Info", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("toolbar", { name: "Focus mode", exact: true }).getByRole("button", { name: "Inputs", exact: true })).toHaveAttribute("aria-pressed", "true");
  await model.click();
  await expect(scene.locator("canvas").first()).toHaveAttribute("data-car-model-mode", "hidden");
  await page.reload();
  await expect(model).toHaveAttribute("data-car-model-mode", "hidden");
  await expect(scene.locator("canvas").first()).toHaveAttribute("data-car-model-mode", "hidden");
});
