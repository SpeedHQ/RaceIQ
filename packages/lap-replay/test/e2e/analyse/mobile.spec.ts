import { expect, test } from "@playwright/test";
import { getSeededLapMeta } from "../../../../../playwright/tests/support/seeded/laps";

for (const [gameId, prefix] of [["fm-2023", "fm23"], ["f1-2025", "f125"]] as const) {
  test(`Replay keeps mobile controls and compact dashboard usable for ${gameId}`, async ({ page, request }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("replay-data-open", "true");
      for (const panel of ["telemetry", "car", "insights", "segments", "ai"]) localStorage.setItem(`replay-${panel}-open`, "false");
    });
    const lap = await getSeededLapMeta(request, gameId);
    await page.goto(`/${prefix}/sessions/${lap.sessionId}/replay/${lap.id}`);
    const workspace = page.locator("[data-spectate-workspace]");
    const clock = workspace.locator("[data-spectate-playback]");
    const scene = workspace.locator("[data-replay-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true");
    const dash = workspace.getByRole("region", { name: "Inputs", exact: true });
    const overview = workspace.getByRole("region", { name: "Circuit overview", exact: true });
    await expect(overview).toHaveCSS("opacity", "1");
    expect((await overview.boundingBox())!.width).toBeGreaterThan(280);
    const marker = overview.locator('[data-seek-distance]').nth(1);
    const distance = Number(await marker.getAttribute("data-seek-distance"));
    await marker.click();
    await expect.poll(async () => Math.abs(Number(await clock.getAttribute("data-a-distance")) - distance)).toBeLessThan(5);
    await scene.getByRole("button", { name: "Close Circuit overview", exact: true }).click();
    await expect(overview).toHaveCount(0);
    await scene.getByRole("switch", { name: "Circuit overview", exact: true }).click();
    await expect(overview).toHaveCSS("opacity", "1");
    await scene.getByRole("button", { name: "Close Circuit overview", exact: true }).click();
    const rail = workspace.locator("[data-panel-rail]");
    for (const size of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 800, height: 390 }]) {
      await page.setViewportSize(size);
      await expect.poll(async () => {
        const [playback, panels] = await Promise.all([clock.boundingBox(), rail.boundingBox()]);
        return panels!.y >= playback!.y + playback!.height;
      }).toBe(true);
      const tabs = workspace.locator("[data-mobile-panel-tabs]");
      const [playbackBox, tabsBox] = await Promise.all([clock.boundingBox(), tabs.boundingBox()]);
      expect(tabsBox!.y).toBeGreaterThanOrEqual(playbackBox!.y + playbackBox!.height);
      expect(await tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(rail.locator("aside > section")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await scene.evaluate((element) => element.clientHeight)).toBeGreaterThan(250);
      expect(await dash.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (size.width < 640) {
        expect((await dash.boundingBox())!.height).toBeLessThan(160);
        const tops = await dash.locator(":scope > div").evaluateAll((elements) => elements.slice(0, 5).map((element) => element.getBoundingClientRect().top));
        expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
        for (const button of await workspace.locator('[role="toolbar"] button, [data-spectate-playback] button').all()) {
          expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await clock.scrollIntoViewIfNeeded();
    await workspace.locator("[data-mobile-panel-tabs]").hover();
    await page.mouse.wheel(0, 200);
    const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
    const header = page.locator("[data-replay-page-header]");
    const navigationHeader = page.locator("header").filter({ has: navigation });
    await expect.poll(async () => {
      const box = (await header.boundingBox())!;
      const menu = (await navigationHeader.boundingBox())!;
      return box.y + box.height <= menu.y + menu.height;
    }).toBe(true);
    await expect(navigation).toBeInViewport();
    await header.scrollIntoViewIfNeeded();
    await expect(header.getByRole("combobox", { name: "Search laps...", exact: true })).toBeInViewport();
    await expect(navigation).toBeInViewport();
    const seek = clock.getByRole("slider", { name: "Replay position", exact: true });
    await seek.press("Home");
    await seek.press("ArrowRight");
    await expect(clock).toHaveAttribute("data-time", "0.001");
    await clock.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("2");
    await clock.getByRole("button", { name: "Play replay", exact: true }).click();
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0.001);
    await clock.getByRole("button", { name: "Pause replay", exact: true }).click();
    await expect(clock).toHaveAttribute("data-playing", "false");
    const segments = workspace.locator('[data-panel-toggle="replay-segments-panel"]');
    await segments.click();
    await expect.poll(async () => Math.abs((await workspace.locator("#replay-segments-panel").boundingBox())!.x - (await rail.boundingBox())!.x)).toBeLessThanOrEqual(1);
    await expect(workspace.locator("#replay-data-panel")).toHaveCount(0);
    await expect(rail.locator("aside > section")).toHaveCount(1);
    expect(await rail.locator("aside").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await segments.click();
    await expect(workspace.locator("#replay-segments-panel")).toHaveCount(0);
    await workspace.locator('[data-panel-toggle="replay-data-panel"]').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const separator = page.getByRole("separator", { name: "Resize panels", exact: true });
    await expect(separator).toBeVisible();
    const before = Number(await separator.getAttribute("aria-valuenow"));
    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", String(before - 20));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(separator).toHaveCount(0);
    await expect(workspace.locator("#replay-data-panel")).toBeVisible();
    await expect(dash.getByText("Steering input", { exact: true })).toBeVisible();
  });
}
