import { expect, test } from "@playwright/test";
import { z } from "zod";
import { PitEstimatePageSchema, StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { ingestNativeRun } from "./native-source";
import { ingestAccLaps } from "./acc-source";
import { StrategyRuntime } from "./runtime";

const sessionsSchema = z.array(z.object({ id: z.number().int(), carId: z.string() }));
const envelopeSchema = z.object({ type: z.string(), sequence: z.number().optional(), revision: z.number().optional() });
const headers = { "X-Game-Id": "fm-2023" };

for (const failureTable of ["strategy_lap_metrics", "strategy_source_admissions"] as const) {
test(`E8 a failed ${failureTable} write keeps live frames flowing, reports persistence failure and recovers without duplicate laps`, async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-failure"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext();
  const page = await context.newPage();
  let highestFrame = -1;
  let committedRevision = -1;
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    if (typeof payload !== "string") return;
    try {
      const envelope = envelopeSchema.parse(JSON.parse(payload));
      if (envelope.type === "telemetry-frame" && envelope.sequence !== undefined) highestFrame = Math.max(highestFrame, envelope.sequence);
      if (envelope.type === "strategy-updated" && envelope.revision !== undefined) committedRevision = Math.max(committedRevision, envelope.revision);
    } catch { /* Other protocol frames are unrelated to this strategy assertion. */ }
  }));
  const lap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] as [number, number, number, number] };
  try {
    await page.goto(`${runtime.baseURL}/live/pit`);
    await ingestNativeRun({ carId: 642, laps: [lap, lap] }, runtime.udpPort);
    const response = await api.get("/api/sessions?gameId=fm-2023");
    const session = sessionsSchema.parse(await response.json()).find((row) => row.carId === "642");
    expect(session).toBeDefined();
    const read = async () => {
      const result = await api.get(`/api/sessions/${session!.id}/stints`, { headers });
      expect(result.ok(), await result.text()).toBe(true);
      return StintsResponseSchema.parse(await result.json()).stints;
    };
    await expect.poll(async () => (await read()).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(2);
    await expect.poll(() => committedRevision).toBe(2);
    await ingestNativeRun({ carId: 642, firstLap: 3, timestampMs: 121_125, initialFuel: 0.86, initialWear: [0.116, 0.12, 0.112, 0.108], laps: [] }, runtime.udpPort);
    const committedFuelLaps = (await read()).find((stint) => stint.status === "active")!.fuel.eligibleLaps;
    await expect(page.getByTestId("strategy-live-evidence")).toContainText(`Eligible laps: ${committedFuelLaps}`);
    const committedFuelEvidence = await page.getByTestId("strategy-live-evidence").innerText();
    await runtime.setPersistenceFailure(true, failureTable);
    const beforeFrame = highestFrame;
    const beforeRevision = committedRevision;
    await ingestNativeRun({ carId: 642, firstLap: 3, timestampMs: 121_250, initialFuel: 0.86, initialWear: [0.116, 0.12, 0.112, 0.108], laps: [lap] }, runtime.udpPort);
    for (let pulse = 0; pulse < 12; pulse++) await ingestNativeRun({ carId: 642, firstLap: 4, timestampMs: 181_500 + pulse * 250, initialFuel: 0.84, initialWear: [0.124, 0.13, 0.118, 0.112], laps: [] }, runtime.udpPort);
    await expect(page.getByTestId("strategy-persistence-error")).toBeVisible();
    expect(highestFrame).toBeGreaterThan(beforeFrame);
    // Independent limiter snapshots may commit; the failed summary revision must not.
    expect(committedRevision).toBe(beforeRevision);
    expect((await read()).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(2);
    await expect(page.getByTestId("strategy-live-evidence")).toHaveText(committedFuelEvidence);
    await runtime.setPersistenceFailure(false);
    await ingestNativeRun({ carId: 642, firstLap: 4, timestampMs: 184_500, initialFuel: 0.84, initialWear: [0.124, 0.13, 0.118, 0.112], laps: [lap] }, runtime.udpPort);
    for (let pulse = 0; pulse < 12; pulse++) await ingestNativeRun({ carId: 642, firstLap: 5, timestampMs: 244_750 + pulse * 250, initialFuel: 0.82, initialWear: [0.132, 0.14, 0.124, 0.116], laps: [] }, runtime.udpPort);
    await expect(page.getByTestId("strategy-persistence-error")).toHaveCount(0);
    await expect.poll(async () => (await read()).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(4);
  } finally {
    try {
      await runtime.setPersistenceFailure(false);
    } finally {
      await context.close();
      await api.dispose();
      await runtime.stop();
    }
  }
});
}

