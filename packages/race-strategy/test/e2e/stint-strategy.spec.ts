import { expect, test, type APIRequestContext } from "@playwright/test";
import type { HistoricalBaseline, PitEstimatePage, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { z } from "zod";
import { BaselineResponseSchema, PitEstimatePageSchema, StintsResponseSchema, StrategyLapMetricsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { ingestNativeRun, primeNativeRun, type NativeLap, type NativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";
import { openProjectionSection } from "./ui";

const headers = { "X-Game-Id": "fm-2023" };
const measuredLap: NativeLap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] };
const SessionSchema = z.object({ id: z.number().int(), carId: z.string() });
type StrategySession = z.infer<typeof SessionSchema>;
async function stints(api: APIRequestContext, sessionId: number): Promise<StintSummary[]> {
  const response = await api.get(`/api/sessions/${sessionId}/stints`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return StintsResponseSchema.parse(await response.json()).stints;
}

async function lapMetrics(api: APIRequestContext, sessionId: number) {
  const response = await api.get(`/api/sessions/${sessionId}/stint-lap-metrics`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return StrategyLapMetricsResponseSchema.parse(await response.json()).laps;
}
async function estimates(api: APIRequestContext, sessionId: number, query = ""): Promise<PitEstimatePage> {
  const response = await api.get(`/api/sessions/${sessionId}/pit-estimates${query}`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return PitEstimatePageSchema.parse(await response.json());
}
async function sessionFor(api: APIRequestContext, carId: string): Promise<StrategySession> {
  let session: StrategySession | undefined;
  await expect.poll(async () => {
    const response = await api.get("/api/sessions?gameId=fm-2023");
    expect(response.ok()).toBe(true);
    session = z.array(SessionSchema).parse(await response.json()).filter((row) => row.carId === carId).sort((a, b) => b.id - a.id)[0];
    return session?.id;
  }).toBeTruthy();
  return session!;
}

test("session Overview ends with stint trends and preserves optional comparison", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-session-stints"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await ingestNativeRun({ carId: 642, laps: [measuredLap, measuredLap, measuredLap] }, runtime.udpPort);
    const session = await sessionFor(api, "642");
    await expect.poll(async () => (await stints(api, session.id))[0]?.fuel.value).toBeCloseTo(0.02, 5);
    const url = `${runtime.baseURL}/fm23/sessions/${session.id}/analyse`;
    await page.goto(url);
    await expect(page.getByRole("button", { name: /^Sector \d+$/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Stint trends", exact: true })).toBeVisible();
    const analysis = page.getByTestId("stint-analysis");
    const cards = page.getByRole("region", { name: "Persisted per-stint averages, evidence counts, and data quality" });
    await expect(cards).toBeVisible();
    await expect(cards).toHaveAttribute("data-testid", "stint-summary-cards");
    const stintCards = cards.locator("article");
    await expect(stintCards).toHaveCount(1);
    await expect(stintCards.first()).toContainText(/2[.,]00.*%\/lap/);
    await expect(page.getByTestId("stint-summary-chart")).toBeVisible();
    await expect(analysis.getByRole("group", { name: "Tire temperature" })).toHaveCount(0);
    await expect(cards.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
    const tires = await page.getByText("Tires at end of lap", { exact: true }).boundingBox();
    const statistics = await analysis.boundingBox();
    expect(tires).not.toBeNull();
    expect(statistics).not.toBeNull();
    expect(statistics!.y).toBeGreaterThan(tires!.y + tires!.height);
    await analysis.scrollIntoViewIfNeeded();
    await analysis.screenshot({ path: testInfo.outputPath("single-stint-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await analysis.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await analysis.screenshot({ path: testInfo.outputPath("single-stint-mobile.png") });

    await ingestNativeRun({ carId: 642, firstLap: 4, timestampMs: 201_250, initialFuel: 0.9, initialWear: [0.02, 0.02, 0.02, 0.02], laps: [measuredLap, measuredLap] }, runtime.udpPort);
    await expect.poll(async () => (await stints(api, session.id)).length).toBe(2);
    await page.reload();
    const selection = cards.getByRole("checkbox");
    await expect(selection).toHaveCount(2);
    await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
    await selection.nth(0).check();
    await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
    await expect(cards).toContainText(/2[.,]00.*%\/lap/);
    await selection.nth(1).check();
    await expect(page.getByTestId("stint-comparison").getByRole("table")).toBeVisible();
    const firstStintAnchor = await stintCards.first().getAttribute("id");
    expect(firstStintAnchor).not.toBeNull();
    await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "retained"; });
    await page.getByTestId("stint-comparison").getByRole("link").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(url).pathname);
    await expect.poll(() => new URL(page.url()).hash).toBe(`#${firstStintAnchor}`);
    await expect(page.locator(`[id="${firstStintAnchor}"]`)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "retained");
    await selection.nth(1).uncheck();
    await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    await expect(analysis).toHaveCount(0);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(stintCards).toHaveCount(2);

    await runtime.crash();
    await runtime.databaseStatement("DELETE FROM strategy_stints WHERE session_id=?", [session.id], true);
    // A completed empty generation must remain empty instead of triggering startup reconstruction.
    await runtime.databaseStatement("UPDATE strategy_session_state SET rebuild_generation='empty-state-fixture' WHERE session_id=?", [session.id], true);
    await runtime.restart();
    await page.reload();
    await expect(cards).toHaveCount(0);
    await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("full-stint p50/p95 fuel and wear render and survive reload with per-metric lap evidence", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-stint-statistics"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    const samples = [0.04, 0, 0.02, 0.01, 0.08, 0.03, 0.09];
    const run: NativeRun = { carId: 642, laps: samples.map((fuelUsed, index) => ({
      fuelUsed, wear: [fuelUsed / 10, fuelUsed / 10, 0, fuelUsed / 10] as NativeLap["wear"], ...(index === 0 ? { missingWheel: 1 } : {}),
    })) };
    await primeNativeRun(run, runtime.udpPort, runtime.apiURL);
    await ingestNativeRun(run, runtime.udpPort);
    const session = await sessionFor(api, "642");
    await expect.poll(async () => (await stints(api, session.id))[0]?.fuel.eligibleLaps).toBe(7);
    const measured = (await stints(api, session.id))[0]!;
    expect(measured.rateStatistics?.fuel.p50).not.toBeUndefined();
    expect(measured.rateStatistics?.fuel.p95).not.toBeUndefined();
    expect(measured.tires.map((rate) => rate.eligibleLaps)).toEqual([7, 6, 7, 7]);
    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    const analysis = page.getByTestId("stint-analysis");
    const cards = page.getByTestId("stint-summary-cards");
    const firstCard = cards.locator("article").first();
    const fuelCell = firstCard.locator("section").first();
    await expect(fuelCell).toContainText("p50");
    await expect(fuelCell).toContainText("p95");
    await expect(fuelCell).toContainText("7 laps");
    await expect(firstCard).toContainText("6 laps");
    await expect(firstCard.locator("details")).toHaveCount(1);
    const detailsSummary = firstCard.locator("summary");
    await detailsSummary.focus();
    expect(await detailsSummary.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(firstCard.locator("details")).toHaveAttribute("open", "");
    await expect(firstCard.locator("details")).toContainText("Driver:");
    await expect(firstCard.locator("details")).toContainText("Fuel used / coverage:");
    await expect(firstCard.locator("details")).toContainText("Average lap");
    const persistedLaps = await lapMetrics(api, session.id);
    expect(persistedLaps).toHaveLength(7);
    expect(persistedLaps.map((lap) => lap.lapNumber)).toEqual([...persistedLaps.map((lap) => lap.lapNumber)].sort((a, b) => a - b));
    persistedLaps.forEach((lap, index) => expect(lap.fuel.value).toBeCloseTo(samples[index]!, 5));
    expect(persistedLaps[0]!.tires.some((tire) => tire.value === null)).toBe(true);
    const chart = page.getByTestId("stint-summary-chart");
    const plots = chart.getByTestId("stint-lap-scatter-plot");
    await expect(plots).toHaveCount(5);
    await expect(plots.nth(1).locator("[data-lap-id]")).toHaveCount(7);
    await expect(plots.nth(2).locator("[data-lap-id]")).toHaveCount(6);
    await expect(plots.nth(0).locator('[data-lap-id][data-value="0"]')).toHaveCount(1);
    await expect(chart.getByTestId("stint-p50-overlay")).toHaveCount(5);
    await expect(chart.getByTestId("stint-p95-overlay")).toHaveCount(5);
    const overlays = chart.locator('[data-testid="stint-p50-overlay"], [data-testid="stint-p95-overlay"]');
    await expect(overlays).toHaveCount(10);
    for (let index = 0; index < 10; index++) {
      const overlay = overlays.nth(index);
      await expect(overlay).toHaveAttribute("stroke-width", /\d/);
      for (const coordinate of ["y1", "y2"]) {
        await expect(overlay).toHaveAttribute(coordinate, /^-?\d+(?:\.\d+)?$/);
      }
    }
    const readout = chart.getByTestId("stint-lap-readout");
    const selection = cards.getByRole("checkbox");
    await expect(chart.getByRole("status").filter({ hasText: /Select a lap/i })).toBeVisible();
    const firstPoint = plots.first().locator("[data-lap-id]").first();
    await expect(firstPoint).toHaveAttribute("aria-pressed", "false");
    await firstPoint.hover();
    await expect(chart.locator("h3").filter({ hasText: "Lap 1" })).toBeVisible();
    await expect(firstPoint).toHaveAttribute("aria-pressed", "true");
    await firstPoint.focus();
    await expect(chart.locator("h3").filter({ hasText: "Lap 1" })).toBeVisible();
    await expect(readout).toHaveCount(1);
    await expect(readout).toContainText("FL");
    await expect(readout).toContainText("Measurement unavailable");
    const axisLabel = plots.first().locator("text").filter({ hasText: "Lap" }).first();
    expect(await axisLabel.evaluate((element) => Number(element.getAttribute("font-size")))).toBeGreaterThanOrEqual(11);
    await analysis.screenshot({ path: testInfo.outputPath("stint-trends-desktop.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await analysis.scrollIntoViewIfNeeded();
    await expect.poll(async () => plots.evaluateAll((items) => items.length === 5 && items.every((plot) => plot.getBoundingClientRect().width > 0))).toBe(true);
    await firstPoint.click();
    await expect(firstPoint).toHaveAttribute("aria-pressed", "true");
    await expect(readout).toBeVisible();
    await cards.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await analysis.screenshot({ path: testInfo.outputPath("stint-trends-mobile.png") });
    await ingestNativeRun({ carId: 642, firstLap: 8, timestampMs: 421_250, initialFuel: 0.9, initialWear: [0.02, 0.02, 0.02, 0.02], laps: [
      { fuelUsed: 0.01, wear: [0.001, 0.001, 0, 0.001] },
      { fuelUsed: 0.03, wear: [0.003, 0.003, 0, 0.003] },
      { fuelUsed: 0.05, wear: [0.005, 0.005, 0, 0.005] },
    ] }, runtime.udpPort);
    await expect.poll(async () => (await stints(api, session.id)).filter((stint) => stint.fuel.value != null).length).toBe(2);
    await expect.poll(async () => lapMetrics(api, session.id).then((laps) => laps.filter((lap) => lap.fuel.value != null).length)).toBeGreaterThan(7);
    const eligibleFuelLaps = (await lapMetrics(api, session.id)).filter((lap) => lap.fuel.value != null).length;
    await expect.poll(async () => plots.first().locator("[data-lap-id]").count()).toBe(eligibleFuelLaps);
    const selectedLapCellValues = await readout.getByRole("cell").allTextContents();
    await selection.nth(0).check();
    await expect(selection.nth(0)).toBeChecked();
    await expect(readout).toBeVisible();
    await expect(await readout.getByRole("cell").allTextContents()).toEqual(selectedLapCellValues);
    await selection.nth(1).check();
    const comparison = page.getByTestId("stint-comparison");
    await expect(comparison).toBeFocused();
    expect((await comparison.boundingBox())!.y).toBeLessThan((await cards.boundingBox())!.y);
    const comparisonFuel = comparison.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Fuel / lap", exact: true }) });
    await expect(comparisonFuel.locator("td").nth(0)).toContainText("p50");
    await expect(comparisonFuel.locator("td").nth(0)).toContainText("p95");
    await expect(comparisonFuel.locator("td").nth(1)).toContainText("p50");
    await expect(comparisonFuel.locator("td").nth(1)).toContainText("p95");
    await runtime.crash();
    await runtime.restart();
    const restored = (await stints(api, session.id))[0]!;
    expect(restored.rateStatistics).toEqual(measured.rateStatistics);
    await page.reload();
    await expect(fuelCell).toContainText("p50");
    await expect(fuelCell).toContainText("p95");
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("E2/E5 persisted per-lap thermal population, percentile overlays, focus and responsive view", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-stint-cold"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  try {
    await primeNativeRun({ carId: 642, laps: [measuredLap, measuredLap, measuredLap] }, runtime.udpPort, runtime.apiURL);
    await ingestNativeRun({ carId: 642, laps: [measuredLap, measuredLap, measuredLap] }, runtime.udpPort);
    const session = await sessionFor(api, "642");
    await expect.poll(async () => (await lapMetrics(api, session.id)).length).toBe(3);
    await ingestNativeRun({ carId: 642, firstLap: 4, timestampMs: 201_250, initialFuel: 0.9, initialWear: [0.02, 0.02, 0.02, 0.02], laps: [
      { fuelUsed: 0.01, wear: [0.001, 0.001, 0.001, 0.001] },
      { fuelUsed: 0.03, wear: [0.003, 0.003, 0.003, 0.003] },
      { fuelUsed: 0.05, wear: [0.005, 0.005, 0.005, 0.005] },
    ] }, runtime.udpPort);
    await expect.poll(async () => (await stints(api, session.id)).length).toBe(2);
    await ingestNativeRun({ carId: 639, timestampMs: 501_250, laps: [measuredLap, measuredLap] }, runtime.udpPort);
    const otherSession = await sessionFor(api, "639");
    await expect.poll(async () => (await lapMetrics(api, otherSession.id)).length).toBe(2);

    await runtime.crash();
    for (const sessionId of [session.id, otherSession.id]) {
      const rows = z.array(z.object({ lap_id: z.number(), payload: z.string() })).parse(
        await runtime.databaseStatement("SELECT lap_id,payload FROM strategy_lap_metrics WHERE session_id=? ORDER BY lap_id", [sessionId]),
      );
      const row = rows[0]!;
      const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(row.payload));
      await runtime.databaseStatement("UPDATE strategy_lap_metrics SET payload=? WHERE session_id=? AND lap_id=?", [
        JSON.stringify({ ...payload, thermalState: "cold", fuelUsed: 0.04, tireWear: [0.004, 0.004, 0.004, 0.004] }),
        sessionId, row.lap_id,
      ], true);
    }
    const summaryRows = z.array(z.object({ id: z.string(), payload: z.string() })).parse(
      await runtime.databaseStatement("SELECT id,payload FROM strategy_stints WHERE session_id=? ORDER BY json_extract(payload,'$.ordinal')", [session.id]),
    );
    const firstSummary = z.record(z.string(), z.unknown()).parse(JSON.parse(summaryRows[0]!.payload));
    await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=? AND session_id=?", [
      JSON.stringify({
        ...firstSummary,
        coldRateStatistics: { p50: 0.04, p95: 0.04 },
        coldTireRateStatistics: Array.from({ length: 4 }, () => ({ p50: 0.004, p95: 0.004 })),
        coldLaps: 1,
      }),
      summaryRows[0]!.id, session.id,
    ], true);
    const emptySummary = z.record(z.string(), z.unknown()).parse(JSON.parse(summaryRows[1]!.payload));
    const noSamples = (rate: Record<string, unknown>) => ({ ...rate, value: null, eligibleLaps: 0, unavailableReason: "no-current-samples" });
    await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=? AND session_id=?", [
      JSON.stringify({
        ...emptySummary,
        fuel: noSamples(z.record(z.string(), z.unknown()).parse(emptySummary.fuel)),
        tires: z.array(z.record(z.string(), z.unknown())).parse(emptySummary.tires).map(noSamples),
        rateStatistics: { fuel: { p50: null, p95: null }, tires: Array.from({ length: 4 }, () => ({ p50: null, p95: null })) },
      }),
      summaryRows[1]!.id, session.id,
    ], true);
    await runtime.restart();
    expect((await lapMetrics(api, session.id))[0]?.thermalState).toBe("cold");
    expect((await lapMetrics(api, session.id))[0]?.fuel.value).toBe(0.04);
    const coldSummary = (await stints(api, session.id))[0]!;
    expect(coldSummary.coldRateStatistics).toEqual({ p50: 0.04, p95: 0.04 });
    expect(coldSummary.coldTireRateStatistics).toEqual(Array.from({ length: 4 }, () => ({ p50: 0.004, p95: 0.004 })));
    expect(coldSummary.coldLaps).toBe(1);

    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    const dashboard = page.getByTestId("stint-summary-chart");
    const analysis = page.getByTestId("stint-analysis");
    const population = dashboard.getByRole("group", { name: "Tire temperature" });
    const hot = population.getByRole("button", { name: "Hot", exact: true });
    const cold = population.getByRole("button", { name: "Cold", exact: true });
    await expect(hot).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.getByTestId("stint-lap-scatter-plot")).toHaveCount(5);
    const cards = page.getByRole("region", { name: "Persisted per-stint averages, evidence counts, and data quality" });
    const selection = cards.getByRole("checkbox");
    const firstCard = cards.locator("article").first();
    const hotHeadline = firstCard;
    const expectHotHeadline = async () => {
      await expect(hotHeadline).toContainText("p50 2.00%/lap");
      await expect(hotHeadline).toContainText("p95 2.00%/lap");
      await expect(hotHeadline).toContainText("3 laps");
    };
    await expectHotHeadline();
    const emptyCard = cards.locator("article").last();
    const emptyDetails = emptyCard.locator("details");
    await expect(emptyDetails).toHaveCount(1);
    await expect(emptyDetails).not.toHaveAttribute("open", "");
    const emptyColdEvidence = emptyDetails.getByText("Cold fuel", { exact: false });
    const emptyPercentile = emptyDetails.getByText(/p50/);
    await expect(emptyColdEvidence).not.toBeVisible();
    await expect(emptyPercentile).toHaveCount(10);
    for (const percentile of await emptyPercentile.all()) await expect(percentile).toBeHidden();
    await emptyDetails.locator("summary").click();
    await expect(emptyColdEvidence).toBeVisible();
    for (const percentile of await emptyPercentile.all()) await expect(percentile).toBeVisible();
    await emptyDetails.locator("summary").click();
    await expect(emptyDetails).not.toHaveAttribute("open", "");
    for (const percentile of await emptyPercentile.all()) await expect(percentile).toBeHidden();
    const emptyCardId = await emptyCard.getAttribute("id");
    expect(emptyCardId).toMatch(/^stint-/);
    await expect(page.locator(`#${emptyCardId}`)).toHaveCount(1);
    await selection.nth(0).check();
    await selection.nth(1).check();
    expect(await cards.evaluate((element) => Boolean(element.compareDocumentPosition(document.getElementById("stint-comparison")!) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true);
    const comparison = page.getByTestId("stint-comparison");
    await expect(comparison).toBeVisible();
    await expect(comparison).toBeFocused();
    await expect(page.getByRole("button", { name: "View comparison", exact: true })).toHaveCount(3);

    const p50 = dashboard.getByLabel("p50", { exact: true });
    const p95 = dashboard.getByLabel("p95", { exact: true });
    await expect(dashboard.getByTestId("stint-p50-overlay")).not.toHaveCount(0);
    await p50.uncheck();
    await expect(dashboard.getByTestId("stint-p50-overlay")).toHaveCount(0);
    await expect(dashboard.getByTestId("stint-p95-overlay")).not.toHaveCount(0);
    await p50.check();
    await hot.focus();
    await page.keyboard.press("Tab");
    await expect(cold).toBeFocused();
    expect(await cold.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    const coldEvidence = firstCard.locator("details").first();
    await expect(coldEvidence).not.toHaveAttribute("open", "");
    await coldEvidence.locator("summary").click();
    await expect(coldEvidence).toHaveAttribute("open", "");
    await expect(coldEvidence.getByText("Cold fuel", { exact: false })).toBeVisible();
    await expect(coldEvidence).toContainText("4.00%/lap");
    const coldWearRows = coldEvidence.getByText("Cold wear", { exact: false });
    await expect(coldWearRows).toHaveCount(4);
    for (const coldWearRow of await coldWearRows.all()) {
      await expect(coldWearRow).toBeVisible();
      await expect(coldWearRow).toContainText("0.40%/lap");
    }
    await coldEvidence.locator("summary").click();
    await expect(coldEvidence).not.toHaveAttribute("open", "");
    await expectHotHeadline();
    const coldFuel = dashboard.getByTestId("stint-lap-scatter-plot").first().locator('[data-lap-id][data-value="0.04"]');
    await expect(coldFuel).toHaveCount(1);
    const p95Control = dashboard.locator('input[type="checkbox"]').nth(1);
    await p95Control.focus();
    let focusedColdFuel = false;
    for (let tabStop = 0; tabStop < 12; tabStop += 1) {
      await page.keyboard.press("Tab");
      if (await coldFuel.evaluate((element) => element === document.activeElement)) {
        focusedColdFuel = true;
        break;
      }
    }
    expect(focusedColdFuel, "cold fuel point should receive keyboard focus within 12 tab stops").toBe(true);
    const focusedLapId = await coldFuel.getAttribute("data-lap-id");
    await expect(dashboard.getByTestId("stint-lap-scatter-plot").nth(1).locator(`circle[data-lap-id="${focusedLapId}"]`)).toHaveAttribute("aria-pressed", "true");
    const readout = dashboard.getByTestId("stint-lap-readout");
    await expect(readout).toContainText("4.00%/lap");
    await expect(readout).toContainText("0.40%/lap");
    const labelSize = await dashboard.getByTestId("stint-lap-scatter-plot").first().locator("text").first().evaluate((element) => {
      const svg = element.ownerSVGElement!;
      return element.getBBox().height * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    });
    expect(labelSize).toBeGreaterThanOrEqual(11);
    const targetSize = await coldFuel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.min(bounds.width, bounds.height);
    });
    expect(targetSize).toBeGreaterThanOrEqual(24);
    await hot.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(readout).toHaveCount(0);
    await cold.click();
    await coldFuel.focus();
    await page.keyboard.press("Space");
    await expect(readout).toContainText("4.00%/lap");
    await expect(comparison).toBeVisible();
    await expect(selection.nth(0)).toBeChecked();
    await expect(selection.nth(1)).toBeChecked();
    await analysis.screenshot({ path: testInfo.outputPath("stint-cold-desktop-dark.png") });
    await cards.scrollIntoViewIfNeeded();
    await cards.screenshot({ path: testInfo.outputPath("stint-cards-desktop-dark.png") });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => dashboard.getByTestId("stint-lap-scatter-plot").evaluateAll((plots) =>
      plots.length === 5 && plots.every((plot) => {
        const bounds = plot.getBoundingClientRect();
        const viewport = plot.parentElement!.getBoundingClientRect();
        const chart = plot.closest('[data-testid="stint-summary-chart"]')!;
        return bounds.width >= 560 && plot.parentElement!.scrollWidth >= bounds.width && viewport.width <= chart.clientWidth;
      }),
    )).toBe(true);
    const articles = cards.getByRole("article");
    await expect(articles).toHaveCount(2);
    await expect.poll(async () => articles.evaluateAll((items) =>
      items.every((article) => article.getBoundingClientRect().width <= article.parentElement!.clientWidth),
    )).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await analysis.screenshot({ path: testInfo.outputPath("stint-cold-mobile-dark.png") });
    await cards.scrollIntoViewIfNeeded();
    await cards.screenshot({ path: testInfo.outputPath("stint-cards-mobile-dark.png") });
    await articles.nth(1).screenshot({ path: testInfo.outputPath("stint-card-second-mobile-dark.png") });
    await page.goto(`${runtime.baseURL}/fm23/sessions/${otherSession.id}/analyse`);
    const otherDashboard = page.getByTestId("stint-summary-chart");
    const otherPopulation = otherDashboard.getByRole("group", { name: "Tire temperature" });
    await expect(otherPopulation.getByRole("button", { name: "Hot", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(otherPopulation.getByRole("button", { name: "Cold", exact: true })).toHaveAttribute("aria-pressed", "false");
    const otherLaps = await lapMetrics(api, otherSession.id);
    const otherReadout = otherDashboard.getByTestId("stint-lap-readout");
    await expect(otherReadout).toHaveCount(0);
    await expect(otherDashboard.getByRole("status").filter({ hasText: /Select a lap/i })).toBeVisible();
    await expect(otherDashboard.getByRole("button", { name: "Hot", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(otherDashboard.getByLabel("p50", { exact: true })).toBeChecked();
    await expect(otherDashboard.getByLabel("p95", { exact: true })).toBeChecked();
    const otherPoint = otherDashboard.getByTestId("stint-lap-scatter-plot").first().locator("[data-lap-id]").first();
    await otherPoint.hover();
    await expect(otherPoint).toHaveAttribute("aria-pressed", "true");
    const otherPointLapId = Number(await otherPoint.getAttribute("data-lap-id"));
    const selectedOtherLap = otherLaps.find((lap) => lap.lapId === otherPointLapId);
    expect(selectedOtherLap).toBeDefined();
    await expect(otherDashboard.locator("h3").filter({ hasText: `Lap ${selectedOtherLap!.lapNumber}` })).toBeVisible();
    const thermalState = selectedOtherLap!.thermalState === "unavailable" ? "Unavailable" : selectedOtherLap!.thermalState;
    await expect(otherDashboard.locator("h3").filter({ hasText: thermalState })).toBeVisible();
    await expect(otherReadout).toContainText(selectedOtherLap!.fuel.value === null ? "Measurement unavailable" : `${(selectedOtherLap!.fuel.value * 100).toFixed(2)}%/lap`);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("E4 plots valid zero and partial per-lap metrics; filters tire compounds without filtering fuel", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-stint-boundaries"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    const firstRun: NativeRun = { carId: 642, laps: [measuredLap, measuredLap] };
    await primeNativeRun(firstRun, runtime.udpPort, runtime.apiURL);
    await ingestNativeRun(firstRun, runtime.udpPort);
    const session = await sessionFor(api, "642");
    await expect.poll(async () => (await stints(api, session.id)).length).toBe(1);
    await ingestNativeRun({ carId: 642, firstLap: 3, timestampMs: 201_250, initialFuel: 0.9, initialWear: [0.02, 0.02, 0.02, 0.02], laps: [measuredLap, measuredLap] }, runtime.udpPort);
    await expect.poll(async () => (await stints(api, session.id)).length).toBe(2);

    await runtime.crash();
    const stintRows = z.array(z.object({ id: z.string(), payload: z.string() })).parse(
      await runtime.databaseStatement("SELECT id,payload FROM strategy_stints WHERE session_id=? ORDER BY json_extract(payload,'$.ordinal')", [session.id]),
    );
    for (const [index, row] of stintRows.entries()) {
      const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(row.payload));
      const compatibility = payload.compatibility as Record<string, unknown>;
      const compounds = index === 0 ? ["hard", "hard", "hard", "hard"] : [null, null, null, null];
      await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=? AND session_id=?", [
        JSON.stringify({ ...payload, compounds, compatibility: { ...compatibility, tireSemanticVersions: ["test-v1", "test-v1", "test-v1", "test-v1"] } }),
        row.id, session.id,
      ], true);
    }
    const metricRows = z.array(z.object({ lap_id: z.number(), payload: z.string() })).parse(
      await runtime.databaseStatement("SELECT lap_id,payload FROM strategy_lap_metrics WHERE session_id=? ORDER BY lap_id", [session.id]),
    );
    for (const [index, row] of metricRows.entries()) {
      const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(row.payload));
      const values = index === 0
        ? { fuelUsed: 0, fuelExcludedReason: null, tireWear: [0, null, 0.003, 0.004], tireExcludedReasons: [null, "unsupported", null, null] }
        : index === 1
          ? { fuelUsed: null, fuelExcludedReason: "fuel-unavailable", tireWear: [null, 0, null, null], tireExcludedReasons: ["unsupported", null, "unsupported", "unsupported"] }
          : index === 2
            ? { tireWear: [0.001, 0.002, 0.003, 0.004], tireExcludedReasons: [null, null, null, null] }
            : index === 3
              ? { tireWear: [null, null, null, null], tireExcludedReasons: ["unsupported", "unsupported", "unsupported", "unsupported"] }
              : {};
      await runtime.databaseStatement("UPDATE strategy_lap_metrics SET payload=? WHERE session_id=? AND lap_id=?", [
        JSON.stringify({ ...payload, ...values }), session.id, row.lap_id,
      ], true);
    }
    await runtime.restart();
    const persisted = await lapMetrics(api, session.id);
    expect((await stints(api, session.id)).map((stint) => stint.compounds)).toEqual([
      ["hard", "hard", "hard", "hard"],
      [null, null, null, null],
    ]);
    expect(persisted[0]?.tires.map(({ compound, value }) => [compound, value])).toEqual([
      ["hard", 0], ["hard", null], ["hard", 0.003], ["hard", 0.004],
    ]);
    expect(persisted[1]?.tires.map(({ compound, value }) => [compound, value])).toEqual([
      ["hard", null], ["hard", 0], ["hard", null], ["hard", null],
    ]);
    expect(persisted[2]?.tires.map(({ compound, value }) => [compound, value])).toEqual([
      [null, 0.001], [null, 0.002], [null, 0.003], [null, 0.004],
    ]);
    expect(persisted[0]?.fuel.value).toBe(0);
    expect(persisted[0]?.tires[0]?.value).toBe(0);
    expect(persisted[0]?.tires[1]?.value).toBeNull();
    expect(persisted[1]?.tires[1]?.value).toBe(0);
    expect(persisted[1]?.fuel.value).toBeNull();

    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    const dashboard = page.getByTestId("stint-summary-chart");
    const plots = dashboard.getByTestId("stint-lap-scatter-plot");
    await expect(plots).toHaveCount(9);
    await expect(plots.first().locator('[data-lap-id][data-value="0"]')).toHaveCount(1);
    await expect(plots.nth(1).locator('[data-lap-id][data-value="0"]')).toHaveCount(1);
    const filter = dashboard.getByLabel("Compounds", { exact: true });
    await expect(filter).toBeVisible();
    await expect(filter.locator("option")).toHaveText(["All", "Unknown", "hard"]);
    const fuelCount = await plots.first().locator("[data-lap-id]").count();
    await filter.selectOption("hard");
    await expect(plots).toHaveCount(5);
    await expect(plots.first().locator("[data-lap-id]")).toHaveCount(fuelCount);
    for (const plot of await plots.all().then((items) => items.slice(1))) {
      await expect(plot.locator("[data-lap-id]")).toHaveCount(1);
    }
    await filter.selectOption("unknown");
    await expect(plots).toHaveCount(5);
    for (const plot of await plots.all().then((items) => items.slice(1))) {
      await expect(plot.locator("[data-lap-id]")).toHaveCount(1);
    }
    const readout = dashboard.getByTestId("stint-lap-readout");
    const zeroPoint = plots.first().locator('[data-lap-id][data-value="0"]').first();
    await zeroPoint.focus();
    await zeroPoint.click();
    await expect(zeroPoint).toHaveAttribute("aria-pressed", "true");
    await expect(readout).toContainText("0.00%/lap");
    await expect(readout).toContainText("Not supported by this telemetry source");
    await expect(page.getByTestId("stint-summary-cards").locator("article")).toHaveCount(2);
    expect(await dashboard.evaluate((element) => /NaN|Infinity/.test(element.innerHTML))).toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("stint-lap-boundaries-desktop.png"), fullPage: true });
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("E6 real lap-metrics request loading and retry preserve page states", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(90_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-stint-loading"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let releaseResponse: (() => void) | undefined;
  try {
    await ingestNativeRun({ carId: 642, laps: [measuredLap, measuredLap] }, runtime.udpPort);
    const session = await sessionFor(api, "642");
    await expect.poll(async () => (await stints(api, session.id)).length).toBe(1);
    const endpoint = `**/api/sessions/${session.id}/stint-lap-metrics**`;
    let responseHeld = false;
    const responseGate = Promise.withResolvers<void>();
    releaseResponse = responseGate.resolve;
    await page.route(endpoint, async (route) => {
      const response = await route.fetch();
      responseHeld = true;
      await responseGate.promise;
      await route.fulfill({ response });
    });
    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    const analysis = page.getByTestId("stint-analysis");
    await expect.poll(() => responseHeld).toBe(true);
    await expect(analysis.getByRole("status").filter({ hasText: /^Loading/ })).toBeVisible();
    releaseResponse?.();
    await expect(page.getByTestId("stint-summary-cards")).toBeVisible();
    await page.unroute(endpoint);

    let backendAllowed = false;
    let failedRequests = 0;
    await page.route(endpoint, async (route) => {
      if (!backendAllowed) {
        failedRequests++;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.reload();
    await expect(analysis.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    expect(failedRequests).toBeGreaterThan(0);
    backendAllowed = true;
    await analysis.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("stint-summary-cards")).toBeVisible();
    await expect(analysis.getByRole("alert")).toHaveCount(0);
  } finally {
    releaseResponse?.();
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

function measurements({ id, fuel, tires, rateStatistics, completedLaps, measuredFuelUsed, fuelCoverage, averageLapSeconds, paceLaps, compounds, compatibility }: StintSummary) {
  return { id, fuel, tires, rateStatistics, completedLaps, measuredFuelUsed, fuelCoverage, averageLapSeconds, paceLaps, compounds, compatibility };
}

test("E1/E2/E6/E7/E8/E9 native ingestion persists independent stint metrics and ordered history across clear and restart", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  const second = await context.newPage();
  try {
    await page.goto(`${runtime.baseURL}/live/pit`);
    await second.goto(`${runtime.baseURL}/live/pit`);
    await ingestNativeRun({ carId: 642, laps: [measuredLap, measuredLap, measuredLap, measuredLap, { ...measuredLap, serviceBefore: { fuel: 0.9, wear: [0.02, 0.02, 0.02, 0.02] } }, measuredLap, measuredLap, measuredLap, { ...measuredLap, missingWheel: 1 }, { fuelUsed: 0, wear: [0, 0, 0, 0] }] }, runtime.udpPort);
    // More than one history page and a third stint exercise real cursor/selection boundaries.
    await ingestNativeRun({ carId: 642, firstLap: 11, timestampMs: 601_250, initialFuel: 0.9, initialWear: [0.02, 0.02, 0.02, 0.02], laps: Array.from({ length: 20 }, () => measuredLap) }, runtime.udpPort);
    const session = await sessionFor(api, "642");
    await expect.poll(async () => (await stints(api, session.id)).length).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await stints(api, session.id)).reduce((total, summary) => total + summary.completedLaps, 0)).toBe(30);
    const summaries = await stints(api, session.id);
    const measured = summaries.find((summary) => summary.fuel.eligibleLaps >= 2)!;
    expect(measured, "at least two eligible native fuel intervals").toBeTruthy();
    expect(measured.fuel.unit).toBe("tankFraction/lap");
    expect(measured.fuel.value).toBeCloseTo(0.02, 5);
    expect(measured.tires[0].value).toBeCloseTo(0.008, 5);
    expect(measured.tires[1].value).toBeCloseTo(0.01, 5);
    expect(measured.averageLapSeconds).toBeCloseTo(60, 5);
    // Startup packet filtering can leave incomplete coverage; refills must never count as use.
    expect(measured.measuredFuelUsed).toBeGreaterThan(0.06);
    expect(measured.measuredFuelUsed).toBeLessThanOrEqual(0.08001);
    expect(summaries.some((summary) => summary.tires[1].eligibleLaps < summary.tires[0].eligibleLaps)).toBe(true);
    const ledger = await estimates(api, session.id, "?limit=1");
    expect(ledger.estimates[0]?.sourceOrder).toBeDefined();
    expect(ledger.nextCursor).not.toBeNull();
    const next = await estimates(api, session.id, `?limit=1&before=${encodeURIComponent(ledger.nextCursor!)}`);
    expect(next.estimates[0]?.id).not.toBe(ledger.estimates[0]?.id);
    await openProjectionSection(page, "Projection history");
    await openProjectionSection(second, "Projection history");
    await expect(page.getByTestId("strategy-history").locator("article")).toHaveCount(25);
    await expect(second.getByTestId("strategy-history").locator("article")).toHaveCount(25);
    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    const cards = page.getByTestId("stint-summary-cards");
    await expect(cards).toBeVisible();
    const selection = cards.getByRole("checkbox");
    await selection.nth(0).check();
    await selection.nth(1).check();
    await expect(page.getByTestId("stint-comparison")).toBeVisible();
    await expect(selection.nth(2)).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("stint-cards-desktop.png"), fullPage: true });
    await page.getByTestId("stint-comparison").screenshot({ path: testInfo.outputPath("stint-comparison-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await cards.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("stint-cards-mobile.png"), fullPage: true });
    await page.getByTestId("stint-comparison").screenshot({ path: testInfo.outputPath("stint-comparison-mobile.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await selection.nth(1).uncheck();
    await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
    await selection.nth(2).check();
    await expect(page.getByTestId("stint-comparison")).toBeVisible();
    const retainedStintId = await cards.locator("article").first().getAttribute("id");
    await page.getByTestId("stint-comparison").getByRole("link").click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#${retainedStintId}`);
    await expect(page.locator(`[id="${retainedStintId}"]`)).toBeVisible();
    const invalid = await api.get(`/api/sessions/${session.id}/pit-estimates?limit=0`, { headers });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).code).toBe("INVALID_STRATEGY_REQUEST");
    const wrongGame = await api.get(`/api/sessions/${session.id}/stints`, { headers: { "X-Game-Id": "acc" } });
    expect(wrongGame.status()).toBe(404);
    await page.goto(`${runtime.baseURL}/live/pit`);
    const history = page.getByTestId("strategy-history");
    const otherHistory = second.getByTestId("strategy-history");
    await openProjectionSection(page, "Projection history");
    await history.getByRole("combobox").nth(1).selectOption("local-player");
    await otherHistory.getByRole("combobox").nth(1).selectOption("local-player");
    await history.getByRole("button", { name: "Older estimates", exact: true }).click();
    await otherHistory.getByRole("button", { name: "Older estimates", exact: true }).click();
    await expect(history.getByRole("button", { name: "Recent pit estimates", exact: true })).toBeVisible();
    await expect(otherHistory.getByRole("button", { name: "Recent pit estimates", exact: true })).toBeVisible();
    let confirmation = "";
    page.once("dialog", (dialog) => { confirmation = dialog.message(); void dialog.accept(); });
    await history.getByRole("button", { name: "Clear this driver's estimate history", exact: true }).click();
    expect(confirmation).toContain("Stint trends will remain available");
    await expect(history.locator("article")).toHaveCount(0);
    await expect(otherHistory.locator("article")).toHaveCount(0);
    await expect(history.getByRole("button", { name: "Recent pit estimates", exact: true })).toHaveCount(0);
    await expect(otherHistory.getByRole("button", { name: "Recent pit estimates", exact: true })).toHaveCount(0);
    expect((await estimates(api, session.id)).estimates).toEqual([]);
    expect((await stints(api, session.id)).map(measurements)).toEqual(summaries.map(measurements));
    const stale = await api.get(`/api/sessions/${session.id}/pit-estimates?before=${encodeURIComponent(ledger.nextCursor!)}`, { headers });
    expect(stale.status()).toBe(400);
    await runtime.crash();
    await runtime.restart();
    expect((await estimates(api, session.id)).estimates).toEqual([]);
    expect((await stints(api, session.id)).some((stint) => stint.status === "interrupted")).toBe(true);
    await page.reload();
    await expect(page.getByTestId("strategy-history")).toBeVisible();
    await expect(page.getByTestId("strategy-history").locator("article")).toHaveCount(0);
    const afterRestart = await stints(api, session.id);
    expect(afterRestart.map(({ fuel, tires, completedLaps }) => ({ fuel, tires, completedLaps }))).toEqual(summaries.map(({ fuel, tires, completedLaps }) => ({ fuel, tires, completedLaps })));
    for (let attempt = 0; attempt < 2; attempt++) {
      const rebuilt = await api.post(`/api/sessions/${session.id}/reprocess`, { timeout: 60_000 });
      expect(rebuilt.ok(), await rebuilt.text()).toBe(true);
      const afterRebuild = await stints(api, session.id);
      expect(afterRebuild.reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(30);
      expect((await estimates(api, session.id)).estimates).toEqual([]);
    }
    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    await expect(page.getByTestId("stint-summary-cards")).toBeVisible();
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("E3/E4/E7 persisted prior-session evidence seeds matching identities and refreshes when its source is deleted", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-history"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const second = await context.newPage();
  try {
    await ingestNativeRun({ carId: 642, laps: [measuredLap, measuredLap, measuredLap, measuredLap] }, runtime.udpPort);
    const source = await sessionFor(api, "642");
    // A real identity change closes A. Return to the exact car/layout/PI in a new source session.
    await ingestNativeRun({ carId: 639, timestampMs: 300_000, laps: [] }, runtime.udpPort);
    await page.goto(`${runtime.baseURL}/live/pit`);
    await second.goto(`${runtime.baseURL}/live/pit`);
    await ingestNativeRun({ carId: 642, timestampMs: 400_000, laps: [measuredLap] }, runtime.udpPort);
    await expect.poll(async () => {
      const response = await api.get("/api/status");
      return z.object({ currentSession: SessionSchema.nullable() }).parse(await response.json()).currentSession?.carId;
    }).toBe("642");
    const status = await api.get("/api/status");
    expect(status.ok(), await status.text()).toBe(true);
    const target = z.object({ currentSession: SessionSchema }).parse(await status.json()).currentSession;
    expect(target.id).not.toBe(source.id);
    await expect.poll(async () => (await stints(api, target.id)).length).toBe(1);
    const targetStint = (await stints(api, target.id))[0]!;
    const baselineFor = async (): Promise<HistoricalBaseline> => {
      const response = await api.get(`/api/sessions/${target.id}/strategy-baseline?stintId=${encodeURIComponent(targetStint.id)}`, { headers });
      expect(response.ok(), await response.text()).toBe(true);
      return BaselineResponseSchema.parse(await response.json()).baseline;
    };
    const baseline = await baselineFor();
    expect(baseline.fuel.value).toBeCloseTo(0.02, 5);
    expect(baseline.evidence.some((entry) => entry.sessionId === source.id)).toBe(true);
    const evidence = await openProjectionSection(page, "Projection evidence");
    const otherEvidence = await openProjectionSection(second, "Projection evidence");
    await expect(evidence).toContainText(/· Historical evidence/i);
    await expect(otherEvidence).toContainText(/· Historical evidence/i);
    await page.screenshot({ path: testInfo.outputPath("historical-evidence-desktop.png"), fullPage: true });
    const historySection = await openProjectionSection(page, "Projection history");
    const historyEntry = historySection.locator("article").filter({ has: page.locator(`a[href*="/sessions/${source.id}/analyse#stint-"]`) }).first();
    await historyEntry.locator("summary").click();
    const historyLink = historyEntry.getByRole("link").first();
    const historyHref = await historyLink.getAttribute("href");
    await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "retained"; });
    await historyLink.click();
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).hash).toBe(historyHref);
    await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "retained");
    await expect(page.locator(`[id="${decodeURIComponent(new URL(page.url()).hash.slice(1))}"]`)).toBeVisible();
    await page.goBack();
    await openProjectionSection(page, "Projection evidence");
    const frozen = (await estimates(api, target.id)).estimates;
    let releaseOldResponse!: () => void;
    const oldResponseGate = new Promise<void>((resolve) => { releaseOldResponse = resolve; });
    let heldOldResponse = false;
    let releasedOldResponse = false;
    await page.route(`**/api/sessions/${target.id}/strategy-baseline?*`, async (route) => {
      if (heldOldResponse) { await route.continue(); return; }
      const response = await route.fetch();
      heldOldResponse = true;
      await oldResponseGate;
      await route.fulfill({ response });
      releasedOldResponse = true;
    });
    // Delay an actual backend response, not fixture data, across the next committed revision.
    const rebuilt = await api.post(`/api/sessions/${source.id}/reprocess`, { timeout: 60_000 });
    expect(rebuilt.ok(), await rebuilt.text()).toBe(true);
    await expect.poll(() => heldOldResponse).toBe(true);
    await expect(evidence).not.toContainText(/· Historical evidence/i);
    await expect(otherEvidence).toContainText(/· Historical evidence/i);
    const deleted = await api.post("/api/sessions/bulk-delete", { data: { ids: [source.id] } });
    expect(deleted.ok(), await deleted.text()).toBe(true);
    await expect.poll(async () => (await baselineFor()).historyRevision).toBeGreaterThan(baseline.historyRevision);
    expect((await baselineFor()).evidence.some((entry) => entry.sessionId === source.id)).toBe(false);
    await expect(evidence).not.toContainText(/· Historical evidence/i);
    await expect(otherEvidence).not.toContainText(/· Historical evidence/i);
    releaseOldResponse();
    await expect.poll(() => releasedOldResponse).toBe(true);
    await expect(evidence).not.toContainText(/· Historical evidence/i);
    expect((await estimates(api, target.id)).estimates.filter((record) => frozen.some((old) => old.id === record.id))).toEqual(frozen);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("A5 recovers selected history after another client deletes its session", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-selection"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const otherClient = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const otherPage = await otherClient.newPage();
  try {
    await page.goto(`${runtime.baseURL}/live/pit`);
    const history = page.getByTestId("strategy-history");
    await expect(history).toHaveCount(0);

    await ingestNativeRun({ carId: 642, laps: Array.from({ length: 30 }, () => measuredLap) }, runtime.udpPort);
    const source = await sessionFor(api, "642");
    await ingestNativeRun({ carId: 639, timestampMs: 300_000, laps: Array.from({ length: 30 }, () => measuredLap) }, runtime.udpPort);
    const remaining = await sessionFor(api, "639");
    await expect.poll(async () => {
      const response = await api.get("/api/status");
      return z.object({ currentSession: SessionSchema.nullable() }).parse(await response.json()).currentSession?.id;
    }).toBe(remaining.id);
    await openProjectionSection(page, "Projection history");
    const currentPicker = history.getByRole("combobox").nth(0);
    await expect(currentPicker).toHaveValue(String(remaining.id));
    await expect(currentPicker.locator(`option[value="${remaining.id}"]`)).toHaveCount(1);
    await expect.poll(async () => (await estimates(api, source.id)).estimates.length).toBeGreaterThan(0);
    await otherPage.goto(`${runtime.baseURL}/live/pit`);
    await page.bringToFront();

    const sessionPicker = history.getByRole("combobox").nth(0);
    await expect(sessionPicker.locator(`option[value="${source.id}"]`)).toHaveCount(1);
    await sessionPicker.selectOption(String(source.id));
    await expect(sessionPicker).toHaveValue(String(source.id));
    await expect(history.locator("article").first()).toBeVisible();
    const older = history.getByRole("button", { name: "Older estimates", exact: true });
    if (await older.isVisible()) {
      await older.click();
      await expect(history.getByRole("button", { name: "Recent pit estimates", exact: true })).toBeVisible();
    }

    await otherPage.bringToFront();
    const deletion = await otherClient.request.post(`${runtime.apiURL}/api/sessions/bulk-delete`, { data: { ids: [source.id] } });
    expect(deletion.ok(), await deletion.text()).toBe(true);
    await page.bringToFront();

    await expect(sessionPicker).toHaveValue(String(remaining.id));
    await expect(history.locator("article").first()).toBeVisible();
    await expect(history.getByRole("button", { name: "Recent pit estimates", exact: true })).toHaveCount(0);
    expect((await api.get(`/api/sessions/${source.id}/pit-estimates`, { headers })).status()).toBe(404);
  } finally {
    await context.close();
    await otherClient.close();
    await api.dispose();
    await runtime.stop();
  }
});
