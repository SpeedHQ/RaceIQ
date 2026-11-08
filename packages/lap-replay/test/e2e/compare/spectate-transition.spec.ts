import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers"

for (const gameId of ["fm-2023", "f1-2025"] as const) {
  test(`${gameId} snaps smoothly to stable zoom states and keeps badges independent`, async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    // Use a deterministic render cadence for animation assertions.
    await page.route("**/api/settings", async (route) => {
      const response = await route.fetch();
      const settings = await response.json();
      await route.fulfill({ response, json: { ...settings, renderFpsCap: 20 } });
    });
    const pair = await getDistinctPair(request, gameId);
    const prefix = gameId === "fm-2023" ? "fm23" : "f125";
    await page.goto(`/${prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
    const nativeGPU = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return adapter ? { isFallbackAdapter: adapter.info.isFallbackAdapter, vendor: adapter.info.vendor, description: adapter.info.description } : null;
    });
    await testInfo.attach("webgpu-adapter", { body: JSON.stringify(nativeGPU), contentType: "application/json" });
    expect(nativeGPU, "Native WebGPU project requires a hardware adapter").not.toBeNull();
    expect(nativeGPU?.isFallbackAdapter, "Software adapters belong to the cross-platform renderer checks").toBe(false);
    const split = page.getByRole("button", { name: "Split recordings", exact: true });
    await page.addLocatorHandler(split, () => split.click());
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    for (const name of ["Telemetry", "Car layout"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.getAttribute("aria-pressed") === "true") await button.click();
    }
    const canvas = page.locator("[data-spectate-scene] canvas").first();
    await expect(canvas).toHaveAttribute("data-renderer-backend", "webgpu");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    const zoom = async (delta: number) => {
      const current = (await canvas.boundingBox())!;
      await page.mouse.move(current.x + current.width * 0.55, current.y + current.height * 0.45);
      const before = await canvas.getAttribute("data-render-count");
      await page.mouse.wheel(0, delta);
      await expect.poll(async () => await canvas.getAttribute("data-zoom-blend") === (delta < 0 ? "0" : "1") || await canvas.getAttribute("data-render-count") !== before).toBe(true);
      return Number(await canvas.getAttribute("data-zoom-blend"));
    };
    for (let step = 0; step < 40 && Number(await canvas.getAttribute("data-zoom-blend")) !== 0; step++) await zoom(-360);
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    const follow = page.getByRole("switch", { name: "Follow car A direction", exact: true });
    if (await follow.getAttribute("aria-checked") !== "true") {
      await follow.focus();
      await page.keyboard.press("Enter");
    }
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    await canvas.screenshot({ path: testInfo.outputPath(`${gameId}-transition-near.png`) });
    await canvas.evaluate((node) => {
      const frames: { blend: number; car: boolean; label: boolean }[] = [];
      const data = (node as HTMLCanvasElement).dataset;
      const observer = new MutationObserver(() => {
        frames.push({ blend: Number(data.zoomBlend), car: data.aCarVisible === "true" || data.bCarVisible === "true", label: data.aMarkerVisible === "true" || data.bMarkerVisible === "true" });
      });
      observer.observe(node, { attributes: true, attributeFilter: ["data-render-count"] });
      Reflect.set(node, "transitionFrames", frames);
    });
    for (let step = 0; step < 50; step++) if (await zoom(120) > 0) break;
    // No further input: reaching the far endpoint must be automatic.
    await expect(canvas).toHaveAttribute("data-zoom-blend", "1");
    const schematicLineWidth = Number(await canvas.getAttribute("data-schematic-line-width"));
    expect(schematicLineWidth).toBeGreaterThan(0);
    expect(schematicLineWidth).toBeLessThanOrEqual(1.5);
    await expect(canvas).toHaveAttribute("data-schematic-lane-offset", "3");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    const farRadius = Number(await canvas.getAttribute("data-camera-radius"));
    await page.waitForTimeout(450);
    expect(Number(await canvas.getAttribute("data-camera-radius"))).toBeCloseTo(farRadius, 5);
    const image = await canvas.screenshot({ path: testInfo.outputPath(`${gameId}-transition-far.png`) });
    const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let colored = 0;
    const row = Math.round(info.height * 0.4);
    for (let y = Math.max(0, row - 2); y <= Math.min(info.height - 1, row + 2); y++) {
      for (let x = Math.round(info.width * 0.3); x < info.width * 0.8; x++) {
        const k = (y * info.width + x) * info.channels;
        const red = data[k]!, green = data[k + 1]!, blue = data[k + 2]!;
        if (Math.max(red, green, blue) > 70 && Math.max(red, green, blue) - Math.min(red, green, blue) > 30) colored++;
      }
    }
    expect(colored, "Both enlarged lane bands remain readable").toBeGreaterThanOrEqual(8);
    if (gameId === "fm-2023") {
      await page.setViewportSize({ width: 1440, height: 1500 });
      await expect(canvas).toHaveAttribute("data-zoom-blend", "1");
      await page.waitForTimeout(600);
      await expect(canvas).toHaveAttribute("data-zoom-blend", "1");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(canvas).toHaveAttribute("data-zoom-blend", "1");
    }
    const headings: number[] = [], yaws: number[] = [];
    for (const time of [10, 20, 30]) {
      await page.getByRole("slider", { name: "Replay position", exact: true }).fill(String(time));
      await expect.poll(async () => Number(await canvas.getAttribute("data-render-time"))).toBeCloseTo(time, 1);
      headings.push(Number(await canvas.getAttribute("data-camera-theta")));
      yaws.push(Number(await canvas.getAttribute("data-a-yaw")));
    }
    expect(Math.max(...yaws) - Math.min(...yaws), "Exercise different recorded car headings").toBeGreaterThan(0.01);
    const headingVariation = Math.max(...headings.map((heading) => Math.abs(Math.atan2(Math.sin(heading - headings[0]!), Math.cos(heading - headings[0]!)))));
    expect(headingVariation, "Schematic camera keeps following car A direction").toBeGreaterThan(0.01);
    await page.keyboard.press("Space");
    await expect.poll(async () => Number(await canvas.getAttribute("data-render-time"))).toBeGreaterThan(30.1);
    await page.keyboard.press("Space");
    for (let step = 0; step < 50; step++) if (await zoom(-120) < 1) break;
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    await page.waitForTimeout(450);
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    // Reverse from a rendered mid-snap frame, independent of browser-driver latency.
    await canvas.evaluate((node) => new Promise<void>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const blend = Number(node.dataset.zoomBlend);
        if (node.dataset.zoomSnapping !== "true" || blend <= 0.2 || blend >= 0.8) return;
        observer.disconnect();
        clearTimeout(timeout);
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: -360, bubbles: true, cancelable: true }));
        resolve();
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error("No rendered mid-snap frame available for zoom reversal"));
      }, 10_000);
      observer.observe(node, { attributes: true, attributeFilter: ["data-render-count"] });
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    }));
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    const frames = await canvas.evaluate(node => Reflect.get(node, "transitionFrames")) as { blend: number; car: boolean; label: boolean }[];
    expect(new Set(frames.filter(frame => frame.blend > 0 && frame.blend < 1).map(frame => frame.blend)).size, "Actual rendered frames must interpolate, not jump between endpoints").toBeGreaterThan(2);
    expect(frames.filter(frame => frame.car && frame.label), "Cars and badges must never ghost over each other").toEqual([]);
    await writeFile(testInfo.outputPath(`${gameId}-transition-frames.json`), JSON.stringify({ backend: await canvas.getAttribute("data-renderer-backend"), frames }, null, 2));
  });
}
