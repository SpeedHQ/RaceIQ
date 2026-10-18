import { expect, test } from "@playwright/test";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { compareQuery, getDistinctPair } from "./interaction-helpers";
const gapThresholdS = 0.5;
const lapWideIds = ["mech-fuel", "tire-wear-imbalance", "tire-temp-split", "tire-pressure-imbalance", "susp-imbalance"];

test("ACC Spectate preserves recorded gaps and recovers beyond them", async ({ page, request }) => {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "acc" && candidate.supportedFeatures.includes("compare"));
  if (!game) throw new Error("Spectate acceptance prerequisite missing: seeded compare case for acc");
  const pair = await getDistinctPair(request, "acc");
  type Frame = { values: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }> };
  const native: Array<{ times: number[] }> = [];
  for (const lap of [pair.lapA, pair.lapB]) {
    const result = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": "acc" } });
    expect(result.ok(), `ACC native replay for lap ${lap.id}`).toBe(true);
    const replay = (await result.json()) as { envelopes: Frame[] };
    const times = replay.envelopes.map((frame) => {
      const timing = frame.values.find((value) => value.semanticId === "timing.current-lap" && typeof value.value === "number" && value.state === "ok" && value.freshness === "fresh");
      return typeof timing?.value === "number" ? timing.value : Number.NaN;
    });
    native.push({ times });
  }
  const gaps = native.flatMap((recording, side) => {
    const valid = recording.times.filter(Number.isFinite);
    const origin = valid[0];
    if (origin == null) return [];
    return valid.slice(1).flatMap((time, position) => {
      const previous = valid[position]!;
      const gap = time - previous;
      const start = previous - origin;
      return gap > gapThresholdS && start >= 0 ? [{ side, start, end: start + gap, duration: gap }] : [];
    });
  });
  const selectedGap = gaps.sort((a, b) => b.duration - a.duration)[0];
  if (!selectedGap) throw new Error("Spectate acceptance prerequisite missing: ACC seeded native timing.current-lap gap > 0.5 s");
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
  const clock = page.locator("[data-spectate-playback]");
  await expect(clock).toHaveAttribute("data-position-lock", "true");
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
  await seek.press("Home");
  await seek.click({ position: { x: 8 + (bounds.width - 16) * (Math.min(duration - 0.2, selectedGap.end + 0.4) / duration), y: bounds.height / 2 } });
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(selectedGap.end);
  await expect.poll(async () => clock.getAttribute(`data-${sideKey}-time`)).not.toBe("");
  await expect.poll(async () => page.locator("[data-channel-id='motion.speed'] canvas").first().getAttribute(`data-current-${sideKey}`)).not.toBe("—");
});

test("FM Spectate segment seeking retargets, pauses, and excludes lap-wide issue IDs", async ({ page, request }) => {
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
  const ids = await segments.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-insight-ids") ?? ""));
  for (const id of lapWideIds) expect(ids.join("|")).not.toContain(id);
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
