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

test.beforeEach(async ({ page }) => {
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
});

const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "fm-2023" && candidate.supportedFeatures.includes("compare"));
if (!game) throw new Error("Spectate camera acceptance requires seeded FM compare case");

test("Space controls Spectate playback instead of focused buttons", async ({ page, request }) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const clock = page.locator("[data-spectate-playback]");
  const headingToggle = page.getByRole("switch", { name: "Follow car A direction", exact: true });
  await expect(headingToggle).toBeVisible({ timeout: 60_000 });
  // Software-rendered browser frames can be slow; keep playback away from
  // the lap end while checking held-key and focused-control behavior.
  await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("0.25");
  await page.getByRole("slider", { name: "Replay position" }).fill("0");
  await headingToggle.focus();
  await page.keyboard.down("Space");
  await expect(clock).toHaveAttribute("data-playing", "true");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  await expect(clock).toHaveAttribute("data-playing", "true");
  await expect(headingToggle).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "false");
  await expect(headingToggle).not.toBeChecked();
  const positionLockToggle = page.getByRole("switch", { name: "Lock cars to same track position" });
  await positionLockToggle.focus();
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "true");
  await expect(positionLockToggle).toBeChecked();
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "false");
  await expect(positionLockToggle).toBeChecked();
  await page.getByRole("button", { name: "Play replay", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "true");
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "false");
  await page.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "true");
  await page.keyboard.press("Space");
  await expect(clock).toHaveAttribute("data-playing", "false");
});

