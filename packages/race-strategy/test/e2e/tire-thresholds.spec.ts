import { expect, test } from "@playwright/test";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import { ingestNativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";
import { ingestF1Laps } from "./f1-source";

test("tire thresholds persist, reject invalid updates and change live native projections without restart", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-threshold-runtime"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let pit: LivePitData | undefined;
  const observedThresholds = new Set<string>();
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.type === "telemetry-frame" && message.context?.pit) {
        pit = message.context.pit;
        const threshold = pit?.tireThresholds?.[0];
        if (threshold) observedThresholds.add(`${threshold.cliffPct}/${threshold.deadPct}`);
      }
    } catch { /* Non-JSON transport messages do not carry projections. */ }
  }));
  const overrides = { "fm-2023": { default: { cliffPct: 80, deadPct: 0 } }, "f1-2025": { soft: { cliffPct: 55, deadPct: 15 } } };
  try {
    const saved = await api.put("/api/settings", { data: { tireThresholdOverrides: overrides } });
    expect(saved.ok(), await saved.text()).toBe(true);
    await runtime.restart();
    expect((await (await api.get("/api/settings")).json()).tireThresholdOverrides).toEqual(overrides);
    for (const invalid of [{ cliffPct: 40, deadPct: 40 }, { cliffPct: 101, deadPct: 20 }, { cliffPct: 40, deadPct: -1 }, { cliffPct: 40, deadPct: null }]) {
      const response = await api.put("/api/settings", { data: { tireThresholdOverrides: { "fm-2023": { default: invalid } } } });
      expect(response.status()).toBe(400);
    }
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { unknown: { default: { cliffPct: 50, deadPct: 20 } } } } })).status()).toBe(400);
    expect((await (await api.get("/api/settings")).json()).tireThresholdOverrides).toEqual(overrides);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const lap = { fuelUsed: 0.02, wear: [0.01, 0.01, 0.01, 0.01] as [number, number, number, number] };
    await ingestNativeRun({ carId: 642, laps: [lap, lap, lap, lap, lap] }, runtime.udpPort);
    await expect.poll(() => pit?.tireEstimates?.wearPerLap[0]).toBeGreaterThan(0);
    await expect.poll(() => pit?.tireThresholds?.[0]).toEqual({ cliffPct: 80, deadPct: 0 });
    expect(pit?.tireEstimates?.toCliff[0]).not.toBeNull();
    expect(pit?.tireEstimates?.toDead[0]).not.toBeNull();
    const projectedHealthInterval = (pit!.tireEstimates!.toDead[0]! - pit!.tireEstimates!.toCliff[0]!) * pit!.tireEstimates!.wearPerLap[0];
    expect(projectedHealthInterval).toBeCloseTo(0.8, 2);
    const sessions = await (await api.get("/api/sessions?gameId=fm-2023")).json();
    const sessionId = sessions.find((session: { carId: string }) => session.carId === "642").id;
    await expect.poll(async () => {
      const ledger = await (await api.get(`/api/sessions/${sessionId}/pit-estimates`, { headers: { "X-Game-Id": "fm-2023" } })).json();
      return ledger.estimates.find((estimate: { limitedBy: string }) => estimate.limitedBy === "tires")?.tyreChangeSuggestion;
    }).toBe("consider-change");
    const next = { ...overrides, "fm-2023": { default: { cliffPct: 70, deadPct: 10 } } };
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: next } })).ok()).toBe(true);
    await ingestNativeRun({ carId: 642, firstLap: 6, timestampMs: 301_250, initialFuel: 0.8, initialWear: [0.15, 0.15, 0.15, 0.15], laps: [] }, runtime.udpPort);
    await expect.poll(() => pit?.tireThresholds?.[0]).toEqual({ cliffPct: 70, deadPct: 10 });
    const liveInterval = (pit!.tireEstimates!.toDead[0]! - pit!.tireEstimates!.toCliff[0]!) * pit!.tireEstimates!.wearPerLap[0];
    expect(liveInterval).toBeCloseTo(0.6, 2);
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "f1-2025": overrides["f1-2025"] } } })).ok()).toBe(true);
    await ingestNativeRun({ carId: 642, firstLap: 6, timestampMs: 301_500, initialFuel: 0.8, initialWear: [0.15, 0.15, 0.15, 0.15], laps: [] }, runtime.udpPort);
    await expect.poll(() => pit?.tireThresholds?.[0]).toEqual({ cliffPct: 40, deadPct: 20 });
    expect((await (await api.get("/api/settings")).json()).tireThresholdOverrides).toEqual({ "f1-2025": overrides["f1-2025"] });
    const compoundOverrides = { "f1-2025": { soft: { cliffPct: 55, deadPct: 15 }, medium: { cliffPct: 45, deadPct: 0 } } };
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: compoundOverrides } })).ok()).toBe(true);
    await ingestF1Laps(runtime.udpPort, 4, 480n, 0.8, 3);
    await expect.poll(() => pit?.tireThresholds?.[0]).toEqual({ cliffPct: 45, deadPct: 0 });
    expect(observedThresholds.has("55/15")).toBe(true);
    expect(observedThresholds.has("45/0")).toBe(true);
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});
