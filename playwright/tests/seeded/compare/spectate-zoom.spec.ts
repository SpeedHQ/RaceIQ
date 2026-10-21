import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

test("schematic lanes remain visible throughout zoom", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const canvas = page.locator("[data-spectate-scene] canvas").first();
  await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
  for (const name of ["Telemetry", "Car layout"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.getAttribute("aria-pressed") === "true") await button.click();
  }
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55 - 85, box.y + box.height * 0.45 - 100, { steps: 8 });
  await page.mouse.up();
  for (let i = 0; i < 32 && await canvas.getAttribute("data-line-layout") !== "recorded"; i++) {
    const before = await canvas.getAttribute("data-render-count");
    await page.mouse.wheel(0, -360);
    await expect.poll(() => canvas.getAttribute("data-render-count")).not.toBe(before);
  }
  await expect(canvas).toHaveAttribute("data-line-layout", "recorded");
  const observations: { radius: number; bands: number }[] = [];
  let checkedLabels = false;
  for (let step = 0; step < 72; step++) {
    const before = await canvas.getAttribute("data-render-count");
    await page.mouse.wheel(0, 120);
    await expect.poll(() => canvas.getAttribute("data-render-count")).not.toBe(before);
    if (await canvas.getAttribute("data-line-layout") !== "schematic") continue;
    if (Number(await canvas.getAttribute("data-zoom-blend")) !== 1) continue;
    for (const side of ["a", "b"]) {
      await expect(canvas).toHaveAttribute(`data-${side}-car-visible`, "false");
      await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "true");
      await expect(canvas).toHaveAttribute(`data-${side}-marker-opacity`, "1");
    }
    const image = await canvas.screenshot();
    const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const bandsAt = (row: number) => {
      const bands: { center: number; width: number }[] = [];
      let start = -1;
      for (let x = Math.round(info.width * 0.3); x <= info.width * 0.85; x++) {
        const k = (row * info.width + x) * info.channels;
        const green = data[k + 1]! > data[k]! * 1.5 && data[k + 1]! > data[k + 2]! * 0.9 && data[k + 1]! > 70;
        if (green && start < 0) start = x;
        if (!green && start >= 0) {
          if (x - start >= 3) bands.push({ center: (start + x - 1) / 2, width: x - start });
          start = -1;
        }
      }
      return bands;
    };
    const radius = Number(await canvas.getAttribute("data-camera-radius"));
    if (!checkedLabels) {
      const markerX = [], markerY = [];
      for (const side of ["a", "b"]) {
        markerX.push((Number(await canvas.getAttribute(`data-${side}-marker-screen-x`)) + 1) * info.width / 2);
        markerY.push((1 - Number(await canvas.getAttribute(`data-${side}-marker-screen-y`))) * info.height / 2);
      }
      expect(markerX[0], "A is left of B in this forward-facing view").toBeLessThan(markerX[1]!);
      for (let side = 0; side < 2; side++) {
        const row = Math.round(markerY[side]!);
        const near = bandsAt(row - 20), far = bandsAt(row - 30);
        expect(near, "Two visible lanes ahead of the label").toHaveLength(2);
        expect(far).toHaveLength(2);
        const lineX = near[side]!.center + (near[side]!.center - far[side]!.center) * 2;
        expect(Math.abs(markerX[side]! - lineX), "Label center lies on its own rendered lane").toBeLessThan(3.5);
      }
      checkedLabels = true;
      await testInfo.attach("labels-on-lanes", { body: image, contentType: "image/png" });
    }
    let bands = bandsAt(Math.round(info.height * 0.4)).length;
    if (radius >= 800) {
      bands = 0;
      for (let row = Math.round(info.height * 0.12); row < info.height * 0.7; row++) bands = Math.max(bands, bandsAt(row).length);
    }
    observations.push({ radius, bands });
    const required = radius >= 3000 ? 4 : 2;
    if (bands < required) await testInfo.attach(`missing-lane-${step}`, { body: image, contentType: "image/png" });
    expect(bands, `Both lane bands remain visible at camera radius ${radius}`).toBeGreaterThanOrEqual(required);
    if (step === 71) await testInfo.attach("whole-track-lanes", { body: image, contentType: "image/png" });
  }
  await testInfo.attach("zoom-pixels", { body: JSON.stringify(observations), contentType: "application/json" });
  expect(checkedLabels).toBe(true);
  expect(observations.at(-1)!.radius).toBeGreaterThan(7000);
});
