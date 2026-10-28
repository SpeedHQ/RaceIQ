import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ActiveRacePlansResponseSchema, RacePlanRecalculationResponseSchema, RacePlanSchema, RacePlansResponseSchema, type RacePlanCombo, type RacePlanInput } from "@raceiq/shared/racing/live/race-plan";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { ingestF1Laps } from "./f1-source";
import { StrategyRuntime } from "./runtime";

const sessionSchema = z.object({ id: z.number().int(), carId: z.string(), trackId: z.string() });
async function newestSession(api: APIRequestContext, gameId: string) {
  const response = await api.get(`/api/sessions?gameId=${gameId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return z.array(sessionSchema).parse(await response.json()).sort((a, b) => b.id - a.id)[0]!;
}
async function summaries(api: APIRequestContext, sessionId: number, gameId = "f1-2025") {
  const response = await api.get(`/api/sessions/${sessionId}/stints`, { headers: { "X-Game-Id": gameId } });
  expect(response.ok(), await response.text()).toBe(true);
  return StintsResponseSchema.parse(await response.json()).stints;
}
async function plans(api: APIRequestContext, gameId = "f1-2025") {
  return RacePlansResponseSchema.parse(await (await api.get(`/api/race-plans?gameId=${gameId}`)).json()).plans;
}
async function active(api: APIRequestContext, combo: RacePlanCombo) {
  const response = await api.get("/api/race-plans/active");
  expect(response.ok(), await response.text()).toBe(true);
  return ActiveRacePlansResponseSchema.parse(await response.json()).plans.find((plan) =>
    plan.gameId === combo.gameId && plan.carId === combo.carId && plan.trackId === combo.trackId) ?? null;
}
const measured = (source: StintSummary) => source.status !== "active" && source.fuel.value != null && source.fuel.eligibleLaps > 0 && source.averageLapSeconds != null && source.tires.every((rate) => rate.value != null && rate.eligibleLaps > 0);

test("C1/R1-R3/S1 recalculates saved strategy from newer improved sealed driving", async ({ playwright }, testInfo) => {
  test.setTimeout(420_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-recalculation"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  try {
    await ingestF1Laps(runtime.udpPort, 6, 1101n, 0.8, 4);
    const oldSession = await newestSession(api, "f1-2025");
    await ingestF1Laps(runtime.udpPort, 1, 1102n);
    await expect.poll(async () => (await summaries(api, oldSession.id)).filter(measured).length).toBe(2);
    const oldSources = (await summaries(api, oldSession.id)).filter(measured);
    const source = oldSources[0]!;
    const reserve = 0.01;
    const capacity = 0.6;
    const generation = { fuelCapacity: capacity, fuelReserve: reserve, energyReserveFraction: 0 };
    const maxWear = Math.max(...oldSources.flatMap((item) => item.tires.map((tire) => tire.value!)));
    const thresholds = Object.fromEntries([...new Set(oldSources.flatMap((item) => item.compounds))].map((compound) => [compound!, { cliffPct: 100 - maxWear * 525, deadPct: 1 }]));
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "f1-2025": thresholds } } })).ok()).toBe(true);
    const created = await api.post("/api/race-plans", { data: {
      name: "Original timed strategy", gameId: "f1-2025", carId: source.carId, trackId: source.trackId, pi: source.pi,
      totalLaps: 20, raceLength: { mode: "time", durationSeconds: 1200, averageLapSeconds: 60 },
      fuelUnit: source.fuelUnit, notes: "", generation,
      stints: [5, 10, 15, 20].map((endLap, index) => ({
        endLap, startFuel: capacity - index * 5 * source.fuel.value!, compounds: source.compounds,
        sourceSessionId: source.sessionId, sourceStintId: source.id,
      })),
    } });
    expect(created.status(), await created.text()).toBe(201);
    const original = RacePlanSchema.parse(await created.json());
    expect((await api.put("/api/race-plans/active", { data: {
      gameId: original.gameId, carId: original.carId, trackId: original.trackId, planId: original.id,
    } })).ok()).toBe(true);
    expect(original.generation).toEqual(generation);
    expect(original.totalLaps).toBe(20);
    expect(original.stints.map((stint) => stint.endLap)).toEqual([5, 10, 15, 20]);
    await ingestF1Laps(runtime.udpPort, 6, 1103n, 0.4, 4, 1, { lapSeconds: 50, fuelPerLap: 1.2 });
    const improved = await newestSession(api, "f1-2025");
    const provisional = await api.post(`/api/race-plans/${original.id}/recalculate`, { data: { generation } });
    expect(provisional.status(), await provisional.text()).toBe(200);
    expect(RacePlanRecalculationResponseSchema.parse(await provisional.json()).sources.every((item) => item.sessionId !== improved.id)).toBe(true);
    await ingestF1Laps(runtime.udpPort, 3, 1104n, 0.1, null, 1, { lapSeconds: 40, fuelPerLap: 0.6, teamId: 2 });
    const incompatible = await newestSession(api, "f1-2025");
    expect(incompatible.carId).not.toBe(original.carId);
    // Seal the incompatible recording without creating a newer measured baseline after restart.
    await ingestF1Laps(runtime.udpPort, 0, 1105n);
    await expect.poll(async () => (await summaries(api, improved.id)).filter(measured).length).toBe(2);
    const expectedImproved = (await summaries(api, improved.id)).find(measured)!;
    const originalRows = z.array(z.object({ id: z.string(), payload: z.string() })).parse(
      await runtime.databaseStatement("SELECT id,payload FROM strategy_stints WHERE session_id=?", [improved.id]),
    );
    const recorded = z.array(z.object({ raw_file: z.string() })).parse(await runtime.databaseStatement("SELECT raw_file FROM sessions WHERE id=?", [improved.id]))[0]!;
    // Freeze this runner-owned recording while intentionally corrupting its derived fixtures.
    // Offline writes cannot race the backend; detaching the source prevents startup repair from masking the fault.
    await runtime.crash();
    await runtime.databaseStatement("UPDATE sessions SET raw_file=NULL WHERE id=?", [improved.id], true);
    await runtime.restart();
    for (const [path, value] of [
      ["$.gameId", "acc"], ["$.carId", "incompatible"], ["$.trackId", "incompatible"],
      ["$.driverKey", "other-driver"], ["$.pi", 800], ["$.fuelUnit", "L"],
      ["$.compounds[0]", "incompatible"], ["$.compatibility.setupKey", "known-other-setup"],
      ["$.compatibility.fuelSemanticVersion", "different-fuel"],
      ["$.compatibility.tireSemanticVersions[0]", "different-wear"],
    ] as const) {
      await runtime.crash();
      await runtime.databaseStatement("UPDATE strategy_stints SET payload=json_set(payload,?,?) WHERE session_id=?", [path, value, improved.id], true);
      await runtime.restart();
      try {
        const isolated = await api.post(`/api/race-plans/${original.id}/recalculate`, { data: { generation } });
        expect(isolated.status(), `isolation ${path}: ${await isolated.text()}`).toBe(200);
        expect(RacePlanRecalculationResponseSchema.parse(await isolated.json()).sources.every((item) => item.sessionId !== improved.id), path).toBe(true);
      } finally {
        await runtime.crash();
        for (const row of originalRows) await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=?", [row.payload, row.id], true);
        await runtime.restart();
      }
    }
    for (const status of ["recording", "finalizing", "recovering", "failed"]) {
      await runtime.crash();
      await runtime.databaseStatement("INSERT INTO live_captures(session_id,capture_epoch,attempt,source_path,archive_path,status) VALUES(?,?,?,?,?,?)",
        [improved.id, `excluded-${status}`, "fixture", recorded.raw_file, `${recorded.raw_file}.archive`, status], true);
      await runtime.restart();
      try {
        const isolated = await api.post(`/api/race-plans/${original.id}/recalculate`, { data: { generation } });
        expect(isolated.status(), await isolated.text()).toBe(200);
        expect(RacePlanRecalculationResponseSchema.parse(await isolated.json()).sources.every((item) => item.sessionId !== improved.id), status).toBe(true);
      } finally {
        await runtime.crash();
        await runtime.databaseStatement("DELETE FROM live_captures WHERE session_id=?", [improved.id], true);
        await runtime.restart();
      }
    }
    await runtime.crash();
    await runtime.databaseStatement("UPDATE sessions SET raw_file=? WHERE id=?", [recorded.raw_file, improved.id], true);
    await runtime.restart();

    const mixedInput: RacePlanInput = { name: "Mixed compound strategy", gameId: original.gameId, carId: original.carId, trackId: original.trackId, pi: original.pi,
      totalLaps: 20, raceLength: { mode: "time", durationSeconds: 1200, averageLapSeconds: 60 }, fuelUnit: original.fuelUnit, notes: "", generation: null,
      stints: oldSources.map((item, index) => ({ endLap: (index + 1) * 10, startFuel: capacity - index * 10 * source.fuel.value!, compounds: [...item.compounds], sourceSessionId: item.sessionId, sourceStintId: item.id })) };
    const mixedResponse = await api.post("/api/race-plans", { data: mixedInput });
    expect(mixedResponse.status(), await mixedResponse.text()).toBe(201);
    const mixed = RacePlanSchema.parse(await mixedResponse.json());
    const response = await api.post(`/api/race-plans/${mixed.id}/recalculate`, { data: { generation } });
    expect(response.status(), await response.text()).toBe(200);
    const mixedProposal = RacePlanRecalculationResponseSchema.parse(await response.json());
    expect(mixedProposal.draft.stints.map((stint) => stint.endLap)).toEqual([10, 20, 24]);
    expect(mixedProposal.draft.stints[0]!.compounds).toEqual(oldSources[0]!.compounds);
    expect(mixedProposal.draft.stints[1]!.compounds).toEqual(oldSources[1]!.compounds);
    expect(mixedProposal.sources.every((item) => item.sessionId === improved.id)).toBe(true);
    let remainingInitialFuel = capacity;
    let previousEnd = 0;
    for (const stint of mixedProposal.draft.stints) {
      expect(stint.startFuel).toBeCloseTo(remainingInitialFuel, 8);
      const phaseSource = mixedProposal.sources.find((item) => item.id === stint.sourceStintId)!;
      remainingInitialFuel -= (stint.endLap - previousEnd) * phaseSource.fuel.value!;
      previousEnd = stint.endLap;
    }
    const shortResponse = await api.post("/api/race-plans", { data: { ...mixedInput, name: "Infeasible anchor", raceLength: { mode: "time", durationSeconds: 400, averageLapSeconds: 20 } } });
    expect(shortResponse.status()).toBe(201);
    const short = RacePlanSchema.parse(await shortResponse.json());
    const longResponse = await api.post("/api/race-plans", { data: { ...mixedInput, name: "Too many resource stops", totalLaps: 101, raceLength: { mode: "laps" },
      stints: mixedInput.stints.map((stint, index) => ({ ...stint, endLap: index === 0 ? 10 : 101 })) } });
    expect(longResponse.status()).toBe(201);
    const long = RacePlanSchema.parse(await longResponse.json());
    const beforeErrors = await plans(api);
    expect((await api.post(`/api/race-plans/${short.id}/recalculate`, { data: { generation } })).status()).toBe(422);
    expect((await api.post(`/api/race-plans/${original.id}/recalculate`, { data: { generation: { ...generation, fuelCapacity: 2 } } })).status()).toBe(400);
    expect((await api.post("/api/race-plans/missing/recalculate", { data: { generation } })).status()).toBe(404);
    expect((await api.post(`/api/race-plans/${original.id}/recalculate`, { data: { generation: { fuelCapacity: 0.000001, fuelReserve: 0, energyReserveFraction: 0 } } })).status()).toBe(422);
    expect((await api.post(`/api/race-plans/${long.id}/recalculate`, { data: { generation: { ...generation, fuelCapacity: expectedImproved.fuel.value! + reserve + 0.000001 } } })).status()).toBe(422);
    expect(await plans(api)).toEqual(beforeErrors);
    expect((await active(api, original))?.id).toBe(original.id);
  } finally {
    await api.dispose();
    await runtime.stop();
  }
});

test("E1 native LMU energy independently limits stops and missing energy refuses recalculation", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(420_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-native-energy"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const splitComplete = page.getByRole("dialog", { name: "Sparse recordings split", exact: true }).getByRole("button", { name: "Close", exact: true });
  await page.addLocatorHandler(splitComplete, () => splitComplete.click());
  const importEnergy = async (mode: string) => {
    const target = testInfo.outputPath(`${mode}.bin`);
    await promisify(execFile)("bun", [resolve(runtime.root, "packages/race-strategy/test/e2e/convert-lmu-fixture.ts"), resolve(runtime.root, "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz"), target, mode]);
    const response = await api.post("/api/laps/import", { multipart: { ownership: "mine", file: { name: `${mode}.bin`, mimeType: "application/octet-stream", buffer: await readFile(target) } }, timeout: 120_000 });
    expect(response.ok(), await response.text()).toBe(true);
    const result = z.object({ laps: z.array(z.object({ sessionId: z.number().int() })).min(1) }).parse(await response.json());
    await runtime.restart();
    await runtime.waitForStrategyBackfill();
    return result.laps[0]!.sessionId;
  };
  try {
    const highId = await importEnergy("strategy-energy");
    await expect.poll(async () => (await summaries(api, highId, "lmu")).some((item) => measured(item) && item.virtualEnergy?.value != null && item.virtualEnergy.value > 0), { timeout: 90_000 }).toBe(true);
    const high = (await summaries(api, highId, "lmu")).find((item) => measured(item) && item.virtualEnergy?.value != null && item.virtualEnergy.value > 0)!;
    expect(high.fuel.unit).toBe("L/lap");
    expect(high.virtualEnergy!.unit).toBe("energyFraction/lap");
    const capacity = 200;
    const reserve = 1;
    const energyReserve = 0.1;
    const energyLimit = Math.floor((1 - energyReserve) / high.virtualEnergy!.value!);
    expect(energyLimit).toBeLessThan(Math.floor((capacity - reserve) / high.fuel.value!));
    await page.goto(`${runtime.baseURL}/lmu/strategy?sessionId=${highId}`);
    const generator = page.getByTestId("race-strategy-generator");
    await generator.getByLabel("Plan name").fill("Native energy strategy");
    await generator.getByLabel("Total laps").fill("18");
    await generator.getByLabel("Fuel tank capacity (L)").fill(String(capacity));
    await generator.getByLabel("Fuel reserve at each stop (L)").fill(String(reserve));
    await generator.getByLabel("Virtual energy reserve (%)").fill("10");
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await expect(planner.getByLabel("Pit / finish lap").first()).toHaveValue(String(energyLimit));
    await expect(planner.getByTestId("race-plan-required-energy").first()).toContainText((energyLimit * high.virtualEnergy!.value! * 100).toFixed(1));
    const displayedFuel = (await planner.getByTestId("race-plan-required-fuel").first().innerText()).match(/(\d+(?:\.\d+)?)\sL\b/);
    expect(displayedFuel).not.toBeNull();
    expect(Math.abs(Number(displayedFuel![1]) - energyLimit * high.fuel.value!)).toBeLessThanOrEqual(0.1);
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status").filter({ hasText: "Plan saved" })).toBeVisible();
    const original = (await plans(api, "lmu"))[0]!;
    expect(original.generation).toEqual({ fuelCapacity: capacity, fuelReserve: reserve, energyReserveFraction: energyReserve });
    const lowId = await importEnergy("strategy-low-energy");
    const low = (await summaries(api, lowId, "lmu")).find((item) => measured(item) && item.virtualEnergy?.value != null && item.virtualEnergy.value > 0)!;
    expect(low.fuel.value).toBeCloseTo(high.fuel.value!, 5);
    expect(low.virtualEnergy!.value).toBeLessThan(high.virtualEnergy!.value!);
    const zeroId = await importEnergy("strategy-zero-energy");
    const zeroResponse = await api.post(`/api/race-plans/${original.id}/recalculate`, { data: { generation: original.generation } });
    expect(zeroResponse.status(), await zeroResponse.text()).toBe(200);
    const zeroProposal = RacePlanRecalculationResponseSchema.parse(await zeroResponse.json());
    expect(zeroProposal.sources[0]!.sessionId).toBe(zeroId);
    expect(zeroProposal.sources[0]!.virtualEnergy?.value).toBe(0);
    expect(zeroProposal.draft.stints.map((stint) => stint.endLap)).toEqual([18]);
    const missingId = await importEnergy("strategy-missing-energy");
    expect((await summaries(api, missingId, "lmu")).every((item) => item.virtualEnergy?.value == null)).toBe(true);
    const deletion = await api.post("/api/sessions/bulk-delete", { data: { ids: [highId, lowId, zeroId] } });
    expect(deletion.ok(), await deletion.text()).toBe(true);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