test("E8 a terminal lap-save failure does not block the next native session", async ({ playwright }, testInfo) => {
  test.setTimeout(120_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-lap-failure"), false);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const lap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] as [number, number, number, number] };
  const sessions = async () => sessionsSchema.parse(await (await api.get("/api/sessions?gameId=fm-2023")).json());
  const completed = async (id: number) => {
    const response = await api.get(`/api/sessions/${id}/stints`, { headers });
    expect(response.ok(), await response.text()).toBe(true);
    return StintsResponseSchema.parse(await response.json()).stints.reduce((sum, stint) => sum + stint.completedLaps, 0);
  };
  try {
    await ingestNativeRun({ carId: 642, laps: [lap, lap] }, runtime.udpPort);
    const source = (await sessions()).find((row) => row.carId === "642")!;
    await expect.poll(() => completed(source.id)).toBe(2);
    await runtime.setPersistenceFailure(true, "laps");
    await ingestNativeRun({ carId: 642, firstLap: 3, timestampMs: 121_250, initialFuel: 0.86, initialWear: [0.116, 0.12, 0.112, 0.108], laps: [lap] }, runtime.udpPort);
    expect(await completed(source.id)).toBe(2);
    await runtime.setPersistenceFailure(false);
    await ingestNativeRun({ carId: 639, timestampMs: 200_000, laps: [lap] }, runtime.udpPort);
    await expect.poll(async () => (await sessions()).find((row) => row.carId === "639")?.id).toBeTruthy();
    const next = (await sessions()).find((row) => row.carId === "639")!;
    await expect.poll(() => completed(next.id)).toBe(1);
    expect(await completed(source.id)).toBe(2);
  } finally {
    try { await runtime.setPersistenceFailure(false); }
    finally { await api.dispose(); await runtime.stop(); }
  }
});

test("E6/E7 distinct same-timestamp native observations survive clear without replay resurrection", async ({ playwright }, testInfo) => {
  test.setTimeout(120_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-same-time"), false);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const lap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] as [number, number, number, number] };
  try {
    await ingestNativeRun({ carId: 642, laps: [lap, lap] }, runtime.udpPort);
    const source = sessionsSchema.parse(await (await api.get("/api/sessions?gameId=fm-2023")).json()).find((row) => row.carId === "642")!;
    const read = async () => {
      const response = await api.get(`/api/sessions/${source.id}/pit-estimates`, { headers });
      expect(response.ok(), await response.text()).toBe(true);
      return PitEstimatePageSchema.parse(await response.json()).estimates;
    };
    const point = { carId: 642, firstLap: 3, timestampMs: 121_500, initialFuel: 0.86, initialWear: [0.95, 0.95, 0.95, 0.95] as [number, number, number, number], laps: [] };
    await ingestNativeRun(point, runtime.udpPort);
    await expect.poll(async () => (await read())[0]?.limitedBy).toBe("tires");
    const before = (await read())[0]!;
    const cleared = await api.delete(`/api/sessions/${source.id}/pit-estimates`, { headers, data: { driverKey: before.driverKey } });
    expect(cleared.ok(), await cleared.text()).toBe(true);
    expect(await read()).toEqual([]);
    await ingestNativeRun({ ...point, initialFuel: 0 }, runtime.udpPort);
    await expect.poll(async () => (await read())[0]?.limitedBy).toBe("fuel");
    const after = (await read())[0]!;
    expect(after.sourceCoordinate.milliseconds).toBe(before.sourceCoordinate.milliseconds);
    expect(after.sourceOrder.epochOrdinal).toBe(before.sourceOrder.epochOrdinal);
    expect(after.sourceOrder.sequence).toBeGreaterThan(before.sourceOrder.sequence);
    expect(after.sourceSnapshot.fuelRemaining).toBe(0);
    const clearedAgain = await api.delete(`/api/sessions/${source.id}/pit-estimates`, { headers, data: { driverKey: after.driverKey } });
    expect(clearedAgain.ok(), await clearedAgain.text()).toBe(true);
    await runtime.restart();
    expect(await read()).toEqual([]);
  } finally {
    await api.dispose();
    await runtime.stop();
  }
});

test("E7/E8 deleting a source with failed admission cannot poison a later native session", async ({ playwright }, testInfo) => {
  test.setTimeout(120_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-admission-delete"), false);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const lap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] as [number, number, number, number] };
  const sessions = async () => sessionsSchema.parse(await (await api.get("/api/sessions?gameId=fm-2023")).json());
  const completed = async (id: number) => {
    const response = await api.get(`/api/sessions/${id}/stints`, { headers });
    expect(response.ok(), await response.text()).toBe(true);
    return StintsResponseSchema.parse(await response.json()).stints.reduce((sum, stint) => sum + stint.completedLaps, 0);
  };
  try {
    await ingestNativeRun({ carId: 642, laps: [lap, lap] }, runtime.udpPort);
    const source = (await sessions()).find((row) => row.carId === "642")!;
    await expect.poll(() => completed(source.id)).toBe(2);
    await runtime.setPersistenceFailure(true, "strategy_source_admissions");
    await ingestNativeRun({ carId: 642, firstLap: 3, timestampMs: 121_250, initialFuel: 0.86, initialWear: [0.116, 0.12, 0.112, 0.108], laps: [lap] }, runtime.udpPort);
    await ingestNativeRun({ carId: 639, timestampMs: 200_000, laps: [] }, runtime.udpPort);
    await expect.poll(async () => (await sessions()).find((row) => row.carId === "639")?.id).toBeTruthy();
    const next = (await sessions()).find((row) => row.carId === "639")!;
    // Capture retirement may briefly reject deletion; no replacement data is fabricated.
    await expect.poll(async () => (await api.post("/api/sessions/bulk-delete", { data: { ids: [source.id] } })).ok()).toBe(true);
    await runtime.setPersistenceFailure(false);
    await ingestNativeRun({ carId: 639, timestampMs: 200_250, laps: [lap] }, runtime.udpPort);
    await expect.poll(() => completed(next.id)).toBe(1);
    expect((await api.get(`/api/sessions/${source.id}/stints`, { headers })).status()).toBe(404);
  } finally {
    try { await runtime.setPersistenceFailure(false); }
    finally { await api.dispose(); await runtime.stop(); }
  }
});

test("E8 Kunos lap-write failure reports degraded strategy even before a completion callback", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(120_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-kunos-failure"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${runtime.baseURL}/live/pit`);
    await runtime.setPersistenceFailure(true, "laps");
    await ingestAccLaps(runtime.udpPort, 3);
    await expect(page.getByTestId("strategy-persistence-error")).toBeVisible();
    const source = sessionsSchema.parse(await (await api.get("/api/sessions?gameId=acc")).json())[0]!;
    const response = await api.get(`/api/sessions/${source.id}/stints`, { headers: { "X-Game-Id": "acc" } });
    expect(response.ok(), await response.text()).toBe(true);
    expect(StintsResponseSchema.parse(await response.json()).stints.reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(0);
  } finally {
    try { await runtime.setPersistenceFailure(false); }
    finally { await context.close(); await api.dispose(); await runtime.stop(); }
  }
});
