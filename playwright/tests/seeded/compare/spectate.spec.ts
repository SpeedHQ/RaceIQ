import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { getTelemetryVariable, isTelemetryVariableId } from "@raceiq/shared/telemetry/catalog/query";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLaps } from "./helpers";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

async function animationFrames(page: Page, count: number) {
  await page.evaluate(
    (total) =>
      new Promise<void>((resolve) => {
        let remaining = total;
        const next = () => {
          if (--remaining <= 0) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
    count,
  );
}
const requiredGames = ["fm-2023", "acc"] as const;
for (const gameId of requiredGames) {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === gameId && candidate.supportedFeatures.includes("compare"));
  if (!game) throw new Error(`Spectate acceptance prerequisite missing: seeded compare case for ${gameId}`);

  test(`${game.name} Spectate uses recorded replay and keeps controls/layout coherent`, async ({ page, request }, testInfo) => {
    test.setTimeout(200_000);
    const browserErrors = collectBrowserErrors(page);
    const laps = await getSeededLaps(request, game.gameId);
    const pair = await getDistinctPair(request, game.gameId);
    const replays: Array<{ requestedSemanticIds: string[]; envelopes: Array<{ values: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }> }> }> = [];
    for (const lap of [pair.lapA, pair.lapB]) {
      const found = laps.find((candidate) => candidate.id === lap.id);
      if (!found) throw new Error(`${game.gameId} seeded lap ${lap.id} disappeared from live API`);
      const replay = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { headers: { "X-Game-Id": game.gameId } });
      expect(replay.ok(), `${game.gameId} recorded semantic replay for lap ${lap.id}`).toBe(true);
      const recorded = (await replay.json()) as (typeof replays)[number];
      expect(recorded.envelopes.length, `${game.gameId} native replay envelopes for lap ${lap.id}`).toBeGreaterThan(2);
      replays.push(recorded);
    }

    await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#compare-tab-spectate")).toHaveAttribute("aria-selected", "true");
    const body = page.locator("[data-spectate-view]");
    await expect(body).toBeVisible();
    const split = page.getByRole("button", { name: "Split recordings", exact: true });
    if (await split.isVisible()) await split.click();
    const replayClock = page.locator("[data-spectate-playback]");
    await expect(replayClock).toHaveAttribute("data-duration", /[1-9]/);
    await expect.poll(async () => page.locator("[data-spectate-scene]").getAttribute("data-scene-ready")).toBe("true");
    await expect(page.locator('canvas[data-renderer-backend="webgpu"], canvas[data-renderer-backend="webgl2"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Driver input comparison" })).toBeVisible();
    expect(Number(await replayClock.getAttribute("data-time")), "aligned cursor deep link enters at its physical location").toBeGreaterThan(0);
    await page.getByRole("slider", { name: "Replay position" }).press("Home");
    await expect.poll(async () => Number(await replayClock.getAttribute("data-time"))).toBe(0);
    await animationFrames(page, 3);

    const renderedCanvas = page.locator("[data-spectate-scene] canvas").first();
    if (game.gameId === "fm-2023") await expect.poll(async () => Number(await renderedCanvas.getAttribute("data-track-edge-count"))).toBeGreaterThan(0);
    for (const side of ["a", "b"]) {
      await expect.poll(async () => Number(await renderedCanvas.getAttribute(`data-${side}-racing-line-segments`))).toBeGreaterThan(0);
      await expect.poll(async () => Number(await renderedCanvas.getAttribute(`data-${side}-brake-segments`))).toBeGreaterThan(0);
      await expect.poll(async () => Number(await renderedCanvas.getAttribute(`data-${side}-throttle-segments`))).toBeGreaterThan(0);
    }
    for (const [index, side] of ["a", "b"].entries()) {
      const initialFrame = replays[index]!.envelopes[0]!;
      for (const [field, semanticId] of [
        ["x", "motion.position-x"],
        ["z", "motion.position-z"],
        ["yaw", "motion.yaw"],
      ] as const) {
        const expected = initialFrame.values.find(
          (entry) => entry.semanticId === semanticId && (entry.state == null || entry.state === "ok") && (entry.freshness == null || entry.freshness === "fresh"),
        )?.value;
        expect(typeof expected, `${game.gameId} fixture ${side} has recorded ${semanticId}`).toBe("number");
        const rendered = await renderedCanvas.getAttribute(`data-${side}-${field}`);
        expect(rendered).not.toBe("");
        expect(Number(rendered), `${side} rendered ${field} matches native recording`).toBeCloseTo(Number(expected), 2);
      }
    }
    const expectedChannels = new Set(replays.flatMap((replay) => replay.requestedSemanticIds).filter((id) => isTelemetryVariableId(id) && getTelemetryVariable(id).valueType === "number"));
    const actualChannels = new Set(await page.locator("[data-channel-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-channel-id"))));
    for (const id of expectedChannels) expect(actualChannels.has(id), `${game.gameId} replay-visible channel ${id}`).toBe(true);
    const initialTime = Number(await replayClock.getAttribute("data-time"));
    const initialLock = await replayClock.getAttribute("data-position-lock");
    expect(initialLock).toBe("true");
    const lock = page.getByRole("switch", { name: "Lock cars to same track position" });
    await lock.click();
    await expect(replayClock).toHaveAttribute("data-position-lock", "false");
    expect(Number(await replayClock.getAttribute("data-time"))).toBe(initialTime);
    await lock.click();
    await expect(replayClock).toHaveAttribute("data-position-lock", "true");
    expect(Number(await replayClock.getAttribute("data-time"))).toBe(initialTime);

    const seek = page.getByRole("slider", { name: "Replay position" });
    await seek.focus();
    await seek.press("Home");
    await expect.poll(async () => Number(await replayClock.getAttribute("data-time"))).toBeCloseTo(0, 3);
    await seek.press("End");
    await expect.poll(async () => Number(await replayClock.getAttribute("data-time"))).toBeGreaterThan(initialTime);
    await lock.click();
    await expect(replayClock).toHaveAttribute("data-position-lock", "false");
    expect(Number(await replayClock.getAttribute("data-time"))).toBeGreaterThan(initialTime);
    await seek.press("Home");
    const sliderBounds = await seek.boundingBox();
    if (!sliderBounds) throw new Error("Replay slider has no layout");
    await seek.click({ position: { x: sliderBounds.width / 2, y: sliderBounds.height / 2 } });
    await expect.poll(async () => Math.abs(Number(await replayClock.getAttribute("data-a-time")) - Number(await replayClock.getAttribute("data-b-time")))).toBeLessThan(0.02);
    await lock.click();
    await expect(replayClock).toHaveAttribute("data-position-lock", "true");
    await page.getByRole("button", { name: "Play replay" }).click();
    await expect(replayClock).toHaveAttribute("data-playing", "true");
    const beforePlayback = Number(await replayClock.getAttribute("data-time"));
    await expect.poll(async () => Number(await replayClock.getAttribute("data-time"))).toBeGreaterThan(beforePlayback + 0.05);
    await page.getByRole("button", { name: "Pause replay" }).click();
    await expect(replayClock).toHaveAttribute("data-playing", "false");
    const pausedAt = Number(await replayClock.getAttribute("data-time"));
    await animationFrames(page, 30);
    expect(Number(await replayClock.getAttribute("data-time"))).toBe(pausedAt);

    await page.getByRole("tab", { name: "Compare" }).click();
    await expect(page.getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Spectate" }).click();
    await expect(replayClock).toBeVisible();
    await expect(replayClock).toHaveAttribute("data-playing", "false");
    const roundTripTime = Number(await replayClock.getAttribute("data-time"));
    await page.goBack();
    await expect(page.getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(page.getByRole("tab", { name: "Spectate" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => Number(await replayClock.getAttribute("data-time"))).toBeCloseTo(roundTripTime, 2);

    const reduceMotion = await page.emulateMedia({ reducedMotion: "reduce" });
    void reduceMotion;
    const overview = page.getByRole("group", { name: "Circuit segment map" });
    await expect(overview).toBeVisible();
    const segmentButtons = overview.getByRole("button");
    expect(await segmentButtons.count(), "authoritative seeded segment actions").toBeGreaterThan(0);
    await segmentButtons.last().focus();
    await segmentButtons.last().press("Enter");
    const segmentTime = Number(await replayClock.getAttribute("data-time"));
    expect(segmentTime).not.toBe(roundTripTime);
    await expect(replayClock).toHaveAttribute("data-playing", "false");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const separator = page.getByRole("separator", { name: "Resize telemetry panel" });
    const widthBefore = Number(await body.getAttribute("data-panel-width"));
    await separator.focus();
    await separator.press("ArrowLeft");
    await expect.poll(async () => Number(await body.getAttribute("data-panel-width"))).toBeGreaterThan(widthBefore);
    const resized = await body.getAttribute("data-panel-width");
    await page.getByRole("button", { name: "Collapse telemetry" }).click();
    await expect(body).toHaveAttribute("data-panel-collapsed", "true");
    await expect(page.getByRole("group", { name: "Circuit segment map" })).toBeVisible();
    await page.getByRole("button", { name: "Show telemetry" }).click();
    await expect(body).toHaveAttribute("data-panel-collapsed", "false");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(body).toBeVisible();
    await expect(body).toHaveAttribute("data-panel-width", resized!);
    const axes = page.locator("[data-channel-id]");
    expect(await axes.count()).toBeGreaterThan(0);
    expect(await axes.evaluateAll((rows) => rows.every((row) => row.getAttribute("data-axis-start") === "-10" && row.getAttribute("data-axis-end") === "10"))).toBe(true);
    const render = body.locator("main");
    const panel = page.getByRole("complementary", { name: "Telemetry", exact: true });
    const renderBox = await render.boundingBox(),
      panelBox = await panel.boundingBox(),
      playbackBox = await replayClock.boundingBox();
    if (!renderBox || !panelBox || !playbackBox) throw new Error("Spectate layout is not measurable");
    expect(Math.abs(playbackBox.x + playbackBox.width - panelBox.x)).toBeLessThan(2);
    expect(Math.abs(panelBox.y + panelBox.height - (playbackBox.y + playbackBox.height))).toBeLessThan(2);
    const sceneCanvas = page.locator("[data-spectate-scene] canvas").first();
    await animationFrames(page, 30);
    const settledRenders = await sceneCanvas.getAttribute("data-render-count");
    await animationFrames(page, 30);
    expect(await sceneCanvas.getAttribute("data-render-count"), "paused scene stops drawing").toBe(settledRenders);
    await expect(page.getByRole("tab", { name: "Spectate" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(new RegExp(`lapA=${pair.lapA.id}.*lapB=${pair.lapB.id}`));

    await page.screenshot({ path: testInfo.outputPath(`${game.gameId}-spectate-desktop.png`), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(body).toHaveAttribute("data-panel-collapsed", "true");
    await page.getByRole("button", { name: "Show telemetry" }).click();
    await expect(page.getByRole("complementary", { name: "Telemetry" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${game.gameId}-spectate-narrow.png`), fullPage: true, animations: "disabled" });

    expect(browserErrors.errors).toEqual([]);

    await page.route("**/api/laps/*/semantic-telemetry", (route) => route.abort("failed").catch(() => undefined));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toBeVisible();
  });
}
