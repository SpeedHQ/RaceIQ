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
  await final.click();
  const distance = Number(await clock.getAttribute("data-a-distance"));
  const expected = Number(await final.getAttribute("data-seek-distance"));
  expect(distance).toBeCloseTo(expected, 2);
  await expect(clock).toHaveAttribute("data-seeking", "false");
});
