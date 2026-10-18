import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { compareQuery, getDistinctPair } from "./interaction-helpers";
async function settle(page: Page, frames = 4) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const next = () => (--count <= 0 ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    frames,
  );
}

const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "fm-2023" && candidate.supportedFeatures.includes("compare"));
if (!game) throw new Error("Spectate camera acceptance requires seeded FM compare case");

test("FM Spectate preserves camera orbit and layout boundaries", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const view = page.locator("[data-spectate-view]");
  await expect(view).toBeVisible();
  const clock = page.locator("[data-spectate-playback]");
  const scene = page.locator("[data-spectate-scene]");
  await expect.poll(() => scene.getAttribute("data-scene-ready")).toBe("true");
  const canvas = scene.locator("canvas").first();
  await expect(canvas).toBeVisible();
  for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "true");
  const markerSeparation = await canvas.evaluate((node) => {
    const data = (node as HTMLCanvasElement).dataset;
    return Math.abs(Number(data.aMarkerScreenY) - Number(data.bMarkerScreenY)) * node.clientHeight / 2;
  });
  expect(markerSeparation, "A/B labels remain distinct when locked cars overlap at far zoom").toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("fm-spectate-camera-far.png"), animations: "disabled" });
  const seek = page.getByRole("slider", { name: "Replay position" });
  await seek.press("End");
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
  await page.getByRole("switch", { name: "Lock cars to same track position" }).click();
  await expect(clock).toHaveAttribute("data-position-lock", "false");

  const zoom = async (deltaY: number, iterations: number, predicate: (radius: number, fit: number, modelPixels: number) => boolean) => {
    for (let index = 0; index < iterations; index++) {
      const radius = Number(await canvas.getAttribute("data-camera-radius"));
      const fit = Number(await canvas.getAttribute("data-fit-radius"));
      const pixels = Math.min(Number(await canvas.getAttribute("data-a-model-pixels")), Number(await canvas.getAttribute("data-b-model-pixels")));
      if (Number.isFinite(radius) && Number.isFinite(fit) && predicate(radius, fit, pixels)) return;
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Spectate scene canvas has no layout");
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.48);
      await page.mouse.wheel(0, deltaY);
      await settle(page, 3);
    }
    const radius = Number(await canvas.getAttribute("data-camera-radius"));
    const fit = Number(await canvas.getAttribute("data-fit-radius"));
    const pixels = Math.min(Number(await canvas.getAttribute("data-a-model-pixels")), Number(await canvas.getAttribute("data-b-model-pixels")));
    expect(predicate(radius, fit, pixels), `camera radius ${radius}, fit ${fit}, model pixels ${pixels}`).toBe(true);
  };
  await zoom(-360, 32, (radius, fit, pixels) => radius < fit * 0.15 && pixels >= 32);
  await settle(page, 12);
  for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "false");
  await page.screenshot({ path: testInfo.outputPath("fm-spectate-camera-near.png"), animations: "disabled" });
  const nearRadius = Number(await canvas.getAttribute("data-camera-radius"));
  const fitRadius = Number(await canvas.getAttribute("data-fit-radius"));
  expect(nearRadius).toBeLessThan(fitRadius * 0.15);

  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Spectate scene canvas has no layout");
  const x = bounds.x + bounds.width * 0.52;
  const y = bounds.y + bounds.height * 0.48;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(x + 68, y + 37, { steps: 8 });
  await page.mouse.up({ button: "left" });
  await settle(page, 4);
  const userPhi = Number(await canvas.getAttribute("data-user-phi"));
  const userTheta = Number(await canvas.getAttribute("data-user-theta"));
  expect(Number.isFinite(userPhi) && Number.isFinite(userTheta)).toBe(true);
  await zoom(360, 24, (radius, fit) => radius > fit * 0.65);
  for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "true");
  await zoom(-360, 24, (radius, fit) => radius < fit * 0.15);
  await expect.poll(async () => Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(userPhi, 3);
  const chosenTheta = Number(await canvas.getAttribute("data-user-theta"));
  const wide = await canvas.boundingBox();
  if (!wide) throw new Error("Spectate scene canvas has no layout");
  await page.mouse.move(wide.x + wide.width * 0.5, wide.y + wide.height * 0.5);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(wide.x + wide.width * 0.5 + 35, wide.y + wide.height * 0.5 + 20, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await settle(page, 5);
  expect(Number(await canvas.getAttribute("data-user-phi"))).toBeCloseTo(userPhi, 4);
  expect(Number(await canvas.getAttribute("data-user-theta"))).toBeCloseTo(chosenTheta, 4);

  await seek.press("Home");
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBe(0);
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(clock).toHaveAttribute("data-playing", "true");
  const separator = page.getByRole("separator", { name: "Resize telemetry panel" });
  const priorTime = Number(await clock.getAttribute("data-time"));
  const priorWidth = Number(await view.getAttribute("data-panel-width"));
  const sep = await separator.boundingBox();
  if (!sep) throw new Error("Telemetry separator has no layout");
  await page.mouse.move(sep.x + sep.width / 2, sep.y + sep.height / 2);
  await page.mouse.down();
  await page.mouse.move(sep.x + sep.width / 2 - 1000, sep.y + sep.height / 2, { steps: 10 });
  await page.mouse.up();
  const resizedWidth = Number(await view.getAttribute("data-panel-width"));
  expect(resizedWidth).toBeGreaterThan(priorWidth);
  expect(resizedWidth).toBeLessThan(900);
  await expect(clock).toHaveAttribute("data-playing", "true");
  expect(Number(await clock.getAttribute("data-time"))).toBeGreaterThanOrEqual(priorTime);
  await page.getByRole("button", { name: "Pause replay" }).click();

  await page.evaluate(() => localStorage.setItem("spectate-panel-width", "not-a-width"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-spectate-view]")).toBeVisible();
  const restoredWidth = Number(await page.locator("[data-spectate-view]").getAttribute("data-panel-width"));
  expect(Number.isFinite(restoredWidth) && restoredWidth > 0 && restoredWidth < 900).toBe(true);

  const checkNoOverlap = async () => {
    const boxes = await Promise.all([
      page.getByRole("region", { name: "Circuit overview", exact: true }).boundingBox(),
      page.getByRole("region", { name: "Driver input comparison" }).boundingBox(),
      clock.boundingBox(),
    ]);
    if (boxes.some((box) => !box)) throw new Error("Spectate overview, input, or playback has no layout");
    const [overview, input, playback] = boxes as NonNullable<(typeof boxes)[number]>[];
    const overlap = (a: typeof overview, b: typeof overview) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap(overview, input)).toBe(false);
    expect(overlap(overview, playback)).toBe(false);
    expect(overlap(input, playback)).toBe(false);
  };
  await checkNoOverlap();
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 5);
  await checkNoOverlap();
  const narrowScene = await canvas.boundingBox();
  const narrowPlayback = await clock.boundingBox();
  if (!narrowScene || !narrowPlayback) throw new Error("Narrow Spectate layout has no scene or playback");
  expect(narrowScene.width).toBeGreaterThan(0);
  await expect(view).toHaveAttribute("data-panel-collapsed", "true");
  await page.getByRole("button", { name: "Show telemetry" }).click();
  expect(await canvas.boundingBox()).toEqual(narrowScene);
  await page.getByRole("button", { name: "Collapse telemetry" }).click();
  await expect(page.locator("[data-spectate-view]")).toHaveAttribute("data-panel-collapsed", "true");
  expect(await canvas.boundingBox()).toEqual(narrowScene);
  await expect(page.getByRole("button", { name: "Show telemetry" })).toBeVisible();
  await page.getByRole("button", { name: "Show telemetry" }).click();
  await expect(page.getByRole("complementary", { name: "Telemetry", exact: true })).toBeVisible();

  const channels = page.locator("[data-channel-id]");
  await channels.last().scrollIntoViewIfNeeded();
  expect(await channels.count()).toBeGreaterThan(0);
  expect(
    await channels.evaluateAll((rows) =>
      rows.every((row) => row.getAttribute("data-axis-start") === "-10" && row.getAttribute("data-axis-end") === "10" && Number.isFinite(Number(row.getAttribute("data-center-time")))),
    ),
  ).toBe(true);
});

test("F1 Spectate camera follows playback without catch-up rubberbanding at close zoom", async ({ page, request }) => {
  test.setTimeout(120_000);
  const pair = await getDistinctPair(request, "f1-2025");
  await page.goto(`/f125/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const canvas = page.locator("[data-spectate-scene] canvas").first();
  await expect(canvas).toHaveAttribute("data-scene-rendered", "true", { timeout: 60_000 });
  await page.getByRole("button", { name: "Collapse telemetry", exact: true }).click();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("F1 Spectate scene has no layout");
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.5);
  for (let index = 0; index < 20; index++) {
    if (Number(await canvas.getAttribute("data-camera-radius")) < 50) break;
    await page.mouse.wheel(0, -700);
    await settle(page, 3);
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
  });
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  expect(motion.frames).toBeGreaterThanOrEqual(6);
  expect(motion.maxOffset).toBeLessThan(0.05);
});
