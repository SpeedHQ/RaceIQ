import { expect, type Page } from "@playwright/test";

export async function assertLapSelectors(page: Page, expectedLapNumber?: number): Promise<void> {
  for (const placeholder of ["Search tracks...", "Search cars..."]) {
    const selector = page.getByRole("combobox", { name: placeholder });
    await selector.click();
    await expect(page.getByRole("option", { selected: true }).first()).toBeVisible();
    await selector.press("Escape");
  }
  if (expectedLapNumber != null) {
    await expect(page.getByRole("combobox", { name: "Search laps..." })).toHaveValue(new RegExp(`^Lap ${expectedLapNumber}\\b`));
  }
}

export async function assertTuneSelector(page: Page): Promise<void> {
  const tuneSelector = page.getByRole("combobox", { name: "Tune:" });
  if (await tuneSelector.count()) await expect(tuneSelector).toBeVisible();
}

export async function exercisePlaybackControls(page: Page): Promise<void> {
  const slider = page.getByRole("slider", { name: "Lap timeline" });
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  for (const speed of [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5]) {
    const speedButton = page.getByRole("button", { name: `${speed}x`, exact: true });
    await speedButton.click();
    await expect(speedButton).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "2x", exact: true }).click();

  await page.getByTitle("Play (Space)").click();
  await expect.poll(() => slider.getAttribute("aria-valuenow"), { timeout: 10_000 }).not.toBe("0");
  await page.getByTitle("Pause (Space)").click();
  const beforeKeyboardStep = Number(await slider.getAttribute("aria-valuenow"));
  await slider.press("ArrowRight");
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).toBeGreaterThan(beforeKeyboardStep);

  const chart = page.locator("canvas.cursor-crosshair").first();
  await expect(chart).toBeVisible();
  const beforeChartSeek = Number(await slider.getAttribute("aria-valuenow"));
  await chart.click({ position: { x: 120, y: 40 } });
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).not.toBe(beforeChartSeek);
}

export async function exerciseInsightsAndMap(page: Page): Promise<void> {
  const insightsTab = page.getByRole("tab", { name: /Insights/ });
  await insightsTab.click();
  await expect(insightsTab).toHaveAttribute("aria-selected", "true");
  const insightsPanel = page.getByRole("tabpanel", { name: /Insights/ });
  await expect(insightsPanel.getByRole("heading", { name: "Suspension" })).toBeVisible();
  await page.getByRole("tab", { name: "Data", exact: true }).click();

  const followButton = page.getByRole("button", { name: "Fixed", exact: true });
  await followButton.click();
  await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Overlays", exact: true }).click();
  const overlayItems = ["Inputs", "Segments", "Sectors"].map((label) => page.getByRole("menuitemcheckbox", { name: label, exact: true }));
  for (const item of overlayItems) {
    await item.click();
    await expect(item).toHaveAttribute("aria-checked", "true");
  }
  for (const item of overlayItems) {
    await item.click();
    await expect(item).toHaveAttribute("aria-checked", "false");
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Zoom in map" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("analyse-mapZoom"))).toBe("1.25");
  await page.getByRole("button", { name: "Zoom out map" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("analyse-mapZoom"))).toBe("1");
}

export async function exercise3dGuide(page: Page, assertClosed = true): Promise<void> {
  await page.getByRole("tab", { name: "3D", exact: true }).click();
  await expect(page.getByRole("tab", { name: "3D", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "2D", exact: true }).click();
  const activeVizPanel = page.getByRole("tabpanel", { name: "2D" });
  await expect(activeVizPanel).toBeVisible();
  await expect(activeVizPanel.getByText(/\d+\s+(mph|km\/h)/i).first()).toBeVisible();
  await expect(activeVizPanel.locator("svg")).toHaveCount(4);
  await expect(activeVizPanel.locator("canvas")).toHaveCount(2);
  await expect(activeVizPanel.getByText("FL", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Guide", exact: true }).click();
  const guideDialog = page.getByRole("dialog", { name: "Data Panel Guide" });
  await expect(guideDialog).toBeVisible();
  await guideDialog.getByRole("button", { name: "Close" }).click();
  if (assertClosed) await expect(guideDialog).toHaveCount(0);
}

export async function exerciseAiSetup(page: Page): Promise<void> {
  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up AI", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
}

export async function exerciseCrossGameControls(page: Page, hasF1Setup: boolean, expectedLapNumber?: number): Promise<void> {
  await assertLapSelectors(page, expectedLapNumber);
  await assertTuneSelector(page);

  const insightsTab = page.getByRole("tab", { name: /Insights/ });
  await insightsTab.click();
  await expect(insightsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No issues detected").first()).toBeVisible();
  await page.getByRole("tab", { name: "Data", exact: true }).click();

  for (const speed of [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5]) {
    const speedButton = page.getByRole("button", { name: `${speed}x`, exact: true });
    await speedButton.click();
    await expect(speedButton).toHaveAttribute("aria-pressed", "true");
  }

  await exercise3dGuide(page, false);
  if (hasF1Setup) {
    await page.getByRole("button", { name: "Car Setup", exact: true }).click();
    const setupDialog = page.getByRole("dialog", { name: "Car Setup" });
    await expect(setupDialog).toBeVisible();
    await expect(setupDialog.getByText("Aerodynamics", { exact: true })).toBeVisible();
    await setupDialog.getByRole("button", { name: "Close" }).click();
  }

  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
}
