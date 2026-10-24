import { expect, test } from "@playwright/test";
import { getSeededLapMeta } from "../../../../../playwright/tests/support/seeded/laps";
import { decodeSemanticLapTelemetry, packSemanticLapTelemetry, SEMANTIC_REPLAY_MEDIA_TYPE } from "../../../contracts";
type Envelope = { values: { semanticId: string; value: unknown }[] };
declare global {
  interface Window {
    __wearProbe: { draws: { id: number; rate: number }[]; latest: Record<number, number> };
  }
}
function lastRetainedPositionFrame(envelopes: Envelope[]) {
  const lastByClock = new Map<number, number>();
  for (let index = 0; index < envelopes.length; index++) {
    const clock = envelopes[index]!.values.find((value) => value.semanticId === "timing.current-lap")?.value;
    if (typeof clock === "number" && Number.isFinite(clock)) lastByClock.set(clock, index);
  }
  return [...lastByClock.values()].reverse().find((index) => {
    const values = envelopes[index]!.values;
    return ["motion.position-x", "motion.position-z"].every((id) => {
      const value = values.find((entry) => entry.semanticId === id)?.value;
      return typeof value === "number" && Number.isFinite(value);
    });
  }) ?? -1;
}

test("recording frame request waits for initialization and renders requested frame", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.assign(window, { __recording: true });
  });
  const lap = await getSeededLapMeta(request, "fm-2023");
  const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
  expect(response.ok()).toBe(true);
  const replay = await response.json() as { envelopes: Envelope[] };
  const index = lastRetainedPositionFrame(replay.envelopes);
  expect(index).toBeGreaterThan(0);
  const frame = replay.envelopes[index]!;
  const expectedX = frame.values.find((value) => value.semanticId === "motion.position-x")!.value as number;
  const expectedZ = frame.values.find((value) => value.semanticId === "motion.position-z")!.value as number;

  const { promise: configGate, resolve: releaseConfigs } = Promise.withResolvers<void>();
  const { promise: configRequest, resolve: configRequestStarted } = Promise.withResolvers<void>();
  await page.route("**/api/car-model-configs", async (route) => {
    configRequestStarted();
    await configGate;
    await route.continue();
  });
  await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`, { waitUntil: "domcontentloaded" });
  await configRequest;
  await expect.poll(() => page.evaluate(() => "__setFrame" in window ? typeof window.__setFrame : "undefined")).toBe("function");
  const seek = page.evaluate((target) => {
    if (!("__setFrame" in window) || typeof window.__setFrame !== "function") throw new Error("Recording hook unavailable");
    return window.__setFrame(target);
  }, index);
  releaseConfigs();
  await seek;
  const canvas = page.locator("[data-replay-scene] canvas[data-renderer-backend]");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => Number(await canvas.getAttribute("data-a-x"))).toBeCloseTo(expectedX, 2);
  await expect.poll(async () => Number(await canvas.getAttribute("data-a-z"))).toBeCloseTo(expectedZ, 2);
});

test("recording frame request rejects when scene unmounts before initialization", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.assign(window, { __recording: true });
  });
  const lap = await getSeededLapMeta(request, "fm-2023");
  const response = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "fm-2023" } });
  expect(response.ok()).toBe(true);
  const replay = await response.json() as { envelopes: Envelope[] };
  const index = lastRetainedPositionFrame(replay.envelopes);
  expect(index).toBeGreaterThan(0);
  const { promise: configGate, resolve: releaseConfigs } = Promise.withResolvers<void>();
  const { promise: configRequest, resolve: configRequestStarted } = Promise.withResolvers<void>();
  await page.route("**/api/car-model-configs", async (route) => {
    configRequestStarted();
    await configGate;
    await route.continue();
  });
  await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`, { waitUntil: "domcontentloaded" });
  await configRequest;
  await expect.poll(() => page.evaluate(() => "__setFrame" in window ? typeof window.__setFrame : "undefined")).toBe("function");
  const requestResult = page.evaluate((target) => {
    if (!("__setFrame" in window) || typeof window.__setFrame !== "function") throw new Error("Recording hook unavailable");
    return window.__setFrame(target).then(() => "resolved", (error: Error) => error.message);
  }, index);
  await page.locator("[data-replay-page-header]").getByRole("button", { name: "Sessions" }).click();
  await expect(requestResult).resolves.toBe("Scene runtime disposed");
  releaseConfigs();
});

test("tire labels retain playback wear history, cap refreshes and reset on a small seek", async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem("spectate-tire-info", "true");
    window.__wearProbe = { draws: [], latest: {} };
    const state = window.__wearProbe;
    const ids = new WeakMap<HTMLCanvasElement, number>();
    let nextId = 0;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const id = ids.get(this.canvas);
      if (id !== undefined) delete state.latest[id];
      return clearRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (/^-\d+\.\d{2}%\/s$/.test(args[0])) {
        let id = ids.get(this.canvas);
        if (id === undefined) { id = nextId++; ids.set(this.canvas, id); }
        const rate = -Number.parseFloat(args[0]);
        state.latest[id] = rate;
        state.draws.push({ id, rate });
      }
      return fillText.apply(this, args);
    };
  });
  const lap = await getSeededLapMeta(request, "fm-2023");
  await page.route(`**/api/laps/${lap.id}/semantic-telemetry`, async route => {
    expect(route.request().headers().accept).toContain(SEMANTIC_REPLAY_MEDIA_TYPE);
    const response = await route.fetch();
    const replay = decodeSemanticLapTelemetry(await response.json());
    for (const frame of replay.envelopes) {
      const time = frame.values.find(value => value.semanticId === "timing.current-lap")?.value;
      const wear = frame.values.find(value => value.semanticId === "tires.tire-wear");
      if (wear && typeof time === "number") wear.value = [0, 0, 0, 0].map(() => 1 - time * 0.005);
    }
    await route.fulfill({ response, contentType: SEMANTIC_REPLAY_MEDIA_TYPE, json: packSemanticLapTelemetry(replay) });
  });
  await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
  const scene = page.locator("[data-replay-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true");
  const canvas = scene.locator("canvas[data-renderer-backend]");
  for (let step = 0; step < 32 && await canvas.getAttribute("data-native-view-visible") !== "true"; step++) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
    await page.mouse.wheel(0, -360);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  await expect(canvas).toHaveAttribute("data-native-view-visible", "true");
  await expect(canvas).toHaveAttribute("data-a-tire-info-visible-count", "4");
  const clock = page.locator("[data-spectate-playback]");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Math.max(0, ...Object.values(window.__wearProbe.latest)))).toBeGreaterThan(0.4);
  const start = Number(await clock.getAttribute("data-time"));
  const wallStart = await page.evaluate(() => {
    window.__wearProbe.draws = [];
    return performance.now();
  });
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(start + 1);
  const paints = await page.evaluate((from) => {
    const draws = window.__wearProbe.draws;
    return { count: draws.filter(draw => draw.id === 0).length, elapsed: performance.now() - from, maximum: Math.max(...draws.map(draw => draw.rate)) };
  }, wallStart);
  expect(paints.maximum).toBeLessThanOrEqual(0.51);
  expect(paints.count).toBeLessThanOrEqual(Math.ceil(paints.elapsed / 100) + 2);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  const target = Number(await clock.getAttribute("data-time")) + 0.05;
  await page.getByRole("slider", { name: "Replay position", exact: true }).evaluate((element, time) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, String(time));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, target);
  await expect.poll(() => page.evaluate(() => Object.keys(window.__wearProbe.latest))).toEqual([]);
});
