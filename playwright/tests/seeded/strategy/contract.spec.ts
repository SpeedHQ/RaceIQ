import { expect, test, type APIRequestContext } from "@playwright/test";
import { z } from "zod";
import { PitEstimatePageSchema, StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { ingestNativeRun, type NativeLap, type NativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";

const headers = { "X-Game-Id": "fm-2023" };
const sessionList = z.array(z.object({ id: z.number().int(), carId: z.string() }));
const frame = z.object({ type: z.string(), context: z.object({ pit: z.object({ strategy: z.object({ persistence: z.enum(["ok", "error"]) }).nullable().optional() }).nullable().optional() }).optional() });
const lap: NativeLap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] };
async function summaries(api: APIRequestContext, id: number) {
  const result = await api.get(`/api/sessions/${id}/stints`, { headers });
  expect(result.ok(), await result.text()).toBe(true);
  return StintsResponseSchema.parse(await result.json()).stints;
}
async function ledger(api: APIRequestContext, id: number, suffix = "") {
  const result = await api.get(`/api/sessions/${id}/pit-estimates${suffix}`, { headers });
  expect(result.ok(), await result.text()).toBe(true);
  return PitEstimatePageSchema.parse(await result.json());
}
async function sourceSession(api: APIRequestContext, carId: string) {
  const result = await api.get("/api/sessions?gameId=fm-2023");
  expect(result.ok(), await result.text()).toBe(true);
  const session = sessionList.parse(await result.json()).filter((entry) => entry.carId === carId).sort((a, b) => b.id - a.id)[0];
  expect(session).toBeDefined();
  return session!;
}

/** Continue the native stream while asynchronous storage results reach the next telemetry frame. */
async function advanceTelemetry(runtime: StrategyRuntime, run: NativeRun) {
  for (let pulse = 0; pulse < 12; pulse++) {
    await ingestNativeRun({ ...run, timestampMs: (run.timestampMs ?? 1_000) + pulse * 250 }, runtime.udpPort);
  }
}

