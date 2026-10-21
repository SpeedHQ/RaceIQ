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

    const analysisUrl = `${runtime.baseURL}/f125/sessions/${source.id}/analyse`;
    await page.goto(analysisUrl, { waitUntil: "domcontentloaded" });
    const planner = page.getByTestId("race-strategy-planner");
    await expect(planner).toBeVisible();
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
    await expect(planner.getByRole("button", { name: "Native-history race plan" })).toBeVisible();
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
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    const live = page.getByTestId("live-race-strategy");
    await expect(live).toContainText("Native-history race plan");
    await expect(live).toContainText("Planned stint");
    await expect(live).toContainText("Next planned pit: lap 101");
    await ingestNativeRun({ carId: 639, timestampMs: 900_000, laps: [] }, runtime.udpPort);
    // Switching games remounts the dashboard and closes its expanded strategy view.
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await expect(live).toContainText("Not applicable");

    await page.goto(analysisUrl, { waitUntil: "domcontentloaded" });
    await planner.getByRole("button", { name: "Native-history race plan" }).click();
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
    await ingestNativeRun({ carId: 639, firstLap: 11, timestampMs: 901_000, laps: [] }, runtime.udpPort);
    await expect(live).toContainText("Final stint; finish instead of pit.");
    await ingestNativeRun({ carId: 639, firstLap: 21, timestampMs: 902_000, laps: [] }, runtime.udpPort);
    await expect(live).toContainText("Race plan complete. No further pit stop.");
    await ingestNativeRun({ carId: 639, firstLap: 5, timestampMs: 903_000, laps: [] }, runtime.udpPort);
    await expect(live).toContainText("Next planned pit: lap 10");
    expect((await api.delete(`/api/race-plans/${boundaryPlan.id}`)).ok()).toBe(true);
    await expect.poll(async () => (await activePlan(api))?.id ?? null).toBeNull();
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
    await page.goto(`${runtime.baseURL}/f125/sessions/${source.id}/analyse`, { waitUntil: "domcontentloaded" });
    const planner = page.getByTestId("race-strategy-planner");
    await expect(planner).toBeVisible();
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
    await planner.getByRole("button", { name: "Timed fuel strategy", exact: false }).click();
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
    await planner.getByRole("button", { name: "Timed fuel strategy", exact: false }).click();
    await expect(planner.getByLabel("Race time (minutes)")).toHaveValue("30");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await planner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await planner.getByLabel("Race length", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(planner.getByLabel("Race time (minutes)")).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveJSProperty("scrollTop", 0);
    await page.screenshot({ path: testInfo.outputPath("timed-strategy-mobile.png") });
    const { raceLength: _length, ...legacyInput } = input;
    const legacyResponse = await api.post("/api/race-plans", { data: { ...legacyInput, name: "Legacy lap strategy" } });
    expect(legacyResponse.status()).toBe(201);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await planner.getByRole("button", { name: "Legacy lap strategy", exact: false }).click();
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
      await page.goto(`${runtime.baseURL}/acc/sessions/${source.id}/analyse`, { waitUntil: "domcontentloaded" });
      await expect(planner).toBeVisible();
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
