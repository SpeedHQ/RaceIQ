import { expect, test } from "@playwright/test";
import { z } from "zod";
import { MetricRateSchema, StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { ingestAccLaps } from "./acc-source";
import { ingestF1Laps } from "./f1-source";
import { StrategyRuntime } from "./runtime";

const sessionsSchema = z.array(z.object({ id: z.number().int() }));

test("E2 native ACC litre consumption stays distinct from tank-fraction rates in the session table and chart", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-litres"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await ingestAccLaps(runtime.udpPort, 4);
    const response = await api.get("/api/sessions?gameId=acc");
    expect(response.ok(), await response.text()).toBe(true);
    const session = sessionsSchema.parse(await response.json())[0];
    expect(session).toBeDefined();
    const read = async () => {
      const result = await api.get(`/api/sessions/${session!.id}/stints`, { headers: { "X-Game-Id": "acc" } });
      expect(result.ok(), await result.text()).toBe(true);
      return StintsResponseSchema.parse(await result.json()).stints;
    };
    await expect.poll(async () => (await read()).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(4);
    const measured = (await read()).find((stint) => stint.fuel.eligibleLaps >= 2);
    expect(measured).toBeDefined();
    expect(measured!.fuelUnit).toBe("L");
    expect(measured!.fuel.unit).toBe("L/lap");
    expect(measured!.fuel.value).toBeCloseTo(2.4, 4);
    expect(measured!.tires.every((wheel) => wheel.value === null)).toBe(true);
    await page.goto(`${runtime.baseURL}/acc/sessions/${session!.id}/analyse`);
    await expect(page.getByTestId("stint-summary-table")).toContainText(/2[.,]40?\s*L/);
    await expect(page.getByTestId("stint-summary-chart")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("litre-stint-averages.png"), fullPage: true });
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("E3 native F1 fraction fuel and historical wheel rates take over independently at three eligible laps", async ({ playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-f1-thresholds"), false);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const socket = new WebSocket(`${runtime.apiURL.replace("http:", "ws:")}/ws`);
  const sample = z.object({
    type: z.literal("telemetry-frame"),
    context: z.object({ pit: z.object({ strategy: z.object({
      sessionId: z.number().int(), revision: z.number().int(), fuel: MetricRateSchema,
      tires: z.array(MetricRateSchema).length(4),
    }) }) }),
  });
  type Snapshot = z.infer<typeof sample>["context"]["pit"]["strategy"];
  const observations = new Map<number, Snapshot>();
  let previousSession = -1;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const parsed = sample.safeParse(JSON.parse(event.data));
    if (parsed.success && previousSession >= 0 && parsed.data.context.pit.strategy.sessionId !== previousSession) {
      const strategy = parsed.data.context.pit.strategy;
      observations.set(strategy.revision, strategy);
    }
  });
  try {
    await new Promise<void>((accept, reject) => {
      socket.addEventListener("open", () => accept(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Production WebSocket failed")), { once: true });
    });
    await ingestF1Laps(runtime.udpPort, 3);
    const listed = await api.get("/api/sessions?gameId=f1-2025");
    expect(listed.ok(), await listed.text()).toBe(true);
    previousSession = sessionsSchema.parse(await listed.json())[0]!.id;
    const result = await api.get(`/api/sessions/${previousSession}/stints`, { headers: { "X-Game-Id": "f1-2025" } });
    expect(result.ok(), await result.text()).toBe(true);
    const prior = StintsResponseSchema.parse(await result.json()).stints;
    expect(prior[0]!.fuelUnit).toBe("tankFraction");
    expect(prior[0]!.fuel.unit).toBe("tankFraction/lap");
    expect(prior[0]!.fuel.value).toBeCloseTo(0.024, 4);
    await ingestF1Laps(runtime.udpPort, 4, 461n, 1);
    await expect.poll(() => observations.has(3)).toBe(true);
    expect(observations.get(0)!.fuel.source).toBeNull();
    expect(observations.get(1)!.tires.every((rate) => rate.source === "history")).toBe(true);
    expect(observations.get(2)!.tires.every((rate) => rate.source === "history")).toBe(true);
    const current = observations.get(3)!;
    expect(current.fuel.source).toBe("current-stint");
    expect(current.fuel.value).toBeCloseTo(0.024, 4);
    for (const wheel of current.tires) {
      expect(wheel.source).toBe("current-stint");
      expect(wheel.provisional).toBe(false);
      expect(wheel.value).toBeCloseTo(0.01, 4);
    }
  } finally {
    socket.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("E4/E9 different native F1 compounds preserve measured values and suppress only wheel differences", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-f1-compound-comparison"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 6, 460n, 0.8, 4);
    const response = await api.get("/api/sessions?gameId=f1-2025");
    expect(response.ok(), await response.text()).toBe(true);
    const id = sessionsSchema.parse(await response.json())[0]!.id;
    const read = await api.get(`/api/sessions/${id}/stints`, { headers: { "X-Game-Id": "f1-2025" } });
    expect(read.ok(), await read.text()).toBe(true);
    const stints = StintsResponseSchema.parse(await read.json()).stints;
    const measured = stints.filter((stint) => stint.tires[0].value != null);
    expect(measured.length).toBeGreaterThanOrEqual(2);
    const first = measured[0]!;
    const last = measured.at(-1)!;
    expect(first.compounds[0]).not.toBe(last.compounds[0]);
    expect(first.tires[0].value).toBeCloseTo(0.008, 4);
    expect(last.tires[0].value).toBeCloseTo(0.008, 4);
    await page.goto(`${runtime.baseURL}/f125/sessions/${id}/analyse`);
    const selection = page.getByTestId("stint-summary-table").getByRole("checkbox");
    await selection.nth(stints.indexOf(first)).check();
    await selection.nth(stints.indexOf(last)).check();
    const comparison = page.getByTestId("stint-comparison");
    const wheel = comparison.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "FL", exact: true }) });
    await expect(wheel.getByRole("cell").nth(0)).toContainText("0.80 percentage points/lap");
    await expect(wheel.getByRole("cell").nth(1)).toContainText("0.80 percentage points/lap");
    await expect(wheel.getByRole("cell").nth(2)).toContainText("Not comparable");
    const fuel = comparison.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Fuel / lap", exact: true }) });
    await expect(fuel.getByRole("cell").nth(0)).toContainText("2.40 percentage points/lap");
    await expect(fuel.getByRole("cell").nth(2)).not.toContainText("Not comparable");
    const missing = stints.findIndex((stint) => stint.fuel.value == null);
    expect(missing).toBeGreaterThanOrEqual(0);
    await selection.nth(stints.indexOf(last)).uncheck();
    await selection.nth(missing).check();
    await expect(fuel.getByRole("cell").nth(0)).toContainText("2.40 percentage points/lap");
    await expect(fuel.getByRole("cell").nth(1)).not.toHaveText(/^[+-]?\d/);
    await expect(fuel.getByRole("cell").nth(2)).toContainText("Difference unavailable");
    await comparison.screenshot({ path: testInfo.outputPath("compound-comparison.png") });
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