test("shared contract: native ingestion → SQLite → HTTP/WebSocket, restart, rebuild, clear and storage recovery", async ({ playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-shared-contract"), false);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const socket = new WebSocket(`${runtime.apiURL.replace("http:", "ws:")}/ws`);
  let frames = 0;
  let persistenceError = false;
  let persistenceRecovered = false;
  let commits = 0;
  let clears = 0;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const parsed = frame.safeParse(JSON.parse(event.data));
    if (!parsed.success) return;
    if (parsed.data.type === "telemetry-frame") frames++;
    if (parsed.data.type === "strategy-updated") commits++;
    if (parsed.data.type === "strategy-estimates-cleared") clears++;
    const status = parsed.data.context?.pit?.strategy?.persistence;
    if (status === "error") persistenceError = true;
    if (persistenceError && status === "ok") persistenceRecovered = true;
  });
  try {
    await new Promise<void>((accept, reject) => {
      socket.addEventListener("open", () => accept(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Production WebSocket connection failed")), { once: true });
    });
    await ingestNativeRun({ carId: 642, laps: [lap, lap, lap, { ...lap, serviceBefore: { fuel: 0.9, wear: [0.02, 0.02, 0.02, 0.02] } }, lap, { ...lap, missingWheel: 1 }] }, runtime.udpPort);
    const source = await sourceSession(api, "642");
    await expect.poll(async () => (await summaries(api, source.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(6);
    const stints = await summaries(api, source.id);
    expect(stints.length).toBeGreaterThanOrEqual(2);
    expect(stints[0]!.fuel.value).toBeCloseTo(0.02, 5);
    expect(stints[0]!.tires[0].value).toBeCloseTo(0.008, 5);
    expect(stints.some((stint) => stint.tires[1].eligibleLaps < stint.tires[0].eligibleLaps)).toBe(true);
    const original = await ledger(api, source.id);
    expect(original.estimates.some((estimate) => estimate.trigger === "lap-completed")).toBe(true);
    expect(frames).toBeGreaterThan(10);
    for (const [index, estimate] of original.estimates.entries()) {
      const next = original.estimates[index + 1];
      if (next) expect(estimate.sourceOrder.epochOrdinal > next.sourceOrder.epochOrdinal || estimate.sourceOrder.epochOrdinal === next.sourceOrder.epochOrdinal && estimate.sourceOrder.sequence > next.sourceOrder.sequence).toBe(true);
    }
    for (const path of ["pit-estimates?limit=0", "pit-estimates?before=garbage", "stints?driverKey=", "strategy-baseline?stintId="]) {
      const invalid = await api.get(`/api/sessions/${source.id}/${path}`, { headers });
      expect(invalid.status()).toBe(400);
      expect(z.object({ code: z.literal("INVALID_STRATEGY_REQUEST") }).parse(await invalid.json()).code).toBe("INVALID_STRATEGY_REQUEST");
    }
    const wrongGame = await api.get(`/api/sessions/${source.id}/stints`, { headers: { "X-Game-Id": "acc" } });
    expect(wrongGame.status()).toBe(404);
    await runtime.restart();
    const restarted = await ledger(api, source.id);
    for (const estimate of original.estimates) expect(restarted.estimates.find((candidate) => candidate.id === estimate.id)).toEqual(estimate);
    for (let replay = 0; replay < 2; replay++) {
      const rebuilt = await api.post(`/api/sessions/${source.id}/reprocess`, { timeout: 60_000 });
      expect(rebuilt.ok(), await rebuilt.text()).toBe(true);
      expect((await summaries(api, source.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(6);
      expect((await ledger(api, source.id)).estimates).toEqual(restarted.estimates);
    }
    const page = await ledger(api, source.id, "?limit=1");
    expect(page.nextCursor).not.toBeNull();
    const cleared = await api.delete(`/api/sessions/${source.id}/pit-estimates`, { headers, data: { driverKey: "local-player" } });
    expect(cleared.ok(), await cleared.text()).toBe(true);
    expect((await ledger(api, source.id)).estimates).toEqual([]);
    const stale = await api.get(`/api/sessions/${source.id}/pit-estimates?before=${encodeURIComponent(page.nextCursor!)}`, { headers });
    expect(stale.status()).toBe(400);
    await runtime.restart();
    const replayed = await api.post(`/api/sessions/${source.id}/reprocess`, { timeout: 60_000 });
    expect(replayed.ok(), await replayed.text()).toBe(true);
    expect((await ledger(api, source.id)).estimates).toEqual([]);
    expect((await summaries(api, source.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(6);
    socket.close();
    // A separate new live source tests a real SQLite write abort and idempotent recovery.
    const live = new WebSocket(`${runtime.apiURL.replace("http:", "ws:")}/ws`);
    live.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = frame.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      if (parsed.data.type === "telemetry-frame") frames++;
      if (parsed.data.type === "strategy-updated") commits++;
      const status = parsed.data.context?.pit?.strategy?.persistence;
      if (status === "error") persistenceError = true;
      if (persistenceError && status === "ok") persistenceRecovered = true;
    });
    try {
      await ingestNativeRun({ carId: 639, laps: [lap, lap, lap] }, runtime.udpPort);
      const current = await sourceSession(api, "639");
      await expect.poll(async () => (await summaries(api, current.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(3);
      await runtime.setPersistenceFailure(true);
      const beforeFrames = frames;
      const beforeCommits = commits;
      await ingestNativeRun({ carId: 639, firstLap: 4, timestampMs: 181_250, initialFuel: 0.84, initialWear: [0.124, 0.13, 0.118, 0.112], laps: [lap] }, runtime.udpPort);
      await advanceTelemetry(runtime, { carId: 639, firstLap: 5, timestampMs: 241_500, initialFuel: 0.82, initialWear: [0.132, 0.14, 0.124, 0.116], laps: [] });
      await expect.poll(() => persistenceError).toBe(true);
      expect(frames).toBeGreaterThan(beforeFrames);
      expect(commits).toBe(beforeCommits);
      expect((await summaries(api, current.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(3);
      await runtime.setPersistenceFailure(false);
      await ingestNativeRun({ carId: 639, firstLap: 5, timestampMs: 244_500, initialFuel: 0.82, initialWear: [0.132, 0.14, 0.124, 0.116], laps: [lap] }, runtime.udpPort);
      await expect.poll(async () => (await summaries(api, current.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(5);
      await advanceTelemetry(runtime, { carId: 639, firstLap: 6, timestampMs: 304_750, initialFuel: 0.8, initialWear: [0.14, 0.15, 0.13, 0.12], laps: [] });
      await expect.poll(() => persistenceRecovered).toBe(true);
    } finally { live.close(); }
  } finally {
    socket.close();
    await api.dispose();
    await runtime.stop();
  }
});
