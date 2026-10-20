import { expect, test, type APIRequestContext } from "@playwright/test";
import type { HistoricalBaseline, PitEstimatePage, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { z } from "zod";
import { BaselineResponseSchema, PitEstimatePageSchema, StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { ingestNativeRun, type NativeLap } from "./native-source";
import { StrategyRuntime } from "./runtime";

const headers = { "X-Game-Id": "fm-2023" };
const measuredLap: NativeLap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] };
const SessionSchema = z.object({ id: z.number().int(), carId: z.string() });
type StrategySession = z.infer<typeof SessionSchema>;
async function stints(api: APIRequestContext, sessionId: number): Promise<StintSummary[]> {
  const response = await api.get(`/api/sessions/${sessionId}/stints`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return StintsResponseSchema.parse(await response.json()).stints;
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

function measurements({ id, fuel, tires, completedLaps, measuredFuelUsed, fuelCoverage, averageLapSeconds, paceLaps, compounds, compatibility }: StintSummary) {
  return { id, fuel, tires, completedLaps, measuredFuelUsed, fuelCoverage, averageLapSeconds, paceLaps, compounds, compatibility };
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
    await expect(page.getByTestId("strategy-history").locator("article")).toHaveCount(25);
    await expect(second.getByTestId("strategy-history").locator("article")).toHaveCount(25);
    await page.goto(`${runtime.baseURL}/fm23/sessions/${session.id}/analyse`);
    await expect(page.getByTestId("stint-summary-table")).toBeVisible();
    const selection = page.getByTestId("stint-summary-table").getByRole("checkbox");
    await selection.nth(0).check();
    await selection.nth(1).check();
    await expect(page.getByTestId("stint-comparison")).toBeVisible();
    await expect(selection.nth(2)).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("stint-table-desktop.png"), fullPage: true });
    await page.getByTestId("stint-comparison").screenshot({ path: testInfo.outputPath("stint-comparison-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("stint-summary-table").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("stint-table-mobile.png"), fullPage: true });
    await page.getByTestId("stint-comparison").screenshot({ path: testInfo.outputPath("stint-comparison-mobile.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const invalid = await api.get(`/api/sessions/${session.id}/pit-estimates?limit=0`, { headers });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).code).toBe("INVALID_STRATEGY_REQUEST");
    const wrongGame = await api.get(`/api/sessions/${session.id}/stints`, { headers: { "X-Game-Id": "acc" } });
    expect(wrongGame.status()).toBe(404);
    await page.goto(`${runtime.baseURL}/live/pit`);
    const history = page.getByTestId("strategy-history");
    const otherHistory = second.getByTestId("strategy-history");
    await history.getByRole("combobox").nth(1).selectOption("local-player");
    await otherHistory.getByRole("combobox").nth(1).selectOption("local-player");
    await history.getByRole("button", { name: "Older estimates", exact: true }).click();
    await otherHistory.getByRole("button", { name: "Older estimates", exact: true }).click();
    await expect(history.getByRole("button", { name: "Recent pit estimates", exact: true })).toBeVisible();
    await expect(otherHistory.getByRole("button", { name: "Recent pit estimates", exact: true })).toBeVisible();
    let confirmation = "";
    page.once("dialog", (dialog) => { confirmation = dialog.message(); void dialog.accept(); });
    await history.getByRole("button", { name: "Clear this driver's estimate history", exact: true }).click();
    expect(confirmation).toContain("Stint averages will remain available");
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
    await expect(page.getByTestId("stint-summary-table")).toBeVisible();
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
    await expect(page.getByTestId("strategy-live-evidence")).toContainText(/previous sessions/i);
    await expect(second.getByTestId("strategy-live-evidence")).toContainText(/previous sessions/i);
    await page.screenshot({ path: testInfo.outputPath("historical-evidence-desktop.png"), fullPage: true });
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
    await expect(page.getByTestId("strategy-live-evidence")).not.toContainText(/previous sessions/i);
    await expect(second.getByTestId("strategy-live-evidence")).toContainText(/previous sessions/i);
    const deleted = await api.post("/api/sessions/bulk-delete", { data: { ids: [source.id] } });
    expect(deleted.ok(), await deleted.text()).toBe(true);
    await expect.poll(async () => (await baselineFor()).historyRevision).toBeGreaterThan(baseline.historyRevision);
    expect((await baselineFor()).evidence.some((entry) => entry.sessionId === source.id)).toBe(false);
    await expect(page.getByTestId("strategy-live-evidence")).not.toContainText(/previous sessions/i);
    await expect(second.getByTestId("strategy-live-evidence")).not.toContainText(/previous sessions/i);
    releaseOldResponse();
    await expect.poll(() => releasedOldResponse).toBe(true);
    await expect(page.getByTestId("strategy-live-evidence")).not.toContainText(/previous sessions/i);
    expect((await estimates(api, target.id)).estimates.filter((record) => frozen.some((old) => old.id === record.id))).toEqual(frozen);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
