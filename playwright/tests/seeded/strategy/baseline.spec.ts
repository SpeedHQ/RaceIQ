import { expect, test, type APIRequestContext } from "@playwright/test";
import { z } from "zod";
import { BaselineResponseSchema, PitEstimatePageSchema, StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { ingestNativeRun, type NativeLap, type NativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";

const headers = { "X-Game-Id": "fm-2023" };
const laps: NativeLap[] = Array.from({ length: 3 }, () => ({ fuelUsed: 0.03, wear: [0.006, 0.009, 0.012, 0.015] }));
const sessions = z.array(z.object({ id: z.number().int(), carId: z.string(), trackId: z.string() }));
const statusSchema = z.object({ currentSession: z.object({ id: z.number().int(), carId: z.number().or(z.string()), trackId: z.string() }).nullable() });
const wsEnvelope = z.object({ type: z.string(), gameId: z.string().optional(), driverKey: z.string().optional(), historyRevision: z.number().optional(), context: z.object({ pit: z.object({ strategy: z.object({ sessionId: z.number(), revision: z.number(), historyRevision: z.number(), fuel: z.object({ value: z.number().nullable(), source: z.string().nullable(), eligibleLaps: z.number() }), tires: z.array(z.object({ value: z.number().nullable(), source: z.string().nullable(), eligibleLaps: z.number() })) }).nullable().optional() }).nullable().optional() }).optional() });

async function listSessions(api: APIRequestContext) {
  const response = await api.get("/api/sessions?gameId=fm-2023");
  expect(response.ok(), await response.text()).toBe(true);
  return sessions.parse(await response.json());
}
async function stints(api: APIRequestContext, id: number) {
  const response = await api.get(`/api/sessions/${id}/stints`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return StintsResponseSchema.parse(await response.json()).stints;
}
async function baseline(api: APIRequestContext, id: number, stintId: string) {
  const response = await api.get(`/api/sessions/${id}/strategy-baseline?stintId=${encodeURIComponent(stintId)}`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return BaselineResponseSchema.parse(await response.json()).baseline;
}
async function estimates(api: APIRequestContext, id: number) {
  const response = await api.get(`/api/sessions/${id}/pit-estimates`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return PitEstimatePageSchema.parse(await response.json()).estimates;
}
async function pulse(runtime: StrategyRuntime, carId: number, timestampMs: number, source: Pick<NativeRun, "firstLap" | "initialFuel" | "initialWear"> = {}) {
  await ingestNativeRun({ carId, timestampMs, laps: [], ...source }, runtime.udpPort);
}
async function sessionFromStatus(api: APIRequestContext) {
  const response = await api.get("/api/status");
  expect(response.ok(), await response.text()).toBe(true);
  const session = statusSchema.parse(await response.json()).currentSession;
  expect(session).not.toBeNull();
  return session!;
}

// E3/E4/E7: real native ingestion, strategy APIs and post-commit namespace notifications.
test("active baseline invalidates and restores across source rebuild, correction, and deletion", async ({ playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-baseline-mutations"), false);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const socket = new WebSocket(`${runtime.apiURL.replace("http:", "ws:")}/ws`);
  const historyEvents: Array<{ gameId?: string; driverKey?: string; historyRevision?: number }> = [];
  const targetSnapshots: Array<{ sessionId: number; historyRevision: number; fuel: { value: number | null; source: string | null; eligibleLaps: number }; tires: Array<{ value: number | null; source: string | null; eligibleLaps: number }> }> = [];
  let targetId = -1;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let raw: unknown;
    try { raw = JSON.parse(event.data); } catch { return; }
    const message = wsEnvelope.safeParse(raw);
    if (!message.success) return;
    if (message.data.type === "strategy-history-updated") historyEvents.push(message.data);
    const strategy = message.data.context?.pit?.strategy;
    if (strategy?.sessionId === targetId) targetSnapshots.push(strategy);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Production WebSocket connection failed")), { once: true });
    });
    // A has three complete valid laps. Close it by transitioning to another car.
    await ingestNativeRun({ carId: 642, timestampMs: 10_000, laps }, runtime.udpPort);
    const a = await sessionFromStatus(api);
    expect(String(a.carId)).toBe("642");
    await expect.poll(async () => (await stints(api, a.id)).reduce((sum, row) => sum + row.completedLaps, 0)).toBe(3);
    const aFuelSamples = (await stints(api, a.id)).reduce((sum, row) => sum + row.fuel.eligibleLaps, 0);
    await pulse(runtime, 639, 200_000);
    await expect.poll(async () => String((await sessionFromStatus(api)).carId)).toBe("639");
    await pulse(runtime, 642, 210_000);
    const b = await sessionFromStatus(api);
    expect(String(b.carId)).toBe("642");
    expect(b.id).not.toBe(a.id);
    targetId = b.id;
    await expect.poll(async () => (await stints(api, b.id)).length > 0).toBe(true);
    const bStint = (await stints(api, b.id)).at(-1)!;
    expect(bStint.completedLaps).toBe(0);
    expect(bStint.fuel.value).toBeNull(); // summaries are measured populations, not fallback rates

    await expect.poll(async () => (await baseline(api, b.id, bStint.id)).fuel.source).toBe("history");
    const prior = await baseline(api, b.id, bStint.id);
    expect(prior.fuel.value).toBeCloseTo(0.03, 5);
    expect(prior.fuel.eligibleLaps).toBe(aFuelSamples);
    expect(aFuelSamples).toBeGreaterThan(0);
    expect(prior.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ metric: "fuel", sessionId: a.id, eligibleLaps: aFuelSamples })]));
    for (let index = 1; index <= 12; index++) await pulse(runtime, 642, 210_000 + index * 250);
    await expect.poll(() => targetSnapshots.some((snapshot) => snapshot.fuel.source === "history" && snapshot.tires.every((tire) => tire.source !== "history"))).toBe(true);
    const initialHistoryRevision = prior.historyRevision;
    const aSaved = await estimates(api, a.id);
    const bSaved = await estimates(api, b.id);
    const originalBIds = new Set(bSaved.map((record) => record.id));

    // Actual reprocess route rebuilds derived evidence; cross-session summary revision need not change.
    const rebuildRevision = prior.historyRevision;
    const rebuild = await api.post(`/api/sessions/${a.id}/reprocess`, { timeout: 60_000 });
    expect(rebuild.ok(), await rebuild.text()).toBe(true);
    await expect.poll(async () => (await baseline(api, b.id, bStint.id)).historyRevision).toBeGreaterThan(rebuildRevision);
    expect(await estimates(api, a.id)).toEqual(aSaved);
    expect((await estimates(api, b.id)).filter((record) => originalBIds.has(record.id))).toEqual(bSaved);

    // Correct A away from car 642. Replay live heartbeats with monotonic sub-5s gaps; old evidence must not return.
    const patch = async (carId: string) => {
      const response = await api.patch(`/api/sessions/${a.id}/identity`, { headers, data: { gameId: "fm-2023", carId, trackId: a.trackId } });
      expect(response.ok(), await response.text()).toBe(true);
    };
    await patch("639");
    await expect.poll(async () => (await baseline(api, b.id, bStint.id)).fuel.value).toBeNull();
    const correctedRevision = (await baseline(api, b.id, bStint.id)).historyRevision;
    let timestamp = 213_000;
    for (let index = 0; index < 8; index++) { timestamp += 250; await pulse(runtime, 642, timestamp); }
    const corrected = await baseline(api, b.id, bStint.id);
    expect(corrected.historyRevision).toBeGreaterThanOrEqual(correctedRevision);
    expect(corrected.fuel.value).toBeNull();
    expect(corrected.evidence.some((row) => row.sessionId === a.id)).toBe(false);
    expect(await estimates(api, a.id)).toEqual(aSaved);

    // Restore source via identity correction + actual reprocessing; then prove current fuel independently takes over.
    await patch("642");
    const restored = await api.post(`/api/sessions/${a.id}/reprocess`, { timeout: 60_000 });
    expect(restored.ok(), await restored.text()).toBe(true);
    await expect.poll(async () => (await baseline(api, b.id, bStint.id)).fuel.source).toBe("history");
    const restoredBaseline = await baseline(api, b.id, bStint.id);
    const beforeDeleteRevision = restoredBaseline.historyRevision;
    // The first completed interval crosses a deliberate source gap; only the next two qualify.
    let currentTimestamp = timestamp + 6_000;
    for (let index = 0; index < 3; index++) {
      const next = currentTimestamp + 1_000;
      const wear = 0.1 + index * 0.001;
      await ingestNativeRun({ carId: 642, timestampMs: next, firstLap: index + 1, initialFuel: 0.9 - index * 0.02, initialWear: [wear, wear, wear, wear], laps: [{ fuelUsed: 0.02, wear: [0.001, 0.001, 0.001, 0.001] }] }, runtime.udpPort);
      currentTimestamp = next + 60_250;
    }
    await expect.poll(async () => (await stints(api, b.id)).at(-1)?.fuel.source).toBe("current-stint");
    const currentRate = (await stints(api, b.id)).at(-1)!.fuel;
    expect(currentRate.value).toBeCloseTo(0.02, 5);
    expect(currentRate.eligibleLaps).toBe(2);

    // Delete A via actual bulk-delete route while B remains live; history disappears, current B rate remains.
    const deletion = await api.post("/api/sessions/bulk-delete", { data: { ids: [a.id] } });
    expect(deletion.ok(), await deletion.text()).toBe(true);
    await expect.poll(async () => (await listSessions(api)).some((session) => session.id === a.id)).toBe(false);
    await expect.poll(async () => (await baseline(api, b.id, bStint.id)).historyRevision).toBeGreaterThan(beforeDeleteRevision);
    const afterDelete = await baseline(api, b.id, bStint.id);
    expect(afterDelete.fuel.value).toBeNull();
    expect(afterDelete.evidence.some((row) => row.sessionId === a.id)).toBe(false);
    for (let index = 1; index <= 12; index++) await pulse(runtime, 642, currentTimestamp + index * 250, { firstLap: 4, initialFuel: 0.84, initialWear: [0.103, 0.103, 0.103, 0.103] });
    await expect.poll(() => targetSnapshots.some((snapshot) => snapshot.historyRevision > beforeDeleteRevision && snapshot.fuel.source === "current-stint" && Math.abs((snapshot.fuel.value ?? 0) - 0.02) < 0.00001)).toBe(true);
    const finalRate = (await stints(api, b.id)).at(-1)!.fuel;
    expect(finalRate.source).toBe("current-stint");
    expect(finalRate.value).toBeCloseTo(0.02, 5);
    expect((await estimates(api, b.id)).filter((record) => originalBIds.has(record.id))).toEqual(bSaved);
    expect(historyEvents.some((event) => event.driverKey === "local-player" && (event.historyRevision ?? 0) > initialHistoryRevision)).toBe(true);
    expect(targetSnapshots.some((snapshot) => snapshot.historyRevision > initialHistoryRevision && snapshot.fuel.source !== "history")).toBe(true);
  } finally {
    socket.close();
    await api.dispose();
    await runtime.stop();
  }
});