test("Spectate toggles paired tire trails and seeks recorded sector splits", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const scene = page.locator("[data-spectate-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
  const trails = page.getByRole("switch", { name: "Tire trails", exact: true });
  await expect(trails).not.toBeChecked();
  const split = page.locator("[data-sector-split]").first();
  await expect(split).toBeVisible();
  const splitTime = Number(await split.getAttribute("data-split-time"));
  expect(splitTime).toBeGreaterThan(0);
  await split.click();
  await expect.poll(async () => Number(await page.locator("[data-spectate-playback]").getAttribute("data-time"))).toBeCloseTo(splitTime, 2);
  await trails.click();
  await expect(trails).toBeChecked();
  const canvas = scene.locator("canvas").first();
  for (let step = 0; step < 32 && await canvas.getAttribute("data-native-view-visible") !== "true"; step++) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.48);
    await page.mouse.wheel(0, -360);
    await settle(page, 3);
  }
  await expect(canvas).toHaveAttribute("data-native-view-visible", "true");
  for (const side of ["a", "b"]) await expect.poll(async () => Number(await canvas.getAttribute(`data-${side}-trail-count`))).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("spectate-trails-sector-splits.png"), animations: "disabled" });
  await trails.focus();
  await page.keyboard.press("Enter");
  await expect(trails).not.toBeChecked();
  for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-trail-count`, "0");
});

test("Spectate bottom balance follows both cars through playback and seeks", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const clock = page.locator("[data-spectate-playback]");
  const group = page.getByRole("group", { name: "Balance", exact: true });
  await expect(group).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Dynamics", exact: true }).click();
  const chart = page.locator("[data-channel-id='derived.balance'] canvas").first();
  await expect(chart).toBeVisible();
  const seek = page.getByRole("slider", { name: "Replay position" });
  const values: string[] = [];
  for (const target of [5, 20, 35]) {
    await seek.fill(String(target));
    await expect(clock).toHaveAttribute("data-playing", "false");
    for (const side of ["a", "b"]) {
      const output = group.locator(`[data-balance-side='${side}']`);
      await expect(output).toHaveAttribute("data-balance-state", /^(neutral|understeer|oversteer)$/);
      const raw = Number(await output.getAttribute("data-balance-value"));
      expect(Number.isFinite(raw)).toBe(true);
      await expect(chart).toHaveAttribute(`data-current-${side}`, raw.toFixed(2));
      values.push(String(raw));
    }
  }
  expect(new Set(values).size, "Balance changes with recorded driving, not a static badge").toBeGreaterThan(1);
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(35.1);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await page.getByRole("switch", { name: "Lock cars to same track position" }).click();
  await seek.fill("20");
  for (const side of ["a", "b"]) {
    const output = group.locator(`[data-balance-side='${side}']`);
    const raw = Number(await output.getAttribute("data-balance-value"));
    await expect(chart).toHaveAttribute(`data-current-${side}`, raw.toFixed(2));
  }
  await page.screenshot({ path: testInfo.outputPath("spectate-bottom-balance.png"), animations: "disabled" });
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(group).toBeVisible();
  for (const side of ["a", "b"]) {
    const output = group.locator(`[data-balance-side='${side}']`);
    await expect(output).toBeVisible();
    const box = await output.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(600);
  }
});

test("FM Spectate preserves camera orbit and layout boundaries", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const view = page.locator("[data-spectate-view]");
  await expect(view).toBeVisible();
  const clock = page.locator("[data-spectate-playback]");
  const scene = page.locator("[data-spectate-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
  const canvas = scene.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "Follow car A direction", exact: true });
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
  const headingToggle = toolbar.getByRole("switch", { name: "Follow car A direction", exact: true });
  await expect(headingToggle).not.toHaveAttribute("title");
  await headingToggle.hover();
  await expect(page.getByRole("tooltip", { name: "Follow car A direction", exact: true })).toBeVisible();
  await headingToggle.focus();
  await expect(page.getByRole("tooltip", { name: "Follow car A direction", exact: true })).toBeVisible();
  await expect(headingToggle.locator("svg")).toBeVisible();
  await expect(headingToggle).toHaveText("");
  const toolbarBounds = await toolbar.boundingBox();
  const sceneBounds = await canvas.boundingBox();
  if (!toolbarBounds || !sceneBounds) throw new Error("Spectate toolbar or scene has no layout");
  expect(toolbarBounds.x - sceneBounds.x).toBeCloseTo(12, 0);
  expect(toolbarBounds.width).toBeLessThan(toolbarBounds.height + 1);
  for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "true");
  const markerSeparation = await canvas.evaluate((node) => {
    const data = (node as HTMLCanvasElement).dataset;
    const dx = (Number(data.aMarkerScreenX) - Number(data.bMarkerScreenX)) * node.clientWidth / 2;
    const dy = (Number(data.aMarkerScreenY) - Number(data.bMarkerScreenY)) * node.clientHeight / 2;
    return Math.hypot(dx, dy);
  });
  expect(markerSeparation, "A/B labels remain distinct when locked cars overlap at far zoom").toBeGreaterThan(5);
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
  const initialPhi = Number(await canvas.getAttribute("data-camera-phi"));
  const initialTheta = Number(await canvas.getAttribute("data-camera-theta"));
  await zoom(-360, 32, (radius, fit, pixels) => radius < fit * 0.15 && pixels >= 32);
  await settle(page, 12);
  expect(Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(initialPhi, 4);
  expect(Number(await canvas.getAttribute("data-camera-theta"))).toBeCloseTo(initialTheta, 4);
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
  await page.mouse.move(x + 68, y - 37, { steps: 8 });
  await page.mouse.up({ button: "left" });
  await settle(page, 4);
  const userPhi = Number(await canvas.getAttribute("data-camera-phi"));
  const userTheta = Number(await canvas.getAttribute("data-camera-theta"));
  expect(Math.abs(userPhi - initialPhi)).toBeGreaterThan(0.01);
  expect(Math.abs(userTheta - initialTheta)).toBeGreaterThan(0.01);
  await zoom(360, 24, (radius, fit) => radius > fit * 0.65);
  expect(Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(userPhi, 4);
  expect(Number(await canvas.getAttribute("data-camera-theta"))).toBeCloseTo(userTheta, 4);
  for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "true");
  await zoom(-360, 24, (radius, fit) => radius < fit * 0.15);
  await expect.poll(async () => Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(userPhi, 3);
  expect(Number(await canvas.getAttribute("data-camera-theta"))).toBeCloseTo(userTheta, 4);
  const wide = await canvas.boundingBox();
  if (!wide) throw new Error("Spectate scene canvas has no layout");
  await page.mouse.move(wide.x + wide.width * 0.5, wide.y + wide.height * 0.5);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(wide.x + wide.width * 0.5 + 35, wide.y + wide.height * 0.5 + 20, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await settle(page, 5);
  expect(Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(userPhi, 4);
  expect(Number(await canvas.getAttribute("data-camera-theta"))).toBeCloseTo(userTheta, 4);

  const directionLock = page.getByRole("switch", { name: "Follow car A direction", exact: true });
  await expect(directionLock).toBeChecked({ checked: false });
  await directionLock.click();
  await expect(directionLock).toBeChecked();
  const headingError = () => canvas.evaluate((node) => {
    const data = (node as HTMLCanvasElement).dataset;
    return Math.abs(Math.atan2(
      Math.sin(Number(data.cameraTheta) - Number(data.aYaw) - Math.PI),
      Math.cos(Number(data.cameraTheta) - Number(data.aYaw) - Math.PI),
    ));
  });
  await expect.poll(headingError).toBeLessThan(0.0001);
  const lockedPhi = Number(await canvas.getAttribute("data-camera-phi"));
  const headingBeforeSeek = Number(await canvas.getAttribute("data-a-yaw"));
  await seek.fill("10");
  await expect.poll(headingError).toBeLessThan(0.0001);
  await expect.poll(async () => Math.abs(Number(await canvas.getAttribute("data-a-yaw")) - headingBeforeSeek)).toBeGreaterThan(0.01);
  expect(Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(lockedPhi, 4);
  await zoom(360, 24, (radius, fit) => radius > fit * 0.65);
  await expect.poll(headingError).toBeLessThan(0.0001);
  expect(Number(await canvas.getAttribute("data-camera-phi"))).toBeCloseTo(lockedPhi, 4);
  await directionLock.click();
  await expect(directionLock).toBeChecked({ checked: false });
  const unlockedTheta = Number(await canvas.getAttribute("data-camera-theta"));
  await seek.fill("20");
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeCloseTo(20, 2);
  expect(Number(await canvas.getAttribute("data-camera-theta"))).toBeCloseTo(unlockedTheta, 4);
  await page.screenshot({ path: testInfo.outputPath("fm-spectate-camera-direction-toggle.png"), animations: "disabled" });

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
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  expect(await canvas.boundingBox()).toMatchObject({ x: narrowScene.x, width: narrowScene.width, height: narrowScene.height });
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  await expect(page.locator("[data-spectate-view]")).toHaveAttribute("data-panel-collapsed", "true");
  expect(await canvas.boundingBox()).toMatchObject({ x: narrowScene.x, width: narrowScene.width, height: narrowScene.height });
  await expect(page.getByRole("button", { name: "Telemetry", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
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
