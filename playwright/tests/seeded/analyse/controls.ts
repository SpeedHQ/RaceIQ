import { expect, type Page } from "@playwright/test";
import { setAnalyseFrame } from "../../support/seeded/analyse";

type SemanticFrame = { values: Record<string, unknown> };
export async function assertLapSelectors(page: Page, expectedLapNumber?: number): Promise<void> {
  await expect(page.getByRole("combobox", { name: "Search tracks..." })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Search cars..." })).toHaveCount(0);
  const selector = page.getByRole("combobox", { name: "Search laps..." });
  if (expectedLapNumber != null) await expect(selector).toHaveValue(new RegExp(`^Lap ${expectedLapNumber}\\b`));
  await selector.click();
  await expect(page.getByRole("option", { selected: true }).first()).toBeVisible();
  await selector.press("Escape");
}

export async function assertTuneSelector(page: Page): Promise<void> {
  const selector = page.getByRole("combobox", { name: "Tune:" });
  if (await selector.count()) await expect(selector).toBeVisible();
}

export async function exerciseDynamicsTooltip(page: Page, frames: SemanticFrame[]): Promise<void> {
  const index = frames.findIndex((frame) => ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y"].every((id) => typeof frame.values[id] === "number" && Number.isFinite(frame.values[id])));
  if (index < 0) throw new Error("Seeded Replay fixture lacks balance inputs");
  await setAnalyseFrame(page, index);
  const trigger = page.getByRole("button", { name: /Balance tooltip/ });
  const text = await trigger.locator("..").innerText();
  const decision = text.match(/(Understeer|Neutral|Oversteer)\(([+-]?\d+\.\d{2})\)/);
  if (!decision) throw new Error(`Balance row lacks decision value: ${text}`);
  await trigger.hover();
  await expect(page.getByRole("tooltip")).toContainText(`Decision — ${decision[1]} (${decision[2]})`);
}

export async function exercisePlaybackControls(page: Page, frames: SemanticFrame[]): Promise<void> {
  const clock = page.locator("[data-spectate-playback]");
  const slider = page.getByRole("slider", { name: "Replay position", exact: true });
  const frameIndex = frames.findIndex((frame, index) => index > 0 && typeof frame.values["motion.speed"] === "number");
  if (frameIndex < 0) throw new Error("Seeded Replay fixture lacks speed data");
  await setAnalyseFrame(page, frameIndex);
  const before = Number(await clock.getAttribute("data-time"));
  await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await expect(clock).toHaveAttribute("data-playing", "false");
  const speed = page.getByRole("combobox", { name: "Playback speed", exact: true });
  for (const value of ["0.25", "0.5", "1", "1.5", "2", "4"]) {
    await speed.selectOption(value);
    await expect(speed).toHaveValue(value);
  }
  await slider.press("Home");
  await expect(clock).toHaveAttribute("data-time", "0");
  await slider.press("ArrowRight");
  await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
  const toggle = page.locator('[data-panel-toggle="replay-telemetry-panel"]');
  await toggle.click();
  await expect(page.locator('#replay-telemetry-panel [role="tablist"]')).toBeVisible();
  await expect(page.locator('#replay-telemetry-panel canvas').first()).toBeVisible();
  await toggle.click();
}

export async function exerciseInsightsAndMap(page: Page): Promise<void> {
  const toggle = page.locator('[data-panel-toggle="replay-insights-panel"]');
  await toggle.click();
  await expect(page.locator("#replay-insights-panel").getByRole("heading", { name: "Suspension" })).toBeVisible();
  await toggle.click();
  const overview = page.getByRole("region", { name: "Circuit overview", exact: true });
  await expect(overview).toBeVisible();
  const mapToggle = page.getByRole("switch", { name: "Circuit overview", exact: true });
  await mapToggle.click();
  await expect(overview).toHaveCount(0);
  await mapToggle.click();
  await expect(overview).toBeVisible();
  const heading = page.getByRole("switch", { name: "Follow", exact: true });
  const checked = await heading.getAttribute("aria-checked");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-checked", String(checked !== "true"));
}

export async function exercise3dGuide(page: Page, assertClosed = true): Promise<void> {
  const tires = page.locator("[data-tire-panel-toggle]");
  await tires.click();
  const panel = page.locator("#replay-car-panel");
  await expect(panel.getByRole("img", { name: /^FL (?:surface|core|carcass):/ })).toBeVisible();
  await expect(panel.getByRole("img", { name: /^RR (?:surface|core|carcass):/ })).toBeVisible();
  await tires.click();
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  const guide = page.getByRole("dialog", { name: "Data Panel Guide" });
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "Close" }).click();
  if (assertClosed) await expect(guide).toHaveCount(0);
}

export async function exerciseAiSetup(page: Page): Promise<void> {
  const toggle = page.locator('[data-panel-toggle="replay-ai-panel"]');
  await toggle.click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up AI", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await toggle.click();
}

export async function exerciseCrossGameControls(page: Page, hasF1Setup: boolean, expectedLapNumber?: number): Promise<void> {
  await assertLapSelectors(page, expectedLapNumber);
  await assertTuneSelector(page);
  await exerciseInsightsAndMap(page);
  const speed = page.getByRole("combobox", { name: "Playback speed", exact: true });
  await speed.selectOption("2");
  await expect(speed).toHaveValue("2");
  await exercise3dGuide(page, false);
  if (hasF1Setup) {
    await page.getByRole("button", { name: "Car Setup", exact: true }).click();
    const setup = page.getByRole("dialog", { name: "Car Setup" });
    await expect(setup.getByText("Aerodynamics", { exact: true })).toBeVisible();
    await setup.getByRole("button", { name: "Close" }).click();
  }
  const ai = page.locator('[data-panel-toggle="replay-ai-panel"]');
  await ai.click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  await ai.click();
}
