import { expect, test } from "@playwright/test";
import { SEEDED_GAME_CASES } from "../../../../../playwright/tests/support/seeded/cases"
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers"

for (const gameId of ["fm-2023", "f1-2025"] as const) {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === gameId);
  if (!game) throw new Error(`Focus acceptance requires ${gameId}`);
  test(`${gameId} focus colors both surfaces without changing replay`, async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("spectate-track-overview", "true"));
    const pair = await getDistinctPair(request, gameId);
    await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
    const split = page.getByRole("button", { name: "Split recordings", exact: true });
    await page.addLocatorHandler(split, () => split.click());
    const scene = page.locator("[data-spectate-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    for (const name of ["Telemetry", "Car layout"]) {
      const panel = page.getByRole("button", { name, exact: true });
      if (await panel.getAttribute("aria-pressed") === "true") await panel.click();
    }
    const canvas = scene.locator("canvas").first();
    const modelToggle = scene.locator("[data-spectate-car-model-toggle]");
    await expect(modelToggle).toHaveCount(1);
    await expect(modelToggle).toHaveAttribute("data-car-model-mode", "solid");
    for (const mode of ["hidden", "wire", "solid"]) {
      await modelToggle.click();
      await expect(modelToggle).toHaveAttribute("data-car-model-mode", mode);
      await expect(canvas).toHaveAttribute("data-car-model-mode", mode);
    }
    if (gameId === "f1-2025") {
      const zoomIndicator = scene.locator("[data-spectate-zoom-indicator]");
      await expect(zoomIndicator).toBeVisible();
      const end = Number(await zoomIndicator.getAttribute("data-snap-zone-end"));
      const position = Number(await zoomIndicator.getAttribute("data-zoom-position"));
      expect(end).toBeGreaterThan(0);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThanOrEqual(1);
    }
    await canvas.evaluate((node) => {
      const data = (node as HTMLCanvasElement).dataset;
      const evidence = { transitions: [] as string[], violations: [] as string[], checkingModelModes: false };
      let lastFrame: string | undefined;
      const observeFrame = () => {
        if (evidence.checkingModelModes) return;
        if (!data.renderCount || data.renderCount === lastFrame) return;
        lastFrame = data.renderCount;
        const layout = data.lineLayout;
        if (!layout) return;
        if (evidence.transitions.at(-1) !== layout) evidence.transitions.push(layout);
        if (data.focusLaneAvailable !== "true") return;
        for (const side of ["a", "b"]) {
          if (!data[`${side}X`]) continue;
          const label = data[`${side}MarkerVisible`], opacity = data[`${side}MarkerOpacity`], car = data[`${side}CarVisible`];
          const valid = layout === "schematic" ? label === "true" && opacity === "1" && car === "false" : label === "false" && car === "true";
          if (!valid && evidence.violations.length < 10) evidence.violations.push(`${layout} frame ${lastFrame}, ${side}: label=${label}, opacity=${opacity}, car=${car}`);
        }
      };
      const observer = new MutationObserver(observeFrame);
      observer.observe(node, { attributes: true, attributeFilter: ["data-render-count"] });
      Reflect.set(node, "zoomTransitionEvidence", evidence);
      observeFrame();
    });
    const clock = page.locator("[data-spectate-playback]");
    const overview = page.getByRole("region", { name: "Circuit overview", exact: true });
    const toolbar = page.getByRole("toolbar", { name: "Focus mode", exact: true });
    await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
    const sceneBounds = await canvas.boundingBox();
    const toolbarBounds = await toolbar.boundingBox();
    expect(toolbarBounds!.height).toBeGreaterThan(toolbarBounds!.width);
    expect(sceneBounds!.x + sceneBounds!.width - toolbarBounds!.x - toolbarBounds!.width).toBeCloseTo(12, 0);
    await expect(toolbar.getByRole("button", { name: "Inputs", exact: true })).toHaveAttribute("aria-pressed", "true");
    const focusInputButton = toolbar.getByRole("button", { name: "Inputs", exact: true });
    await expect(focusInputButton).not.toHaveAttribute("title");
    await focusInputButton.hover();
    await expect(page.getByRole("tooltip", { name: "Inputs", exact: true })).toBeVisible();
    await focusInputButton.focus();
    await expect(page.getByRole("tooltip", { name: "Inputs", exact: true })).toBeVisible();
    const sceneToolbar = scene.getByRole("toolbar", { name: "Follow car A direction", exact: true });
    const overviewButton = sceneToolbar.getByRole("switch", { name: "Circuit overview", exact: true });
    await expect(overviewButton).not.toHaveAttribute("title");
    await overviewButton.hover();
    await expect(page.getByRole("tooltip", { name: "Circuit overview", exact: true })).toBeVisible();
    const initialTime = await clock.getAttribute("data-time");
    const scenarios = [
      { label: "Speed", mode: "speed", token: "--telemetry-ers-mode-hotlap" },
      { label: "Balance", mode: "balance", token: gameId === "fm-2023" ? "--balance-neutral" : null },
      { label: "ERS mode", mode: "ers", token: null },
      { label: "Inputs", mode: "inputs", token: "--ch-throttle" },
    ];
    for (const scenario of scenarios) {
      const button = toolbar.getByRole("button", { name: scenario.label, exact: true });
      await button.focus();
      await button.press("Enter");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(canvas).toHaveAttribute("data-focus-mode", scenario.mode);
      await expect(overview).toHaveAttribute("data-focus-mode", scenario.mode);
      await expect(clock).toHaveAttribute("data-time", initialTime!);
      for (const side of ["a", "b"]) {
        if (scenario.token) await expect(overview.locator(`[data-focus-lap='${side}'][data-focus-color='${scenario.token}']`).first()).toBeVisible();
        if (scenario.mode === "ers") {
          const mode = gameId === "f1-2025" ? await page.locator("[data-battery-mode-a]").getAttribute(`data-battery-mode-${side}`) : null;
          const names = ["none", "medium", "hotlap", "overtake"];
          const expected = mode !== null && /^[0-3]$/.test(mode) ? `--telemetry-ers-mode-${names[Number(mode)]}` : "--app-text-muted";
          await expect(overview.locator(`[data-focus-lap='${side}'][data-focus-color='${expected}']`).first(), `${side} line agrees with recorded deployment mode in replay instruments`).toBeVisible();
        }
      }
    }
    await expect(canvas).toHaveAttribute("data-focus-lane-available", "true");
    await expect(canvas).toHaveAttribute("data-line-layout", "schematic");
    await expect(canvas).toHaveAttribute("data-native-view-visible", "false");
    const laneWidth = Number(await canvas.getAttribute("data-schematic-line-width"));
    const laneOffset = Number(await canvas.getAttribute("data-schematic-lane-offset"));
    expect(laneWidth).toBeGreaterThan(0);
    expect(laneWidth).toBeLessThanOrEqual(3.75);
    expect(laneOffset).toBeGreaterThanOrEqual(1.5);
    expect(laneOffset).toBeLessThanOrEqual(3);
    for (const side of ["a", "b"]) {
      await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "true");
      await expect(canvas).toHaveAttribute(`data-${side}-marker-opacity`, "1");
      await expect(canvas).toHaveAttribute(`data-${side}-car-visible`, "false");
      await expect.poll(async () => Number(await canvas.getAttribute(`data-${side}-focus-lane-segments`))).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath("focus-lanes-far.png"), animations: "disabled" });
    if (gameId === "fm-2023") {
      const zoomUntil = async (delta: number, layout: string) => {
        for (let i = 0; i < 32; i++) {
          if (await canvas.getAttribute("data-line-layout") === layout) return;
          const box = await canvas.boundingBox();
          if (!box) throw new Error("Missing scene bounds");
          await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
          await page.mouse.wheel(0, delta);
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        }
        await expect(canvas).toHaveAttribute("data-line-layout", layout);
      };
      await zoomUntil(-360, "recorded");
      await expect(canvas).toHaveAttribute("data-native-view-visible", "true");
      for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-marker-visible`, "false");
      for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-car-visible`, "true");
      await expect(clock).toHaveAttribute("data-time", initialTime!);
      await page.screenshot({ path: testInfo.outputPath("focus-lanes-near.png"), animations: "disabled" });
      await canvas.evaluate((node) => { Reflect.get(node, "zoomTransitionEvidence").checkingModelModes = true; });
      for (const mode of ["hidden", "wire", "solid"]) {
        await modelToggle.click();
        for (const side of ["a", "b"]) {
          await expect(canvas).toHaveAttribute(`data-${side}-car-visible`, String(mode !== "hidden"));
          await expect(canvas).toHaveAttribute(`data-${side}-chassis-visible`, String(mode !== "solid"));
          await expect(canvas).toHaveAttribute(`data-${side}-wheel-visible-count`, "4");
        }
        await page.screenshot({ path: testInfo.outputPath(`compare-native-${mode}-chassis.png`), animations: "disabled" });
      }
      const tireInfo = scene.getByRole("switch", { name: "Tire Info", exact: true });
      await tireInfo.click();
      await expect(tireInfo).toHaveAttribute("aria-checked", "true");
      for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-tire-info-visible-count`, "4");
      await page.screenshot({ path: testInfo.outputPath("compare-native-tire-info.png"), animations: "disabled" });
      await tireInfo.click();
      for (const side of ["a", "b"]) await expect(canvas).toHaveAttribute(`data-${side}-tire-info-visible-count`, "0");
      await canvas.evaluate((node) => { Reflect.get(node, "zoomTransitionEvidence").checkingModelModes = false; });
      await zoomUntil(360, "schematic");
      await expect(canvas).toHaveAttribute("data-native-view-visible", "false");
      for (const side of ["a", "b"]) {
        await expect(canvas).toHaveAttribute(`data-${side}-marker-opacity`, "1");
        await expect(canvas).toHaveAttribute(`data-${side}-car-visible`, "false");
      }
      await page.screenshot({ path: testInfo.outputPath("focus-lanes-mid.png"), animations: "disabled" });
      await expect(clock).toHaveAttribute("data-time", initialTime!);
    }
    await toolbar.getByRole("button", { name: "Speed", exact: true }).click();
    await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("0.25");
    await page.getByRole("slider", { name: "Replay position" }).fill("20");
    await page.keyboard.press("Space");
    await expect(clock).toHaveAttribute("data-playing", "true");
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(20.05);
    await page.keyboard.press("Space");
    await expect(clock).toHaveAttribute("data-playing", "false");
    await expect(canvas).toHaveAttribute("data-focus-mode", "speed");
    const segment = overview.locator("[data-seek-distance]").nth(1);
    const distance = Number(await segment.getAttribute("data-seek-distance"));
    await segment.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => Number(await clock.getAttribute("data-a-distance"))).toBeCloseTo(distance, 1);
    await page.screenshot({ path: testInfo.outputPath(`${gameId}-focus-desktop.png`), animations: "disabled" });
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(page.locator("[data-mobile-panel-tabs]")).toBeVisible();
    const carPanel = page.getByRole("button", { name: "Car layout", exact: true });
    await carPanel.focus();
    await carPanel.press("Enter");
    await expect(carPanel).toHaveAttribute("aria-pressed", "true");
    await carPanel.click();
    await expect(carPanel).toHaveAttribute("aria-pressed", "false");
    await toolbar.getByRole("button", { name: "Speed", exact: true }).click();
    await expect(toolbar.getByRole("button", { name: "Speed", exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Inputs", "Balance", "Speed", "ERS mode"]) {
      await toolbar.getByRole("button", { name, exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(toolbar.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await expect(toolbar).toBeVisible();
    const bounds = await toolbar.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
    await page.screenshot({ path: testInfo.outputPath(`${gameId}-focus-mobile.png`), animations: "disabled" });
    expect(errors).toEqual([]);
    const evidence = await canvas.evaluate((node) => Reflect.get(node, "zoomTransitionEvidence")) as { transitions: string[]; violations: string[] };
    expect(evidence.violations, "Every rendered frame swaps opaque labels and cars together").toEqual([]);
    if (gameId === "fm-2023") {
      expect(evidence.transitions.some((layout, i) => layout === "recorded" && evidence.transitions[i + 1] === "schematic")).toBe(true);
      expect(evidence.transitions.some((layout, i) => layout === "schematic" && evidence.transitions[i + 1] === "recorded")).toBe(true);
    }
  });
}
for (const gameId of ["f1-2025", "fm-2023"] as const) {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === gameId);
  if (!game) throw new Error(`Fuel telemetry acceptance requires ${gameId}`);
  test(`${gameId} Fuel tab shows stable ERS mode bands only when channel exists`, async ({ page, request }, testInfo) => {
    const pair = await getDistinctPair(request, gameId);
    await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}&view=spectate`, { waitUntil: "domcontentloaded" });
    const split = page.getByRole("button", { name: "Split recordings", exact: true });
    await page.addLocatorHandler(split, () => split.click());
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const telemetry = page.getByRole("button", { name: "Telemetry", exact: true });
    if (await telemetry.getAttribute("aria-pressed") !== "true") await telemetry.click();
    const fuel = page.getByRole("tab", { name: "Fuel", exact: true });
    if (gameId === "f1-2025") {
      await expect(fuel).toBeVisible();
      await fuel.click();
      const chart = page.locator('[data-channel-id="fuel.ers-deploy-mode"]');
      await expect(chart).toBeVisible();
      const checkHotlapPlayback = async (name: string) => {
        const graphic = chart.getByRole("img");
        await page.getByRole("slider", { name: "Replay position", exact: true }).fill("30");
        await expect(graphic).toHaveAttribute("data-current-a", "2");
        const band = chart.locator('rect[data-ers-side="a"][data-ers-mode="2"]');
        await expect(band).toHaveCount(1);
        await expect(band).toBeVisible();
        await page.getByRole("button", { name: "Play replay", exact: true }).click();
        const evidence = await band.evaluate(async (node) => {
          const failures: string[] = [];
          for (let frame = 0; frame < 60; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const band = node.getBoundingClientRect(), plot = (node as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
            const overlap = Math.min(band.right, plot.right) - Math.max(band.left, plot.left);
            if (!node.isConnected || plot.width <= 0 || overlap < plot.width * 0.95) failures.push(`frame ${frame}: band missing or clipped`);
          }
          return failures;
        });
        await page.getByRole("button", { name: "Pause replay", exact: true }).click();
        expect(evidence).toEqual([]);
        await expect(graphic).toHaveAttribute("data-current-a", "2");
        await expect.poll(async () => Number(await page.locator("[data-spectate-playback]").getAttribute("data-time"))).toBeGreaterThan(30.25);
        await chart.screenshot({ path: testInfo.outputPath(`${name}-ers-hotlap.png`) });
      };
      await checkHotlapPlayback("spectate");
      await page.goto(`/${game.prefix}/sessions/${pair.lapA.sessionId}/replay/${pair.lapA.id}`);
      await page.locator('[data-panel-toggle="replay-telemetry-panel"]').click();
      await page.getByRole("tab", { name: "Fuel", exact: true }).click();
      await checkHotlapPlayback("replay");
      expect(await chart.getByRole("img").getAttribute("data-current-b")).toBeNull();
    } else if (await fuel.count()) {
      await fuel.click();
      await expect(page.locator('[data-channel-id="fuel.ers-deploy-mode"]')).toHaveCount(0);
    }
  });
}
