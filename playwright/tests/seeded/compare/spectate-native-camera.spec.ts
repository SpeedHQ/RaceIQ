import { expect, test } from "@playwright/test";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

test("F1 Spectate camera follows playback without catch-up rubberbanding at close zoom", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const pair = await getDistinctPair(request, "f1-2025");
  await page.goto(`/f125/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const nativeGPU = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return adapter ? { isFallbackAdapter: adapter.info.isFallbackAdapter, vendor: adapter.info.vendor, description: adapter.info.description } : null;
  });
  await testInfo.attach("webgpu-adapter", { body: JSON.stringify(nativeGPU), contentType: "application/json" });
  expect(nativeGPU, "Native WebGPU project requires a hardware adapter").not.toBeNull();
  expect(nativeGPU?.isFallbackAdapter, "Software adapters belong to the cross-platform renderer checks").toBe(false);
  const canvas = page.locator("[data-spectate-scene] canvas").first();
  await expect(canvas).toHaveAttribute("data-scene-rendered", "true", { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-renderer-backend", "webgpu");
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  for (let index = 0; index < 20; index++) {
    if (Number(await canvas.getAttribute("data-camera-radius")) < 50) break;
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("F1 Spectate scene has no layout");
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.5);
    const before = await canvas.getAttribute("data-render-count");
    await page.mouse.wheel(0, -700);
    await expect.poll(() => canvas.getAttribute("data-render-count")).not.toBe(before);
  }
  expect(Number(await canvas.getAttribute("data-camera-radius"))).toBeLessThan(50);
  await page.getByRole("slider", { name: "Replay position" }).fill("4");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  const motion = await canvas.evaluate((node) => {
    const { promise, resolve } = Promise.withResolvers<{ frames: number; maxOffset: number }>();
    const start = performance.now();
    let frames = 0, previousTime = -1, maxOffset = 0;
    const sample = () => {
      const data = (node as HTMLCanvasElement).dataset;
      const time = Number(data.renderTime);
      if (time !== previousTime) {
        previousTime = time;
        frames++;
        // The pair midpoint must stay centered, including the first frame after
        // scrubbing. Re-centering later would hide the camera catch-up bug.
        const x = (Number(data.aScreenX) + Number(data.bScreenX)) / 2;
        const y = (Number(data.aScreenY) + Number(data.bScreenY)) / 2;
        maxOffset = Math.max(maxOffset, Math.hypot(x, y));
      }
      if (frames < 6 && performance.now() - start < 20_000) requestAnimationFrame(sample);
      else resolve({ frames, maxOffset });
    };
    sample();
    return promise;
  }, undefined, { timeout: 25_000 });
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  expect(motion.frames).toBeGreaterThanOrEqual(6);
  expect(motion.maxOffset).toBeLessThan(0.05);
});
