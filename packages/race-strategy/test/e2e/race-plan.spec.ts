import { expect, test, type APIRequestContext } from "@playwright/test";
import { ActiveRacePlanResponseSchema, RacePlansResponseSchema } from "@raceiq/shared/racing/live/race-plan";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { z } from "zod";
import { ingestF1Laps } from "./f1-source";
import { ingestNativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";

const headers = { "X-Game-Id": "f1-2025" };
const SessionSchema = z.object({ id: z.number().int(), carId: z.string() });

async function sessionFor(api: APIRequestContext, gameId: string) {
  let session: z.infer<typeof SessionSchema> | undefined;
  await expect.poll(async () => {
    const response = await api.get(`/api/sessions?gameId=${gameId}`);
    expect(response.ok(), await response.text()).toBe(true);
    session = z.array(SessionSchema).parse(await response.json()).sort((a, b) => b.id - a.id)[0];
    return session?.id;
  }).toBeTruthy();
  return session!;
}

async function activePlan(api: APIRequestContext) {
  const response = await api.get("/api/race-plans/active");
  expect(response.ok(), await response.text()).toBe(true);
  return ActiveRacePlanResponseSchema.parse(await response.json()).plan;
}

test("R1-R5 builds a history-backed plan, survives restart, and applies only to its live identity", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-race-plan"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 6, 460n, 0.8);
    const source = await sessionFor(api, "f1-2025");
    await ingestF1Laps(runtime.udpPort, 4, 461n, 1);
    await expect.poll(async () => {
      const response = await api.get(`/api/sessions/${source.id}/stints`, { headers });
      return response.ok() && StintsResponseSchema.parse(await response.json()).stints.some((stint) => (stint.status === "completed" || stint.status === "interrupted") && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null));
    }).toBe(true);

    await page.goto(`${runtime.baseURL}/f125/sessions/${source.id}/analyse`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Stint averages", exact: true }).click();
    await expect(page.getByTestId("stint-summary-table")).toBeVisible();
    await expect(page.getByTestId("race-strategy-planner")).toHaveCount(0);
    await page.getByRole("link", { name: "Strategies", exact: true }).click();
    await expect(page).toHaveURL(`${runtime.baseURL}/f125/strategy`);
    const strategyUrl = `${runtime.baseURL}/f125/strategy`;
    const planner = page.getByTestId("race-strategy-planner");
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    await expect(planner).toBeVisible();
    await planner.getByLabel("History session").selectOption(String(source.id));
    await planner.getByLabel("Plan name").fill("Native-history race plan");
    await planner.getByLabel("Total laps").fill("120");
    await planner.getByRole("button", { name: "Add pit stop" }).click();
    const sourceResponse = await api.get(`/api/sessions/${source.id}/stints`, { headers });
    expect(sourceResponse.ok(), await sourceResponse.text()).toBe(true);
    const sourceStint = StintsResponseSchema.parse(await sourceResponse.json()).stints.find((stint) => (stint.status === "completed" || stint.status === "interrupted") && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null));
    expect(sourceStint).toBeTruthy();
    expect(sourceStint!.compounds.every((compound) => compound != null)).toBe(true);
    const stints = planner.locator("fieldset");
    const historySelect = stints.nth(0).locator("select").nth(0);
    const sourceOption = `${source.id}:${sourceStint!.id}`;
    await expect.poll(() => historySelect.locator("option").evaluateAll((options, expected) => options.some((option) => (option as HTMLOptionElement).value === expected), sourceOption)).toBe(true);
    await historySelect.selectOption(sourceOption);
    await planner.getByLabel("Pit / finish lap").nth(0).fill("101");
    for (const row of [0, 1]) {
      const stint = stints.nth(row);
      await stint.locator('input[type="number"]').nth(1).fill("80");
    }
    await expect(planner).toContainText("Expected fuel used");
    await expect(planner).toContainText("Expected consumption exceeds planned starting fuel.");
    await expect(planner).toContainText("19.2%");
    await expect(planner).toContainText("At or below dead threshold");
    expect(await planner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await planner.screenshot({ path: testInfo.outputPath("race-planner-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await planner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await planner.screenshot({ path: testInfo.outputPath("race-planner-mobile.png") });
    await planner.getByLabel("Plan name").focus();
    await page.keyboard.press("Tab");
    expect(await planner.getByLabel("History session").evaluate((element) => element === document.activeElement)).toBe(true);
    await expect(planner).toContainText("Snapshot: session");
    await page.route("**/api/race-plans", async (route) => {
      if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected save failure" }) });
      else await route.continue();
    });
    await planner.getByRole("button", { name: "Save plan" }).click();
    await expect(planner.getByRole("alert")).toBeVisible();
    await expect(planner.getByLabel("Plan name")).toHaveValue("Native-history race plan");
    await page.unroute("**/api/race-plans");
    await planner.getByRole("button", { name: "Save plan" }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    const plansResponse = await api.get("/api/race-plans?gameId=f1-2025");
    expect(plansResponse.ok(), await plansResponse.text()).toBe(true);
    const saved = RacePlansResponseSchema.parse(await plansResponse.json()).plans[0]!;
    expect(saved.stints.map((stint) => stint.endLap)).toEqual([101, 120]);
    expect(saved.stints[0]?.sourceSessionId).toBe(source.id);
    expect(saved.stints[0]?.evidence).not.toBeNull();
    const savedInput = {
      name: saved.name, gameId: saved.gameId, carId: saved.carId, trackId: saved.trackId, pi: saved.pi,
      totalLaps: saved.totalLaps, fuelUnit: saved.fuelUnit, notes: saved.notes,
      stints: saved.stints.map(({ evidence: _evidence, ...stint }) => stint),
    };
    expect((await api.put(`/api/race-plans/${saved.id}`, { data: { ...savedInput, stints: savedInput.stints.map((stint) => ({ ...stint, endLap: 1 })) } })).status()).toBe(400);
    expect((await api.put(`/api/race-plans/${saved.id}`, { data: { ...savedInput, carId: "different-native-car" } })).status()).toBe(400);
    const afterInvalid = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=f1-2025")).json()).plans[0];
    expect(afterInvalid).toEqual(saved);

    await runtime.restart();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Native-history race plan", exact: true }).click();
    expect(saved.stints[0]?.sourceSessionId).toBe(source.id);
    expect(saved.stints[0]?.evidence).not.toBeNull();
    await planner.getByRole("button", { name: "Native-history race plan" }).click();
    await planner.getByLabel("Notes").fill("Edited after restart");
    await planner.getByRole("button", { name: "Save changes" }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    expect(saved.stints[1]?.sourceSessionId).toBeNull();
    await planner.getByRole("button", { name: "Load", exact: true }).click();
    await expect.poll(async () => (await activePlan(api))?.id ?? null).toBe(saved.id);
    await ingestF1Laps(runtime.udpPort, 4, 462n, 1);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const compact = page.getByTestId("race-strategy-live");
    await expect(compact).toContainText("Native-history race plan");
    await expect(page.getByTestId("pit-estimate-live")).not.toBeAttached();
    await expect(compact.getByTestId("race-strategy-tire-life").first()).toContainText("soft");
    await compact.screenshot({ path: testInfo.outputPath("selected-strategy-desktop.png") });
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    const live = page.getByTestId("live-race-strategy");
    await expect(live).toContainText("Native-history race plan");
    await expect(live).toContainText("Planned stint");
    await expect(live).toContainText("Next planned pit: lap 101");
    await ingestNativeRun({ carId: 639, timestampMs: 900_000, laps: [] }, runtime.udpPort);
    // Switching games remounts the dashboard and closes its expanded strategy view.
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
    await expect(compact).not.toBeAttached();
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await expect(live).toContainText("Not applicable");

    await page.goto(strategyUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Native-history race plan", exact: true }).click();
    await planner.getByRole("button", { name: "Unload active plan" }).click();
    await expect.poll(async () => (await activePlan(api))?.id ?? null).toBeNull();
    await planner.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(async () => {
      const response = await api.get("/api/race-plans?gameId=f1-2025");
      return RacePlansResponseSchema.parse(await response.json()).plans.length;
    }).toBe(0);
    const snapshotResponse = await api.post("/api/race-plans", { data: { ...savedInput, name: "Snapshot retention" } });
    expect(snapshotResponse.status()).toBe(201);
    const snapshotId = (await snapshotResponse.json()).id;
    const deletedSource = await api.post("/api/sessions/bulk-delete", { data: { ids: [source.id] } });
    expect(deletedSource.ok(), await deletedSource.text()).toBe(true);
    const retained = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=f1-2025")).json()).plans.find((plan) => plan.id === snapshotId);
    expect(retained?.stints[0]?.evidence).toEqual(saved.stints[0]?.evidence);
    expect((await api.delete(`/api/race-plans/${snapshotId}`)).ok()).toBe(true);

    const boundaryResponse = await api.post("/api/race-plans", { data: {
      name: "Boundary plan", gameId: "fm-2023", carId: "639", trackId: "5", pi: 800,
      totalLaps: 20, fuelUnit: "tankFraction", notes: "",
      stints: [10, 20].map((endLap) => ({ endLap, startFuel: 0, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null })),
    } });
    expect(boundaryResponse.status()).toBe(201);
    const boundaryPlan = await boundaryResponse.json();
    expect((await api.put("/api/race-plans/active", { data: { planId: boundaryPlan.id } })).ok()).toBe(true);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await expect(live).toContainText("Next planned pit: lap 10");
    await expect(compact).toContainText("Next planned pit: lap 10");
    await ingestNativeRun({ carId: 639, firstLap: 11, timestampMs: 901_000, laps: [] }, runtime.udpPort);
    await expect(live).toContainText("Final stint; finish instead of pit.");
    await expect(compact).toContainText("Final stint; finish instead of pit.");
    await ingestNativeRun({ carId: 639, firstLap: 21, timestampMs: 902_000, laps: [] }, runtime.udpPort);
    await expect(live).toContainText("Race plan complete. No further pit stop.");
    await expect(compact).toContainText("Race plan complete. No further pit stop.");
    await ingestNativeRun({ carId: 639, firstLap: 5, timestampMs: 903_000, laps: [] }, runtime.udpPort);
    await expect(live).toContainText("Next planned pit: lap 10");
    await expect(compact).toContainText("Next planned pit: lap 10");
    expect((await api.delete(`/api/race-plans/${boundaryPlan.id}`)).ok()).toBe(true);
    await expect.poll(async () => (await activePlan(api))?.id ?? null).toBeNull();
    await expect(page.getByTestId("pit-estimate-live")).toBeAttached({ timeout: 20_000 });
    await expect(compact).not.toBeAttached();
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("T1-T5 saves a timed race, derives fuel at selected stops, and retains invalid draft edits", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-timed-race"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 6, 810n);
    const source = await sessionFor(api, "f1-2025");
    await ingestF1Laps(runtime.udpPort, 3, 811n);
    const readSource = async () => {
      const response = await api.get(`/api/sessions/${source.id}/stints`, { headers });
      expect(response.ok()).toBe(true);
      return StintsResponseSchema.parse(await response.json()).stints.find((stint) =>
        stint.status !== "active" && stint.averageLapSeconds != null && stint.averageLapSeconds > 0 &&
        stint.paceLaps > 0 && stint.fuel.value != null && stint.fuel.value > 0);
    };
    await expect.poll(async () => (await readSource())?.id).toBeTruthy();
    const evidence = (await readSource())!;
    const rate = evidence.fuel.value!;
    const required = rate * 10;
    expect(required * 3).toBeLessThan(1);
    await page.goto(`${runtime.baseURL}/f125/strategy`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await expect(planner).toBeVisible();
    await planner.getByLabel("History session").selectOption(String(source.id));
    await planner.getByLabel("Plan name").fill("Timed fuel strategy");
    await planner.getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}`);
    await planner.getByLabel("Race length", { exact: true }).selectOption("time");
    await expect(planner.getByLabel("Average lap (s)", { exact: true })).toHaveValue(String(evidence.averageLapSeconds));
    await planner.getByLabel("Race time (minutes)").fill("30");
    await expect(planner.getByTestId("race-time-estimate")).toContainText(`${Math.ceil(1800 / evidence.averageLapSeconds!)} laps`);
    await planner.getByLabel("Average lap (s)", { exact: true }).fill("90");
    await expect(planner.getByTestId("race-time-estimate")).toContainText("20 laps");
    await planner.getByLabel("Race time (minutes)").fill("30.01");
    await expect(planner.getByTestId("race-time-estimate")).toContainText("21 laps");
    await planner.getByLabel("Race time (minutes)").fill("30");
    await planner.getByRole("button", { name: "Add pit stop" }).click();
    const rows = planner.locator("fieldset");
    await rows.nth(0).getByLabel("Pit / finish lap").fill("10");
    await rows.nth(1).getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}`);
    await rows.nth(0).getByLabel("Starting fuel").fill(String(required * 150));
    await rows.nth(1).getByLabel("Starting fuel").fill(String(required * 100));
    await expect(rows.nth(0).getByTestId("race-plan-required-fuel")).toHaveText(`Required fuel: ${(required * 100).toFixed(1)}%`);
    await expect(rows.nth(1).getByTestId("race-plan-refuel")).toHaveText(`Fuel to add at stop: ${(required * 50).toFixed(1)}%`);
    await rows.nth(0).getByLabel("Starting fuel").fill(String(required * 300));
    await expect(rows.nth(1).getByTestId("race-plan-refuel")).toHaveText("Fuel to add at stop: 0.0%");
    await rows.nth(0).getByLabel("Starting fuel").fill("");
    await expect(rows.nth(1).getByTestId("race-plan-refuel")).toContainText("unavailable");
    await rows.nth(0).getByLabel("Starting fuel").fill("0");
    await expect(rows.nth(0)).toContainText("Expected consumption exceeds planned starting fuel.");
    await expect(rows.nth(1).getByTestId("race-plan-refuel")).toContainText("unavailable");
    await rows.nth(0).getByLabel("Starting fuel").fill(String(required * 150));
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status").filter({ hasText: "Plan saved" })).toBeVisible();
    const saved = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=f1-2025")).json()).plans.find((plan) => plan.name === "Timed fuel strategy")!;
    expect(saved.raceLength).toEqual({ mode: "time", durationSeconds: 1800, averageLapSeconds: 90 });
    expect(saved.stints.map((stint) => stint.endLap)).toEqual([10, 20]);
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...savedInput } = saved;
    const input = { ...savedInput, stints: savedInput.stints.map(({ evidence: _evidence, ...stint }) => stint) };
    for (const raceLength of [
      { mode: "time", durationSeconds: 1801, averageLapSeconds: 90 },
      { mode: "time", durationSeconds: 0, averageLapSeconds: 90 },
      { mode: "time", durationSeconds: 1800, averageLapSeconds: 0 },
      { mode: "time", durationSeconds: 604801, averageLapSeconds: 90 },
    ]) {
      expect((await api.put(`/api/race-plans/${saved.id}`, { data: { ...input, raceLength } })).status()).toBe(400);
    }
    expect((await api.put(`/api/race-plans/${saved.id}`, {
      data: { ...input, stints: input.stints.map((stint, index) => ({ ...stint, endLap: index === 0 ? 20 : 10 })) },
    })).status()).toBe(400);
    expect(RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=f1-2025")).json()).plans.find((plan) => plan.id === saved.id)).toEqual(saved);
    await runtime.restart();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Timed fuel strategy", exact: true }).click();
    await expect(planner.getByLabel("Race length", { exact: true })).toHaveValue("time");
    await expect(planner.getByLabel("Race time (minutes)")).toHaveValue("30");
    await expect(planner.getByLabel("Average lap (s)", { exact: true })).toHaveValue("90");
    await expect(rows.nth(1).getByTestId("race-plan-refuel")).toHaveText(`Fuel to add at stop: ${(required * 50).toFixed(1)}%`);
    await planner.getByLabel("Race time (minutes)").fill("5");
    await expect(rows.nth(0).getByLabel("Pit / finish lap")).toHaveValue("10");
    await expect(planner.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await planner.getByLabel("Average lap (s)", { exact: true }).fill("");
    await expect(planner.getByTestId("race-time-estimate")).toContainText("Enter race time");
    await expect(rows.nth(0).getByTestId("race-plan-required-fuel")).toContainText("Unavailable");
    for (const [duration, pace] of [["30", "0"], ["", "90"], ["0", "90"], ["30", "0.01"], ["10081", "90"]]) {
      await planner.getByLabel("Race time (minutes)").fill(duration);
      await planner.getByLabel("Average lap (s)", { exact: true }).fill(pace);
      await expect(planner.getByTestId("race-time-estimate")).toContainText("Enter race time");
      await expect(planner.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await expect(rows.nth(0).getByLabel("Pit / finish lap")).toHaveValue("10");
      await expect(rows.nth(0).getByTestId("race-plan-required-fuel")).toContainText("Unavailable");
    }
    await planner.getByLabel("Race length", { exact: true }).selectOption("laps");
    await planner.getByLabel("Total laps").fill("20");
    await expect(planner.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await planner.getByLabel("Race length", { exact: true }).selectOption("time");
    await planner.getByLabel("Race time (minutes)").fill("30");
    await planner.getByLabel("Average lap (s)", { exact: true }).fill("90");
    await planner.getByRole("button", { name: "Save changes" }).click();
    await expect(planner.getByRole("status").filter({ hasText: "Plan saved" })).toBeVisible();
    await ingestF1Laps(runtime.udpPort, 3, 812n);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("summary").filter({ hasText: "Race strategy" }).click();
    await expect(planner).toHaveCount(0);
    await dialog.getByRole("link", { name: "Race strategy", exact: true }).click();
    await page.getByRole("button", { name: "Timed fuel strategy", exact: true }).click();
    await expect(planner.getByLabel("Race time (minutes)")).toHaveValue("30");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await planner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await planner.getByLabel("Race length", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(planner.getByLabel("Race time (minutes)")).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("timed-strategy-mobile.png") });
    const { raceLength: _length, ...legacyInput } = input;
    const legacyResponse = await api.post("/api/race-plans", { data: { ...legacyInput, name: "Legacy lap strategy" } });
    expect(legacyResponse.status()).toBe(201);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Legacy lap strategy", exact: true }).click();
    await expect(planner.getByLabel("Race length", { exact: true })).toHaveValue("laps");
    await expect(planner.getByLabel("Total laps")).toHaveValue("20");
    // Controlled liter/zero/unknown evidence exercises real UI -> API -> SQLite,
    // independently of the native F1 adapter's tank-fraction normalization.
    await runtime.crash();
    await runtime.databaseStatement("UPDATE sessions SET game_id='acc',raw_file=NULL WHERE id=?", [source.id], true);
    for (const fuelRate of [2.5, 0, null]) {
      const literEvidence = {
        ...evidence, gameId: "acc", fuelUnit: "L",
        fuel: { ...evidence.fuel, value: fuelRate, unit: "L/lap", source: fuelRate == null ? null : "current-stint", unavailableReason: fuelRate == null ? "missing" : null },
        compatibility: { ...evidence.compatibility, fuelSemanticVersion: "test-liters" },
      };
      await runtime.databaseStatement("INSERT OR REPLACE INTO strategy_stints(id,session_id,driver_key,ordinal,status,payload) VALUES(?,?,?,?,?,?)",
        [evidence.id, source.id, evidence.driverKey, evidence.ordinal, evidence.status, JSON.stringify(literEvidence)], true);
      await runtime.restart();
      const literResponse = await api.get(`/api/sessions/${source.id}/stints`, { headers: { "X-Game-Id": "acc" } });
      expect(literResponse.ok(), await literResponse.text()).toBe(true);
      expect(StintsResponseSchema.parse(await literResponse.json()).stints.find((stint) => stint.id === evidence.id)?.fuel.value).toBe(fuelRate);
      await page.goto(`${runtime.baseURL}/acc/strategy`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "New plan", exact: true }).click();
      await expect(planner).toBeVisible();
      await planner.getByLabel("History session").selectOption(String(source.id));
      await planner.getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}`);
      await planner.getByRole("button", { name: "Add pit stop" }).click();
      await rows.nth(0).getByLabel("Pit / finish lap").fill("10");
      await rows.nth(1).getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}`);
      await rows.nth(0).getByLabel("Starting fuel").fill(fuelRate ? "37.5" : "0");
      await rows.nth(1).getByLabel("Starting fuel").fill(fuelRate ? "25" : "0");
      await expect(rows.nth(0).getByTestId("race-plan-required-fuel")).toHaveText(`Required fuel: ${fuelRate == null ? "Unavailable" : `${(fuelRate * 10).toFixed(1)} L`}`);
      if (fuelRate == null) await expect(rows.nth(1).getByTestId("race-plan-refuel")).toContainText("unavailable");
      else await expect(rows.nth(1).getByTestId("race-plan-refuel")).toHaveText(`Fuel to add at stop: ${fuelRate === 0 ? "0.0" : "12.5"} L`);
      await runtime.crash();
    }
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("S1-S4 selected strategy replaces estimates and uses compound-specific tire life", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-selected-strategy"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 6, 910n);
    const source = await sessionFor(api, "f1-2025");
    await ingestF1Laps(runtime.udpPort, 2, 911n);
    const readEvidence = async () => {
      const response = await api.get(`/api/sessions/${source.id}/stints`, { headers });
      expect(response.ok()).toBe(true);
      return StintsResponseSchema.parse(await response.json()).stints.find((stint) => stint.status !== "active" && stint.tires.every((tire) => tire.eligibleLaps > 0));
    };
    await expect.poll(async () => (await readEvidence())?.id).toBeTruthy();
    const evidence = (await readEvidence())!;
    await runtime.crash();
    await runtime.databaseStatement("UPDATE sessions SET raw_file=NULL WHERE id=?", [source.id], true);
    for (const [profileIndex, compound] of ["soft", "hard", "default"].entries()) {
      const rates = compound === "soft" ? [0.02, 0.01, 0, null] : [0.005, 0.005, 0.005, 0.005];
      const snapshot = {
        ...evidence, id: `${evidence.id}-${compound}`, ordinal: evidence.ordinal + profileIndex + 1,
        compounds: [compound, compound, compound, compound],
        compatibility: {
          ...evidence.compatibility,
          tireSemanticVersions: evidence.compatibility.tireSemanticVersions.map((version, wheel) => compound === "hard" && wheel === 3 ? null : version),
        },
        tires: evidence.tires.map((tire, wheel) => ({
          ...tire, value: rates[wheel], source: rates[wheel] == null ? null : "current-stint",
          unavailableReason: rates[wheel] == null ? "missing" : null,
        })),
      };
      await runtime.databaseStatement("INSERT OR REPLACE INTO strategy_stints(id,session_id,driver_key,ordinal,status,payload) VALUES(?,?,?,?,?,?)",
        [snapshot.id, source.id, snapshot.driverKey, snapshot.ordinal, snapshot.status, JSON.stringify(snapshot)], true);
    }
    await runtime.restart();
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "f1-2025": {
      soft: { cliffPct: 40, deadPct: 20 }, hard: { cliffPct: 40, deadPct: 20 },
    } } } })).ok()).toBe(true);
    await page.goto(`${runtime.baseURL}/f125/strategy`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await planner.getByLabel("History session").selectOption(String(source.id));
    await planner.getByLabel("Plan name").fill("Compound-aware strategy");
    await planner.getByLabel("Total laps").fill("50");
    await planner.getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}-soft`);
    await planner.getByRole("button", { name: "Add pit stop" }).click();
    const rows = planner.locator("fieldset");
    await rows.nth(0).getByLabel("Pit / finish lap").fill("35");
    await rows.nth(1).getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}-hard`);
    await rows.nth(0).getByLabel("Starting fuel").fill("0");
    await rows.nth(1).getByLabel("Starting fuel").fill("90");
    const softLife = rows.nth(0).getByTestId("race-plan-tire-life");
    const hardLife = rows.nth(1).getByTestId("race-plan-tire-life");
    await expect(softLife.nth(0)).toHaveText("soft · Tire life: 30.0 laps to cliff · 40.0 laps to dead.");
    await expect(softLife.nth(2)).toHaveText("soft · No measured wear");
    await expect(softLife.nth(3)).toHaveText("soft · Unavailable");
    await expect(hardLife.nth(0)).toHaveText("hard · Tire life: 120.0 laps to cliff · 160.0 laps to dead.");
    await expect(hardLife.nth(3)).toHaveText("hard · Unavailable");
    await rows.nth(1).getByLabel("Evidence stint").selectOption("");
    await rows.nth(1).getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}-default`);
    await expect(hardLife.nth(0)).toHaveText("default · Unavailable");
    await rows.nth(1).getByLabel("Evidence stint").selectOption("");
    await rows.nth(1).getByLabel("Evidence stint").selectOption(`${source.id}:${evidence.id}-hard`);
    await expect(rows.nth(0)).toContainText("At or below cliff threshold");
    await expect(rows.nth(0)).toContainText("Expected consumption exceeds planned starting fuel.");
    await rows.nth(0).getByLabel("FL Tires", { exact: true }).selectOption("hard", { timeout: 15_000 });
    await expect(softLife.nth(0)).toHaveText("hard · Unavailable");
    await expect(planner.getByRole("button", { name: "Save plan", exact: true })).toBeDisabled();
    await rows.nth(0).getByLabel("FL Tires", { exact: true }).selectOption("soft", { timeout: 15_000 });
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status").filter({ hasText: "Plan saved" })).toBeVisible();
    await planner.getByRole("button", { name: "Load", exact: true }).click();
    await expect.poll(async () => (await activePlan(api))?.name).toBe("Compound-aware strategy");
    await ingestF1Laps(runtime.udpPort, 2, 912n);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const compact = page.getByTestId("race-strategy-live");
    await expect(compact).toContainText("Next planned pit: lap 35");
    await expect(page.getByTestId("pit-estimate-live")).not.toBeAttached();
    const tireRows = compact.getByTestId("race-strategy-tire-life");
    await expect(tireRows.nth(0)).toContainText("30.0");
    await expect(tireRows.nth(0)).toContainText("40.0");
    await expect(tireRows.nth(2)).toContainText("No measured wear");
    await expect(tireRows.nth(3)).toContainText("Unavailable");
    await expect(compact).toContainText("At or below cliff threshold");
    await expect(compact).toContainText("Expected consumption exceeds planned starting fuel.");
    await expect(compact.getByTestId("race-strategy-next-stint")).toContainText("hard");
    await expect(compact.getByTestId("race-strategy-next-stint")).toContainText("90.0%");
    await compact.screenshot({ path: testInfo.outputPath("compound-strategy-desktop.png") });
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "f1-2025": {
      soft: { cliffPct: 60, deadPct: 30 }, hard: { cliffPct: 40, deadPct: 20 },
    } } } })).ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(tireRows.nth(0)).toContainText("20.0");
    await expect(tireRows.nth(0)).toContainText("35.0");
    await expect(compact).toContainText("At or below dead threshold");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await compact.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await compact.screenshot({ path: testInfo.outputPath("compound-strategy-mobile.png") });
    await ingestF1Laps(runtime.udpPort, 0, 913n, 0.8, null, 0);
    await expect(compact).toContainText("Current lap unavailable");
    await expect(compact).not.toContainText("Next planned pit");
    await ingestF1Laps(runtime.udpPort, 0, 914n, 0.8, null, 36);
    await expect(compact).toContainText("Final stint; finish instead of pit.");
    await expect(tireRows.nth(0)).toContainText("hard");
    await expect(tireRows.nth(0)).toContainText("120.0");
    await ingestF1Laps(runtime.udpPort, 0, 915n, 0.8, null, 51);
    await expect(compact).toContainText("Race plan complete. No further pit stop.");
    await ingestF1Laps(runtime.udpPort, 0, 916n, 0.8, null, 35);
    await expect(compact).toContainText("Next planned pit: lap 35 · 0 laps remaining");
    await ingestF1Laps(runtime.udpPort, 0, 917n, 0.8, null, 5);
    await expect(compact).toContainText("Next planned pit: lap 35 · 30 laps remaining");
    const trigger = compact.getByRole("button", { name: "Open strategy timeline" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("summary").filter({ hasText: "Race strategy" }).click();
    await dialog.getByRole("link", { name: "Race strategy", exact: true }).click();
    await page.getByRole("button", { name: "Compound-aware strategy", exact: true }).click();
    await planner.getByRole("button", { name: "Unload active plan" }).click();
    await expect(planner.getByRole("status")).toContainText("Active plan unloaded.");
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pit-estimate-live")).toBeAttached();
    await expect(compact).not.toBeAttached();
    await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("S2 active-plan request failure preserves automatic estimates and Retry restores selection", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-selection-error"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 2, 920n);
    const source = await sessionFor(api, "f1-2025");
    const response = await api.post("/api/race-plans", { data: {
      name: "Manual selected strategy", gameId: "f1-2025", carId: source.carId, trackId: "0",
      pi: null, totalLaps: 20, fuelUnit: "tankFraction", notes: "",
      stints: [10, 20].map((endLap) => ({ endLap, startFuel: 0.5, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null })),
    } });
    expect(response.status()).toBe(201);
    const plan = await response.json();
    expect((await api.put("/api/race-plans/active", { data: { planId: plan.id } })).ok()).toBe(true);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const selected = page.getByTestId("race-strategy-live");
    await expect(selected).toContainText("Manual selected strategy");
    await expect(selected.getByTestId("race-strategy-tire-life").first()).toContainText("Unknown");
    await expect(selected.getByTestId("race-strategy-tire-life").first()).toContainText("Unavailable");
    await page.route("**/api/race-plans/active", (route) => route.fulfill({ status: 503, json: { error: "Injected selection transport failure" } }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
    await expect(selected).not.toBeAttached();
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    const details = page.getByTestId("live-race-strategy");
    await expect(details.getByRole("alert")).toContainText("Could not load the active race plan.");
    await page.unroute("**/api/race-plans/active");
    await details.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(selected).toContainText("Manual selected strategy");
    await page.keyboard.press("Escape");
    await expect(selected).toBeVisible();
    await expect(page.getByTestId("pit-estimate-live")).not.toBeAttached();
    const forza = await api.post("/api/race-plans", { data: {
      name: "Forza identity strategy", gameId: "fm-2023", carId: "639", trackId: "5",
      pi: 800, totalLaps: 20, fuelUnit: "tankFraction", notes: "",
      stints: [10, 20].map((endLap) => ({ endLap, startFuel: 0.5, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null })),
    } });
    expect(forza.status()).toBe(201);
    expect((await api.put("/api/race-plans/active", { data: { planId: (await forza.json()).id } })).ok()).toBe(true);
    let timestamp = 1_500_000;
    await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, timestampMs: timestamp, laps: [] }, runtime.udpPort);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(selected).toContainText("Forza identity strategy");
    for (const identity of [
      { carId: 642, trackId: 5, pi: 800 }, { carId: 639, trackId: 6, pi: 800 },
      { carId: 639, trackId: 5, pi: 801 }, { carId: 0, trackId: 5, pi: 800 },
      { carId: 639, trackId: 0, pi: 800 }, { carId: 639, trackId: 5, pi: 0 },
    ]) {
      timestamp += 1_000;
      await ingestNativeRun({ ...identity, timestampMs: timestamp, laps: [] }, runtime.udpPort);
      await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
      await expect(selected).not.toBeAttached();
      timestamp += 1_000;
      await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, timestampMs: timestamp, laps: [] }, runtime.udpPort);
      await expect(selected).toContainText("Forza identity strategy");
    }
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("G1-G2/L1 generates measured stops and manages persisted strategies", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-generated-strategy"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 6, 991n);
    const source = await sessionFor(api, "f1-2025");
    await ingestF1Laps(runtime.udpPort, 3, 992n);
    const readStints = async () => StintsResponseSchema.parse(await (await api.get(`/api/sessions/${source.id}/stints`, { headers })).json()).stints;
    await expect.poll(async () => (await readStints()).some((stint) => stint.status !== "active" && stint.fuel.value != null && stint.fuel.value > 0 && stint.tires.every((tire) => tire.value != null))).toBe(true);
    const evidence = (await readStints()).find((stint) => stint.status !== "active" && stint.fuel.value != null && stint.fuel.value > 0 && stint.tires.every((tire) => tire.value != null))!;
    const reserve = 0.01;
    const capacity = evidence.fuel.value! * 5 + reserve + 0.000001;
    expect(capacity).toBeLessThanOrEqual(1);
    await page.goto(`${runtime.baseURL}/f125/sessions/${source.id}/analyse?view=stints`);
    await page.getByRole("link", { name: "Generate race strategy", exact: true }).click();
    const generator = page.getByTestId("race-strategy-generator");
    await expect(generator.getByLabel("History session")).toHaveValue(String(source.id));
    await generator.getByLabel("Plan name").fill("Generated measured strategy");
    await generator.getByLabel("Evidence stint").selectOption(evidence.id);
    await generator.getByLabel("Total laps").fill("12");
    await generator.getByLabel("Fuel tank capacity (%)").fill(String(capacity * 100));
    await generator.getByLabel("Fuel reserve at each stop (%)").fill(String(capacity * 100));
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByRole("alert")).toContainText("Check race length");
    await generator.getByLabel("Fuel reserve at each stop (%)").fill(String(reserve * 100));
    await generator.getByLabel("Total laps").fill("10000");
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByRole("alert")).toContainText("no more than 100 stints");
    await generator.getByLabel("Total laps").fill("12");
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await expect.poll(() => planner.getByLabel("Pit / finish lap").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["5", "10", "12"]);
    await expect(planner.getByTestId("race-plan-refuel").first()).toHaveText(`Fuel to add at stop: ${(evidence.fuel.value! * 5 * 100).toFixed(1)}%`);
    await planner.screenshot({ path: testInfo.outputPath("generated-strategy-preview.png") });
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    const saved = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=f1-2025")).json()).plans[0]!;
    expect(saved.stints.map((stint) => stint.endLap)).toEqual([5, 10, 12]);
    for (let index = 0; index < saved.stints.length; index++) {
      const stint = saved.stints[index]!;
      expect(stint.startFuel!).toBeLessThanOrEqual(capacity);
      expect(stint.startFuel! - (stint.endLap - (saved.stints[index - 1]?.endLap ?? 0)) * evidence.fuel.value!).toBeCloseTo(reserve, 8);
      expect(stint.evidence?.id).toBe(evidence.id);
    }
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    const table = page.getByTestId("saved-strategies-table");
    await expect(table).toContainText(saved.name);
    await page.reload();
    await expect(table).toContainText(saved.name);
    await table.getByRole("button", { name: "Load", exact: true }).click();
    await expect.poll(async () => (await activePlan(api))?.id).toBe(saved.id);
    await table.getByRole("button", { name: saved.name, exact: true }).click();
    await planner.getByLabel("Notes").fill("Reviewed generated proposal");
    await planner.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("strategies-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("strategies-mobile.png") });
    await table.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("No saved plans for this game. Start a plan from this session or enter car and track.", { exact: true })).toBeVisible();
    expect(await activePlan(api)).toBeNull();
    const maxWear = Math.max(...evidence.tires.map((tire) => tire.value!));
    expect(maxWear).toBeGreaterThan(0);
    const compoundThresholds = Object.fromEntries([...new Set(evidence.compounds)].map((compound) => [compound!, { cliffPct: 100 - maxWear * 250, deadPct: 1 }]));
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "f1-2025": compoundThresholds } } })).ok()).toBe(true);
    await page.reload();
    await generator.getByLabel("Plan name").fill("Timed tire-limited proposal");
    await generator.getByLabel("Evidence stint").selectOption(evidence.id);
    await generator.getByLabel("Race length", { exact: true }).selectOption("time");
    await generator.getByLabel("Race time (minutes)").fill(String(evidence.averageLapSeconds! * 11.5 / 60));
    await generator.getByLabel("Fuel tank capacity (%)").fill("100");
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(planner.getByLabel("Race length", { exact: true })).toHaveValue("time");
    await expect.poll(() => planner.getByLabel("Pit / finish lap").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["2", "4", "6", "8", "10", "12"]);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
