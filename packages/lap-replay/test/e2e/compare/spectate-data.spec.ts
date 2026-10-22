import { expect, test } from "@playwright/test";
import { SEEDED_GAME_CASES } from "../../../../../playwright/tests/support/seeded/cases"
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers"
const gapThresholdS = 0.5;

test("ACC Spectate preserves recorded gaps and recovers beyond them", async ({ page, request }) => {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "acc" && candidate.supportedFeatures.includes("compare"));
  if (!game) throw new Error("Spectate acceptance prerequisite missing: seeded compare case for acc");
  const pair = await getDistinctPair(request, "acc");
  type Frame = {
    observedAt: { domain: string; milliseconds: number };
    values: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }>;
  };
  const native: Array<{ times: number[] }> = [];
  for (const lap of [pair.lapA, pair.lapB]) {
    const result = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "acc" } });
    expect(result.ok(), `ACC native replay for lap ${lap.id}`).toBe(true);
    const replay = (await result.json()) as { envelopes: Frame[] };
    const firstObserved = replay.envelopes.find((frame) => Number.isFinite(frame.observedAt.milliseconds))?.observedAt;
    const frames = replay.envelopes.map((frame) => {
      const timing = frame.values.find((value) => value.semanticId === "timing.current-lap" && typeof value.value === "number" && value.state === "ok" && value.freshness === "fresh");
      const observedElapsed = firstObserved?.domain === frame.observedAt.domain
        ? (frame.observedAt.milliseconds - firstObserved.milliseconds) / 1000
        : 0;
      return { nativeTime: typeof timing?.value === "number" ? timing.value : Number.NaN, observedElapsed };
    });
    const originFrame = frames.find((frame) => Number.isFinite(frame.nativeTime) && frame.nativeTime >= 0);
    const origin = originFrame ? originFrame.nativeTime - Math.max(0, originFrame.observedElapsed) : null;
    const times = frames.map(({ nativeTime }) => origin === null || !Number.isFinite(nativeTime) || nativeTime < 0 ? Number.NaN : nativeTime - origin);
    native.push({ times });
  }
  const gaps = native.flatMap((recording, side) => {
    const valid = recording.times.filter(Number.isFinite);
    return valid.slice(1).flatMap((time, position) => {
      const previous = valid[position]!;
      const gap = time - previous;
      return gap > gapThresholdS && previous >= 0 ? [{ side, start: previous, end: previous + gap, duration: gap }] : [];
    });
  });
  const selectedGap = gaps.sort((a, b) => b.duration - a.duration)[0];
  if (!selectedGap) throw new Error("Spectate acceptance prerequisite missing: ACC seeded native timing.current-lap gap > 0.5 s");
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const clock = page.locator("[data-spectate-playback]");
  await expect(clock).toHaveAttribute("data-position-lock", "true");
  await page.getByRole("tab", { name: "Dynamics", exact: true }).click();
  await page.getByRole("switch", { name: "Lock cars to same track position" }).click();
  const seek = page.getByRole("slider", { name: "Replay position" });
  const bounds = await seek.boundingBox();
  if (!bounds) throw new Error("Replay position slider has no layout");
  const duration = Number(await clock.getAttribute("data-duration"));
  const target = selectedGap.start + selectedGap.duration * 0.55;
  if (!(target > 0 && target < duration)) throw new Error("Spectate acceptance prerequisite missing: ACC native gap falls outside replay duration");
  await seek.click({ position: { x: 8 + (bounds.width - 16) * (target / duration), y: bounds.height / 2 } });
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(selectedGap.start);
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeLessThan(selectedGap.end);
  const sideKey = selectedGap.side === 0 ? "a" : "b";
  await expect.poll(async () => clock.getAttribute(`data-${sideKey}-time`)).toBe("");
  await expect.poll(async () => page.locator("[data-channel-id='motion.speed'] canvas").first().getAttribute(`data-current-${sideKey}`)).toBe("—");
  await expect(page.locator(`[data-balance-side='${sideKey}']`)).toHaveAttribute("data-balance-state", "unavailable");
  await expect(page.locator(`[data-balance-side='${sideKey}']`)).toHaveText("—");
  await seek.press("Home");
  await seek.click({ position: { x: 8 + (bounds.width - 16) * (Math.min(duration - 0.2, selectedGap.end + 0.4) / duration), y: bounds.height / 2 } });
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(selectedGap.end);
  await expect.poll(async () => clock.getAttribute(`data-${sideKey}-time`)).not.toBe("");
  await expect.poll(async () => page.locator("[data-channel-id='motion.speed'] canvas").first().getAttribute(`data-current-${sideKey}`)).not.toBe("—");
});
test("iRacing Spectate projects measured geography without native world positions", async ({ page, request }) => {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "iracing" && candidate.supportedFeatures.includes("compare"));
  if (!game) throw new Error("Spectate acceptance prerequisite missing: seeded compare case for iracing");
  const pair = await getDistinctPair(request, "iracing");
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  let gps: Array<{ time: number; latitude: number; longitude: number }> = [];
  for (const lap of [pair.lapA, pair.lapB]) {
    // Read through the browser, retaining only reference channels across the protocol.
    // Full native replay bodies can exceed Chromium's inspector response cache.
    const replay = await page.evaluate(async (lapId) => {
      const response = await fetch(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": "iracing" } });
      if (!response.ok) throw new Error(`Native iRacing replay failed: ${response.status}`);
      const body = await response.json() as { envelopes: Array<{ values: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }> }> };
      const ids: Record<string, true | undefined> = { "motion.latitude": true, "motion.longitude": true, "motion.position-x": true, "motion.position-z": true, "timing.current-lap": true };
      return { envelopes: body.envelopes.map((frame) => ({ values: frame.values.filter((entry) => ids[entry.semanticId] === true) })) };
    }, lap.id);
    if (lap.id === pair.lapA.id) {
      const firstTime = replay.envelopes[0]!.values.find((entry) => entry.semanticId === "timing.current-lap")?.value;
      if (typeof firstTime !== "number") throw new Error("iRacing replay has no native lap clock");
      gps = replay.envelopes.flatMap((frame) => {
        const latitude = frame.values.find((entry) => entry.semanticId === "motion.latitude");
        const longitude = frame.values.find((entry) => entry.semanticId === "motion.longitude");
        const time = frame.values.find((entry) => entry.semanticId === "timing.current-lap")?.value;
        return typeof time === "number" && typeof latitude?.value === "number" && typeof longitude?.value === "number"
          && latitude.state === "ok" && longitude.state === "ok" && latitude.freshness === "fresh" && longitude.freshness === "fresh"
          ? [{ time: time - firstTime, latitude: latitude.value, longitude: longitude.value }] : [];
      });
      expect(gps.length, "iRacing canonical measured GPS samples").toBeGreaterThan(2);
    }
    for (const frame of replay.envelopes) {
      for (const id of ["motion.position-x", "motion.position-z"]) {
        const position = frame.values.find((entry) => entry.semanticId === id);
        expect(
          position && typeof position.value === "number" && Number.isFinite(position.value)
            && (position.state == null || position.state === "ok")
            && (position.freshness == null || position.freshness === "fresh"),
          `iRacing replay keeps unsupported ${id} unavailable`,
        ).toBe(false);
      }
    }
  }

  const scene = page.locator("[data-spectate-scene]");
  await expect.poll(async () => scene.getAttribute("data-scene-ready")).toBe("true");
  await expect(scene).toHaveAttribute("data-scene-error", "");
  await expect(scene).toHaveAttribute("data-side-a-state", "ready");
  await expect(scene).toHaveAttribute("data-side-b-state", "ready");
  const canvas = scene.locator("canvas").first();
  for (const side of ["a", "b"] as const) {
    await expect.poll(async () => canvas.getAttribute(`data-${side}-x`)).not.toBe("");
    await expect.poll(async () => canvas.getAttribute(`data-${side}-z`)).not.toBe("");
  }
  const map = page.getByRole("group", { name: "Circuit segment map" });
  await expect(map).toBeVisible();
  const segmentButtons = map.getByRole("button");
  expect(await segmentButtons.count(), "iRacing circuit segments").toBeGreaterThan(1);
  await expect(segmentButtons.filter({ has: page.locator("text", { hasText: /^T1$/ }) })).toBeVisible();
  await expect(segmentButtons.filter({ has: page.locator("text", { hasText: /^T2$/ }) })).toBeVisible();
  await expect(map.locator("text").filter({ hasText: /^19$/ })).toHaveCount(0);

  const clock = page.locator("[data-spectate-playback]");
  const seek = page.getByRole("slider", { name: "Replay position" });
  await seek.press("Home");
  const initialX = Number(await canvas.getAttribute("data-a-x"));
  const initialZ = Number(await canvas.getAttribute("data-a-z"));
  const bounds = await seek.boundingBox();
  if (!bounds) throw new Error("Replay slider has no layout");
  const duration = Number(await clock.getAttribute("data-duration"));
  await seek.click({ position: { x: 8 + (bounds.width - 16) * (10 / duration), y: bounds.height / 2 } });
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(9);
  await expect.poll(async () => Number(await canvas.getAttribute("data-render-time"))).toBeGreaterThan(9);
  const time = Number(await canvas.getAttribute("data-render-time"));
  const gpsAt = (target: number) => {
    const index = gps.findIndex((sample) => sample.time >= target);
    if (index < 0) throw new Error("Replay cursor outside measured GPS span");
    const after = gps[index]!, before = gps[Math.max(0, index - 1)]!;
    const fraction = after.time === before.time ? 0 : (target - before.time) / (after.time - before.time);
    return {
      latitude: before.latitude + (after.latitude - before.latitude) * fraction,
      longitude: before.longitude + (after.longitude - before.longitude) * fraction,
    };
  };
  const first = gpsAt(0), current = gpsAt(time);
  const metresPerDegree = Math.PI / 180 * 6_378_137;
  const eastScale = metresPerDegree * Math.cos(first.latitude * Math.PI / 180);
  const expectedX = -(current.longitude - first.longitude) * eastScale;
  const expectedZ = (current.latitude - first.latitude) * metresPerDegree;
  expect(Number(await canvas.getAttribute("data-a-x")) - initialX, "Compare mirrors X like replay's map").toBeCloseTo(expectedX, 0);
  expect(Number(await canvas.getAttribute("data-a-z")) - initialZ, "Compare preserves forward north-south travel").toBeCloseTo(expectedZ, 0);
  const before = gpsAt(time - 0.05), after = gpsAt(time + 0.05);
  const dx = -(after.longitude - before.longitude) * eastScale;
  const dz = (after.latitude - before.latitude) * metresPerDegree;
  const yaw = Number(await canvas.getAttribute("data-a-yaw"));
  expect((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / Math.hypot(dx, dz), "Car faces its forward path, not backward").toBeGreaterThan(0.95);
  await seek.press("Home");
  await expect(clock).toHaveAttribute("data-time", "0");
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(clock).toHaveAttribute("data-playing", "true");
  const beforePlay = Number(await clock.getAttribute("data-time"));
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(beforePlay);
  await page.getByRole("button", { name: "Pause replay" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(async () => scene.getAttribute("data-scene-ready")).toBe("true");
  await expect(scene).toHaveAttribute("data-scene-error", "");
  for (const side of ["a", "b"] as const) {
    await expect.poll(async () => canvas.getAttribute(`data-${side}-x`)).not.toBe("");
    await expect.poll(async () => canvas.getAttribute(`data-${side}-z`)).not.toBe("");
  }
  await expect(map).toBeVisible();
});

test("FM Spectate segment seeking retargets and pauses", async ({ page, request }) => {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "fm-2023" && candidate.supportedFeatures.includes("compare"));
  if (!game) throw new Error("Spectate acceptance prerequisite missing: seeded compare case for fm-2023");
  const pair = await getDistinctPair(request, "fm-2023");
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const clock = page.locator("[data-spectate-playback]");
  await expect.poll(async () => page.locator("[data-spectate-scene]").getAttribute("data-scene-ready")).toBe("true");
  const canvas = page.locator("[data-spectate-scene] canvas").first();
  for (const side of ["a", "b"] as const) {
    await expect.poll(async () => Number(await canvas.getAttribute(`data-${side}-wheel-count`))).toBeGreaterThan(0);
    expect(await canvas.getAttribute(`data-${side}-model-path`)).toBeTruthy();
  }
  const map = page.getByRole("group", { name: "Circuit segment map" });
  const segments = map.getByRole("button");
  expect(await segments.count()).toBeGreaterThan(1);
  const overview = page.getByRole("region", { name: "Circuit overview", exact: true });
  await page.mouse.move(0, 0);
  await expect(segments.first()).toHaveCSS("opacity", "0");
  await expect(segments.first()).toHaveCSS("pointer-events", "none");
  await overview.hover();
  await expect(segments.first()).toHaveCSS("opacity", "1");
  await expect(segments.first()).toHaveCSS("pointer-events", "auto");
  const last = segments.last();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Play replay" }).click();
  const initialDistance = Number(await clock.getAttribute("data-a-distance"));
  const finalDistance = Number(await last.getAttribute("data-seek-distance"));
  const intermediate = await last.evaluate((button, initial) => new Promise<number | null>((resolve) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const clock = document.querySelector<HTMLElement>("[data-spectate-playback]")!;
    const sample = () => {
      const distance = Number(clock.dataset.aDistance);
      if (clock.dataset.seeking === "true" && distance > initial.initialDistance && distance < initial.finalDistance) {
        button.closest('[role="group"]')!.querySelector('[role="button"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        resolve(distance);
      } else if (clock.dataset.seeking === "false") resolve(null);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), { initialDistance, finalDistance });
  expect(intermediate, "forward seek exposes an intermediate native position before retargeting backward").not.toBeNull();
  await expect(clock).toHaveAttribute("data-seeking", "true");
  await page.getByRole("button", { name: "Pause replay" }).click();
  await expect(clock).toHaveAttribute("data-seeking", "false");
  await expect(clock).toHaveAttribute("data-playing", "false");
  const settled = Number(await clock.getAttribute("data-time"));
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeCloseTo(settled, 2);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const final = segments.last();
  await overview.hover();
  await final.click();
  const distance = Number(await clock.getAttribute("data-a-distance"));
  const expected = Number(await final.getAttribute("data-seek-distance"));
  expect(distance).toBeCloseTo(expected, 2);
  await expect(clock).toHaveAttribute("data-seeking", "false");
});
