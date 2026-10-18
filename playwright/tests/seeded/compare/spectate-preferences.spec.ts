import { expect, test } from "@playwright/test";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

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

test("Spectate categories filter channels and browser remembers the selected time window", async ({ page, request }) => {
  test.setTimeout(140_000);
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate`);
  const panel = page.getByRole("complementary", { name: "Telemetry", exact: true });
  const clock = page.locator("[data-spectate-playback]");
  await expect(panel).toBeVisible();
  const original = await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-channel-id")}:${row.getAttribute("data-component")}`).sort());
  const tabs = panel.getByRole("tablist", { name: "Category", exact: true });
  await tabs.getByRole("tab", { name: "Inputs", exact: true }).click();
  await expect(tabs.getByRole("tab", { name: "Inputs", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator("[data-channel-id]").first()).toBeVisible();
  expect(await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.every((row) => row.getAttribute("data-channel-id")?.startsWith("inputs.")))).toBe(true);
  await tabs.getByRole("tab", { name: "Inputs", exact: true }).press("Home");
  await expect(tabs.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-channel-id")}:${row.getAttribute("data-component")}`).sort())).toEqual(original);
  const before = await clock.getAttribute("data-time");
  await panel.getByRole("button", { name: "±5s", exact: true }).click();
  await expect(panel.locator("[data-channel-id]").first()).toHaveAttribute("data-axis-start", "-5");
  expect(await panel.locator("[data-channel-id]").evaluateAll((rows) => rows.every((row) => row.getAttribute("data-axis-start") === "-5" && row.getAttribute("data-axis-end") === "5"))).toBe(true);
  expect(await clock.getAttribute("data-time")).toBe(before);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("spectate-chart-window-seconds"))).toBe("5");
  await panel.getByRole("button", { name: "Collapse telemetry", exact: true }).click();
  await page.getByRole("button", { name: "Show telemetry", exact: true }).click();
  await expect(panel.getByRole("button", { name: "±5s", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(panel.getByRole("button", { name: "±5s", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator("[data-channel-id]").first()).toHaveAttribute("data-axis-end", "5");
  await page.evaluate(() => localStorage.setItem("spectate-chart-window-seconds", "invalid"));
  await page.reload();
  await expect(panel.getByRole("button", { name: "±10s", exact: true })).toHaveAttribute("aria-pressed", "true");
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
  await expect(rail.locator("[data-mode-step]")).toHaveCount(4);
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
  const modelBadge = await scene.getByText("Representative car model", { exact: true }).boundingBox();
  if (!modelBadge) throw new Error("The fixture's representative model must be labeled");
  expect(overview.y + overview.height).toBeLessThanOrEqual(modelBadge.y);
  expect(modelBadge.y + modelBadge.height).toBeLessThanOrEqual(input.y);
  await expect(rail).toBeVisible();
  await rail.scrollIntoViewIfNeeded();
  await expect(rail).toBeInViewport();
  await seek.scrollIntoViewIfNeeded();
  await expect(seek).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("f1-spectate-narrow.png"), fullPage: true, animations: "disabled" });
});
