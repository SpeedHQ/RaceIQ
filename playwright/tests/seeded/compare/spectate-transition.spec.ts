import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

test.use({ launchOptions: { args: ["--enable-unsafe-webgpu", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])] } });

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
    const nativeGPU = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
    test.skip(!nativeGPU, "Native WebGPU adapter unavailable; fallback rendering has separate coverage");
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
      await expect.poll(() => canvas.getAttribute("data-render-count")).not.toBe(before);
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
    await expect(canvas).toHaveAttribute("data-schematic-line-width", "12");
    await expect(canvas).toHaveAttribute("data-schematic-lane-offset", "14");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    const farRadius = Number(await canvas.getAttribute("data-camera-radius"));
    await page.waitForTimeout(450);
    expect(Number(await canvas.getAttribute("data-camera-radius"))).toBeCloseTo(farRadius, 5);
    const image = await canvas.screenshot({ path: testInfo.outputPath(`${gameId}-transition-far.png`) });
    const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let colored = 0;
    const row = Math.round(info.height * 0.4);
    for (let x = Math.round(info.width * 0.3); x < info.width * 0.8; x++) {
      const k = (row * info.width + x) * info.channels;
      if (data[k + 1]! > data[k]! * 1.5 && data[k + 1]! > data[k + 2]! * 0.9 && data[k + 1]! > 70) colored++;
    }
    expect(colored, "Both enlarged lane bands remain readable").toBeGreaterThanOrEqual(20);
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
    for (const heading of headings) expect(Math.abs(Math.atan2(Math.sin(heading - headings[0]!), Math.cos(heading - headings[0]!))), "Schematic orientation must not turn with car yaw").toBeLessThan(0.000001);
    await page.keyboard.press("Space");
    await expect.poll(async () => Number(await canvas.getAttribute("data-render-time"))).toBeGreaterThan(30.1);
    await page.keyboard.press("Space");
    for (let step = 0; step < 50; step++) if (await zoom(-120) < 1) break;
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    await page.waitForTimeout(450);
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    await zoom(120);
    await page.waitForTimeout(170);
    await zoom(-360);
    await expect(canvas).toHaveAttribute("data-zoom-blend", "0");
    await expect(canvas).toHaveAttribute("data-zoom-snapping", "false");
    const frames = await canvas.evaluate(node => Reflect.get(node, "transitionFrames")) as { blend: number; car: boolean; label: boolean }[];
    expect(new Set(frames.filter(frame => frame.blend > 0 && frame.blend < 1).map(frame => frame.blend)).size, "Actual rendered frames must interpolate, not jump between endpoints").toBeGreaterThan(2);
    expect(frames.filter(frame => frame.car && frame.label), "Cars and badges must never ghost over each other").toEqual([]);
    await writeFile(testInfo.outputPath(`${gameId}-transition-frames.json`), JSON.stringify({ backend: await canvas.getAttribute("data-renderer-backend"), frames }, null, 2));
  });
}
