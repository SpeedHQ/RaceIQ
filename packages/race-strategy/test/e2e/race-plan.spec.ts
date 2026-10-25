import { z } from "zod";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ActiveRacePlansResponseSchema, RacePlanGenerationEvidenceResponseSchema, RacePlanSchema, RacePlansResponseSchema, type RacePlanCombo } from "@raceiq/shared/racing/live/race-plan";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { getTireCompoundOptions } from "@raceiq/shared/racing/live/tire-thresholds";
import { ingestF1Laps } from "./f1-source";
import { ingestNativeRun, primeNativeRun, type NativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";

const headers = { "X-Game-Id": "f1-2025" };
const SessionSchema = z.object({ id: z.number().int(), carId: z.string(), createdAt: z.string() });

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

async function activePlan(api: APIRequestContext, combo: RacePlanCombo) {
  const response = await api.get("/api/race-plans/active");
  expect(response.ok(), await response.text()).toBe(true);
  return ActiveRacePlansResponseSchema.parse(await response.json()).plans.find((plan) =>
    plan.gameId === combo.gameId && plan.carId === combo.carId && plan.trackId === combo.trackId) ?? null;
}

test("G0 generator without evidence offers catalog choices and manual editor", async ({ browser }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-generator-no-evidence"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.route("**/api/cars", (route) => route.fulfill({ status: 503, json: { error: "Injected car catalogue failure" } }));
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const generator = page.getByTestId("race-strategy-generator");
    await expect(generator.getByLabel("Track")).toContainText("Select track");
    await expect(generator.getByLabel("Track").locator("option")).not.toHaveCount(1);
    await expect(generator.getByLabel("Car")).toContainText("Select car");
    await expect(generator.getByRole("alert")).toContainText("Could not load track and car catalogues.");
    await expect(generator.getByRole("alert")).toContainText("Retry");
    await page.unroute("**/api/cars");
    await generator.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(generator.getByLabel("Car").locator("option")).not.toHaveCount(1);
    await generator.getByLabel("Track").selectOption("5");
    await generator.getByLabel("Car").selectOption("639");
    await expect(generator.getByRole("status")).toContainText("No suitable recorded evidence.");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeDisabled();
    await expect(generator.getByRole("button", { name: "Manual / no history", exact: true })).toBeEnabled();
    await generator.getByRole("button", { name: "Manual / no history", exact: true }).click();
    await expect(page.getByTestId("race-strategy-generator")).not.toBeAttached();
    await expect(page.getByTestId("race-strategy-planner")).toBeVisible();
    await expect(page.getByLabel("Car")).toBeVisible();
    await expect(page.getByLabel("Track")).toBeVisible();
  } finally {
    await context.close();
    await runtime.stop();
  }
});
test("G1 Strategies page selects latest combo evidence and generates with localized recorded rates", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-latest-combo-generator"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const sourceRun = { carId: 639, trackId: 5, pi: 800, firstLap: 7, initialFuel: 0.9, laps: Array.from({ length: 6 }, () => ({ fuelUsed: 0.03, wear: [0.002, 0.002, 0.002, 0.002] as [number, number, number, number] })) };
    await ingestNativeRun(sourceRun, runtime.udpPort);
    const source = await sessionFor(api, "fm-2023");
    await page.goto(`${runtime.baseURL}/fm23/strategy?sessionId=${source.id}`);
    const generator = page.getByTestId("race-strategy-generator");
    await expect(generator.getByLabel("Track")).toHaveValue("5");
    await expect(generator.getByLabel("Car")).toHaveValue("639");
    await expect(generator.getByLabel("History session")).toHaveCount(0);
    await expect(generator.getByLabel("Evidence stint")).toHaveCount(0);
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeDisabled();
    await expect(generator).toContainText("No suitable recorded evidence.");
    // Same-car run closes source stint using the production session transition pattern.
    await ingestNativeRun({ ...sourceRun, firstLap: 7, initialFuel: 0.85, timestampMs: 500_000 }, runtime.udpPort);
    const readStints = async () => {
      const response = await api.get(`/api/sessions/${source.id}/stints`, { headers: { "X-Game-Id": "fm-2023" } });
      return response.ok() ? StintsResponseSchema.parse(await response.json()).stints : [];
    };
    await expect.poll(async () => (await readStints()).some((stint) =>
      stint.status !== "active" && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null))).toBe(true);
    let stints = await readStints();
    const evidence = stints.find((stint) =>
      stint.status !== "active" && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null))!;
    expect(evidence.compounds).toEqual([null, null, null, null]);
    await page.reload();
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeDisabled();
    await expect(generator).toContainText("No suitable recorded evidence.");
    // Runner-owned metadata supplies compounds only; production still parses native measured rates and identity.
    await runtime.stop();
    const rows = await runtime.databaseStatement("SELECT payload FROM strategy_stints WHERE id=? AND session_id=?", [evidence.id, source.id]) as { payload: string }[];
    const payload = JSON.parse(rows[0]!.payload) as { compounds: (string | null)[]; compatibility: { tireSemanticVersions: (string | null)[] } };
    const compound = getTireCompoundOptions("fm-2023")[0]!;
    await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=? AND session_id=?", [
      JSON.stringify({ ...payload, compounds: [compound, compound, compound, compound] }),
      evidence.id, source.id,
    ], true);
    await runtime.restart();
    stints = await readStints();
    const readyEvidence = stints.find((stint) => stint.id === evidence.id)!;
    expect(readyEvidence.compounds).toEqual([compound, compound, compound, compound]);
    expect(readyEvidence.fuel.value).toBeCloseTo(0.03, 4);
    expect(readyEvidence.fuel.eligibleLaps).toBe(5);
    readyEvidence.tires.forEach((tire) => expect(tire.value).toBeCloseTo(0.002, 4));
    expect(readyEvidence.tires.map((tire) => tire.eligibleLaps)).toEqual([5, 5, 5, 5]);
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByLabel("Track")).toHaveValue("5");
    await expect(generator.getByLabel("Car")).toHaveValue("639");
    await expect(generator.getByLabel("History session")).toHaveCount(0);
    await expect(generator.getByLabel("Evidence stint")).toHaveCount(0);
    await expect(generator).toContainText(`Eligible laps: ${readyEvidence.fuel.eligibleLaps}`);
    await expect(generator).toContainText("Fuel / lap");
    await expect(generator).toContainText(/FL.*%\/lap/);
    await expect(generator).not.toContainText("tankFraction/lap");
    await expect(generator).toContainText(compound);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await generator.screenshot({ path: testInfo.outputPath("latest-combo-generator-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await generator.screenshot({ path: testInfo.outputPath("latest-combo-generator-desktop.png") });
    await generator.getByLabel("Plan name").fill("Generated native strategy");
    await generator.getByLabel("Total laps").fill("12");
    await generator.getByLabel("Fuel tank capacity (%)").fill("100");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeEnabled();
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await expect(planner).toBeVisible();
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    await page.reload();
    await expect(page.getByTestId("saved-strategies-table")).toContainText("Generated native strategy");
    const saved = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.name === "Generated native strategy")!;
    expect(saved.carId).toBe("639");
    expect(saved.stints[0]?.evidence).toBeNull();
    expect(saved.stints[0]?.baseline?.sources.length).toBeGreaterThan(0);
    expect(saved.stints[0]?.baseline?.fuel.value).toBeCloseTo(readyEvidence.fuel.value!, 6);
    expect(saved.stints[0]?.compounds).toEqual(readyEvidence.compounds);
    expect(saved.stints[0]?.baseline?.tires.map((tire) => tire.value)).toEqual(readyEvidence.tires.map((tire) => tire.value));
    // A newer different combo must not silently borrow the previous car/track's evidence.
    await ingestNativeRun({ ...sourceRun, carId: 642, trackId: 6, timestampMs: 1_000_000, laps: [] }, runtime.udpPort);
    const latestSession = await sessionFor(api, "fm-2023");
    expect(latestSession.id).not.toBe(source.id);
    await page.reload();
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByLabel("Car")).toHaveValue("642");
    await expect(generator.getByLabel("Track")).toHaveValue("6");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeDisabled();
    await expect(generator).toContainText("No suitable recorded evidence.");
    await generator.getByLabel("Car").selectOption("639");
    await generator.getByLabel("Track").selectOption("5");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeEnabled();
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
test("A6 Forza without measured laps keeps fuel projection unavailable", async ({ browser }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-forza-no-fuel-forecast"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, laps: [] }, runtime.udpPort);
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const compact = page.getByTestId("pit-estimate-live");
    await expect(compact).toBeVisible();
    await expect(compact).toContainText("—");
    await expect(compact).toContainText("Projection unavailable");
    await expect(compact).not.toContainText("No limiter");
    await page.getByRole("button", { name: "Open strategy timeline", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Projection unavailable");
    await expect(dialog).not.toContainText("No limiter");
  } finally {
    await context.close();
    await runtime.stop();
  }
});


test("combo-pinned strategies migrate, remain independent, and restore through live identity switches", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-combo-pins"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const create = async (name: string, combo: RacePlanCombo) => {
    const response = await api.post("/api/race-plans", { data: {
      ...combo, name, pi: combo.gameId === "fm-2023" ? 800 : null, totalLaps: 20, fuelUnit: "tankFraction", notes: "",
      stints: [10, 20].map((endLap) => ({ endLap, startFuel: 0.5, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null })),
    } });
    expect(response.status(), await response.text()).toBe(201);
    return RacePlanSchema.parse(await response.json());
  };
  const pin = async (combo: RacePlanCombo, planId: string | null) => {
    const response = await api.put("/api/race-plans/active", { data: { gameId: combo.gameId, carId: combo.carId, trackId: combo.trackId, planId } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  try {
    const a = await create("Car 639 at track 5", { gameId: "fm-2023", carId: "639", trackId: "5" });
    const b = await create("Car 639 at track 6", { gameId: "fm-2023", carId: "639", trackId: "6" });
    const otherGame = await create("Same IDs in another game", { gameId: "f1-2025", carId: "639", trackId: "5" });
    await pin(a, a.id);
    await runtime.crash();
    await runtime.databaseStatement("DROP TABLE active_race_plans", [], true);
    await runtime.databaseStatement("CREATE TABLE active_race_plan(id INTEGER PRIMARY KEY CHECK(id=1),plan_id TEXT REFERENCES race_plans(id) ON DELETE SET NULL)", [], true);
    await runtime.databaseStatement("INSERT INTO active_race_plan(id,plan_id) VALUES(1,?)", [a.id], true);
    await runtime.databaseStatement("DELETE FROM schema_migrations WHERE name='pin race plans by combo'", [], true);
    await runtime.restart();
    expect((await activePlan(api, a))?.id).toBe(a.id);
    expect(await runtime.databaseStatement("SELECT name FROM sqlite_master WHERE type='table' AND name='active_race_plan'")).toEqual([]);
    await pin(b, b.id);
    await pin(otherGame, otherGame.id);
    const before = ActiveRacePlansResponseSchema.parse(await (await api.get("/api/race-plans/active")).json()).plans;
    expect(before.map((plan) => plan.id).sort()).toEqual([a.id, b.id, otherGame.id].sort());
    const mismatch = await api.put("/api/race-plans/active", { data: { gameId: b.gameId, carId: b.carId, trackId: b.trackId, planId: a.id } });
    expect(mismatch.status()).toBe(400);
    expect(ActiveRacePlansResponseSchema.parse(await (await api.get("/api/race-plans/active")).json()).plans).toEqual(before);
    await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, timestampMs: 1_000_000, laps: [] }, runtime.udpPort);
    await page.goto(`${runtime.baseURL}/live/pit`);
    const selected = page.getByTestId("race-strategy-live");
    await expect(selected).toContainText(a.name);
    await ingestNativeRun({ carId: 639, trackId: 6, pi: 800, timestampMs: 1_001_000, laps: [] }, runtime.udpPort);
    await expect(selected).toContainText(b.name);
    await ingestNativeRun({ carId: 642, trackId: 6, pi: 800, timestampMs: 1_002_000, laps: [] }, runtime.udpPort);
    await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
    await expect(page.getByTestId("pit-estimate-live")).toContainText("Projection unavailable");
    await expect(selected).not.toBeAttached();
    await expect(page.getByTestId("strategy-adherence")).not.toBeAttached();
    await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, timestampMs: 1_003_000, laps: [] }, runtime.udpPort);
    await expect(selected).toContainText(a.name);
    await runtime.restart();
    expect((await activePlan(api, a))?.id).toBe(a.id);
    expect((await activePlan(api, b))?.id).toBe(b.id);
    await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, timestampMs: 1_100_000, laps: [] }, runtime.udpPort);
    await page.reload();
    await expect(selected).toContainText(a.name);
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    const actionsA = page.getByRole("group", { name: a.name, exact: true });
    const actionsB = page.getByRole("group", { name: b.name, exact: true });
    await expect(actionsA.getByRole("button", { name: "Unload active plan", exact: true })).toBeVisible();
    await expect(actionsB.getByRole("button", { name: "Unload active plan", exact: true })).toBeVisible();
    await page.getByRole("button", { name: a.name, exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await planner.getByLabel("Track", { exact: true }).fill(b.trackId);
    await planner.getByRole("button", { name: "Unload active plan", exact: true }).click();
    await expect.poll(async () => await activePlan(api, a)).toBeNull();
    expect((await activePlan(api, b))?.id).toBe(b.id);
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await expect(actionsB.getByRole("button", { name: "Unload active plan", exact: true })).toBeVisible();
    expect((await activePlan(api, b))?.id).toBe(b.id);
    expect((await activePlan(api, otherGame))?.id).toBe(otherGame.id);
    await pin(a, a.id);
    expect((await api.delete(`/api/race-plans/${a.id}`)).ok()).toBe(true);
    expect(await activePlan(api, a)).toBeNull();
    expect((await activePlan(api, b))?.id).toBe(b.id);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("R1-R5 builds a history-backed plan, survives restart, and applies only to its live identity", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-race-plan"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${runtime.baseURL}/f125/driver`);
    await expect(page.getByRole("heading", { name: "Driver Profile", exact: true })).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "retained"; });
    await page.getByRole("button", { name: /^All .* laps$/ }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/f125/sessions");
    await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "retained");
    await ingestF1Laps(runtime.udpPort, 6, 460n, 0.8);
    const source = await sessionFor(api, "f1-2025");
    await ingestF1Laps(runtime.udpPort, 4, 461n, 1);
    await expect.poll(async () => {
      const response = await api.get(`/api/sessions/${source.id}/stints`, { headers });
      return response.ok() && StintsResponseSchema.parse(await response.json()).stints.some((stint) => (stint.status === "completed" || stint.status === "interrupted") && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null));
    }).toBe(true);

    await page.goto(`${runtime.baseURL}/f125/sessions/${source.id}/analyse`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("stint-summary-cards")).toBeVisible();
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
    await expect(planner.getByLabel("Starting fuel")).toHaveCount(0);
    await expect(planner.getByTestId("race-plan-required-fuel")).toHaveCount(0);
    await expect(planner.getByTestId("race-plan-refuel")).toHaveCount(0);
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
    await planner.getByLabel("Notes").fill("Edited after restart");
    await planner.getByRole("button", { name: "Save changes" }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    expect(saved.stints[1]?.sourceSessionId).toBeNull();
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await page.getByTestId("saved-strategies-table").getByRole("button", { name: "Load", exact: true }).click();
    await expect.poll(async () => (await activePlan(api, saved))?.id ?? null).toBe(saved.id);
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
    await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "retained"; });
    const sourceLink = live.getByRole("link");
    const sourceHref = await sourceLink.getAttribute("href");
    await sourceLink.click();
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).hash).toBe(sourceHref);
    await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "retained");
    await expect(page.locator(`[id="${decodeURIComponent(new URL(page.url()).hash.slice(1))}"]`)).toBeVisible();
    await page.goBack();
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Race strategy", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/f125/strategy");
    await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "retained");
    await page.goBack();
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await ingestNativeRun({ carId: 639, timestampMs: 900_000, laps: [] }, runtime.udpPort);
    // Switching games remounts the dashboard and closes its expanded strategy view.
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
    await expect(compact).not.toBeAttached();
    await page.getByRole("button", { name: "Open strategy timeline" }).click();
    await page.getByRole("dialog").locator("summary").filter({ hasText: "Race strategy" }).click();
    await expect(live).toContainText("No plan loaded.");

    await page.goto(strategyUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Native-history race plan", exact: true }).click();
    await planner.getByRole("button", { name: "Unload active plan" }).click();
    await expect.poll(async () => (await activePlan(api, saved))?.id ?? null).toBeNull();
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await page.getByTestId("saved-strategies-table").getByRole("button", { name: "Delete", exact: true }).click();
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
    const boundaryPlan = RacePlanSchema.parse(await boundaryResponse.json());
    expect((await api.put("/api/race-plans/active", { data: { gameId: boundaryPlan.gameId, carId: boundaryPlan.carId, trackId: boundaryPlan.trackId, planId: boundaryPlan.id } })).ok()).toBe(true);
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
    await expect.poll(async () => (await activePlan(api, boundaryPlan))?.id ?? null).toBeNull();
    await expect(page.getByTestId("pit-estimate-live")).toBeAttached({ timeout: 20_000 });
    await expect(compact).not.toBeAttached();
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("F1.1-F1.4 ignores fuel for pit windows and adapts to actual early/late tire service without rewriting the plan", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(300_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-adherence"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  type Wheels = [number, number, number, number];
  let completed = 0, nextFrame = 0, fuel = 100;
  let wear: Wheels = [10, 10, 10, 10];
  const advance = async (laps: number, options: { fuel?: number; wear?: Wheels; fuelRate?: number; wearRates?: Wheels; trackLengthM?: number; pitLaneTimerActive?: boolean } = {}) => {
    fuel = options.fuel ?? fuel;
    wear = options.wear ?? wear;
    const fuelRate = options.fuelRate ?? 2.4;
    const wearRates: Wheels = options.wearRates ?? [0.8, 0.8, 0.8, 0.8];
    await ingestF1Laps(runtime.udpPort, laps, 2802n, 0.8, null, completed + 1, {
      initialFuelL: fuel, initialWearPctByWheel: wear, fuelPerLap: fuelRate, wearPerLapPctByWheel: wearRates,
      sessionTimeOffsetS: completed * 60, frameIdStart: nextFrame, trackLengthM: options.trackLengthM, pitLaneTimerActive: options.pitLaneTimerActive,
    });
    completed += laps;
    nextFrame += laps * 120 + 1;
    fuel -= laps * fuelRate;
    wear = wear.map((value, wheel) => value + laps * wearRates[wheel]!) as Wheels;
  };
  try {
    await ingestF1Laps(runtime.udpPort, 6, 2801n, 0.8);
    const source = await sessionFor(api, "f1-2025");
    await advance(6);
    let sourceStint: z.infer<typeof StintsResponseSchema>["stints"][number] | undefined;
    await expect.poll(async () => {
      const response = await api.get(`/api/sessions/${source.id}/stints`, { headers });
      expect(response.ok(), await response.text()).toBe(true);
      sourceStint = StintsResponseSchema.parse(await response.json()).stints.find((stint) => stint.status !== "active" &&
        stint.fuel.value != null && stint.fuel.eligibleLaps >= 2 && stint.tires.every((tire) => tire.value != null && tire.eligibleLaps >= 2));
      return sourceStint?.id;
    }).toBeTruthy();
    const reference = sourceStint!;
    const threshold = { cliffPct: 69, deadPct: 20 };
    const configured = await api.put("/api/settings", { data: { tireThresholdOverrides: { "f1-2025": Object.fromEntries(reference.compounds.map((compound) => [compound!, threshold])) } } });
    expect(configured.ok(), await configured.text()).toBe(true);
    const cliffWear = 1 - threshold.cliffPct / 100;
    const totalLaps = 40;
    const created = await api.post("/api/race-plans", { data: {
      name: "Actual service adapts live windows", gameId: "f1-2025", carId: reference.carId, trackId: reference.trackId, pi: reference.pi,
      totalLaps, fuelUnit: reference.fuelUnit, notes: "This saved baseline must remain unchanged.",
      generation: { fuelCapacity: 1, fuelReserve: 0.02, energyReserveFraction: 0 },
      stints: [20, totalLaps].map((endLap, index) => ({ endLap, startFuel: 1 - (index === 0 ? 0 : 20) * reference.fuel.value!, compounds: reference.compounds,
        sourceSessionId: source.id, sourceStintId: reference.id })),
    } });
    expect(created.status(), await created.text()).toBe(201);
    const saved = RacePlanSchema.parse(await created.json());
    const pinned = await api.put("/api/race-plans/active", { data: {
      gameId: saved.gameId, carId: saved.carId, trackId: saved.trackId, planId: saved.id,
    } });
    expect(pinned.ok(), await pinned.text()).toBe(true);
    const unchanged = async () => {
      const response = await api.get("/api/race-plans?gameId=f1-2025");
      expect(response.ok(), await response.text()).toBe(true);
      expect(RacePlansResponseSchema.parse(await response.json()).plans.find((plan) => plan.id === saved.id)).toEqual(saved);
    };
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const graph = page.getByTestId("strategy-adherence");
    const window = graph.getByTestId("strategy-adherence-window");
    const flPlot = graph.getByRole("figure", { name: /^Tire wear FL:/ });
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    await expect(window).toHaveAttribute("data-window-state", "open");
    await expect(flPlot).toContainText("14.8%");
    await expect(graph.getByRole("img", { name: /Fuel remaining/ })).not.toBeAttached();
    const initialLatest = Math.floor((cliffWear - 0.1) / reference.tires[0].value! + 1e-9);
    await expect(window).toHaveAttribute("data-latest-lap", String(initialLatest));
    await expect(window).toContainText(`by lap ${initialLatest}`);
    await graph.screenshot({ path: testInfo.outputPath("adherence-within-desktop.png") });

    await advance(0, { trackLengthM: 0 });
    await expect(graph).toHaveAttribute("data-adherence-state", "unknown");
    await expect(window).toContainText("Lap progress unavailable");
    await advance(0);
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    const priorFuel = fuel;
    await advance(0, { fuel: Number.NaN });
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    await expect(window).toHaveAttribute("data-latest-lap", String(initialLatest));
    await expect(flPlot).toHaveAccessibleName("Tire wear FL: Within strategy");
    await advance(0, { fuel: priorFuel });
    await expect(graph).toHaveAttribute("data-adherence-state", "within");

    await advance(0, { pitLaneTimerActive: true });
    await expect(flPlot).toContainText("14.8%");
    await unchanged();
    await advance(0, { pitLaneTimerActive: false });

    // Pit exit excludes the outlap; three eligible laps establish authoritative live rates.
    await advance(4, { fuelRate: 4.8 });
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    await expect(window).toHaveAttribute("data-latest-lap", String(initialLatest));
    await unchanged();
    await advance(3, { wearRates: [1.6, 0.8, 0.8, 0.8] });
    await expect(graph).toHaveAttribute("data-adherence-state", "over");
    await expect(flPlot).toHaveAccessibleName("Tire wear FL: Over strategy budget");
    await expect(graph.getByRole("figure", { name: "Tire wear FR: Within strategy", exact: true })).toBeVisible();
    await expect(window).toHaveAttribute("data-window-state", /^(open|upcoming)$/);
    await expect.poll(async () => Number(await window.getAttribute("data-latest-lap"))).toBeLessThan(initialLatest);
    await unchanged();


    // F1 service replaces tires before saved lap 20; fuel is never added.
    await advance(4, { wear: [0, 0, 0, 0] });
    await expect(flPlot).toContainText("3.2%");
    await expect(window).toHaveAttribute("data-window-state", "finish");
    await unchanged();
    await advance(8);
    // The next actual service is now later than saved lap 20.
    await advance(4, { wear: [0, 0, 0, 0] });
    await expect(window).toHaveAttribute("data-window-state", "finish");
    await expect(window).toContainText("Tires can last to the finish");
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    await unchanged();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await graph.screenshot({ path: testInfo.outputPath("adherence-after-late-service-mobile.png") });

    // A real request failure must not keep the previous green evidence state.
    const live = await sessionFor(api, "f1-2025");
    const historyRoute = `**/api/sessions/${live.id}/pit-estimates**`;
    await page.route(historyRoute, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected history request failure" }) }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(graph.getByRole("alert")).toContainText("Checkpoint history unavailable", { timeout: 30_000 });
    await expect(graph).toHaveAttribute("data-adherence-state", "unknown");
    await unchanged();
    await page.unroute(historyRoute);
    await ingestNativeRun({ carId: 639, timestampMs: 2_900_000, laps: [] }, runtime.udpPort);
    await expect(page.getByTestId("pit-estimate-live")).toBeVisible();
    await expect(graph).not.toBeAttached();
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("T1-T5 saves a timed race, derives fuel at selected stops, and retains invalid draft edits", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-timed-race"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const headers = { "X-Game-Id": "fm-2023" };
    const run: NativeRun = { carId: 639, trackId: 5, pi: 800, timestampMs: 1_700_000,
      laps: Array.from({ length: 6 }, (): NativeRun["laps"][number] => ({ fuelUsed: 0.02, wear: [0.008, 0.008, 0.008, 0.008] })) };
    await primeNativeRun(run, runtime.udpPort, runtime.apiURL);
    await ingestNativeRun(run, runtime.udpPort);
    const source = await sessionFor(api, "fm-2023");
    await ingestNativeRun({ carId: 642, timestampMs: 2_100_000, laps: [] }, runtime.udpPort);
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
    await page.goto(`${runtime.baseURL}/fm23/strategy`, { waitUntil: "domcontentloaded" });
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
    const saved = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.name === "Timed fuel strategy")!;
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
    expect(RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.id === saved.id)).toEqual(saved);
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
    await ingestNativeRun({ carId: 639, pi: 800, timestampMs: 2_200_000, laps: [] }, runtime.udpPort);
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
    // independently of the native Forza adapter's tank-fraction normalization.
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
    await rows.nth(0).getByLabel("FL Tires", { exact: true }).selectOption("hard", { timeout: 15_000 });
    await expect(softLife.nth(0)).toHaveText("hard · Unavailable");
    await expect(planner.getByRole("button", { name: "Save plan", exact: true })).toBeDisabled();
    await rows.nth(0).getByLabel("FL Tires", { exact: true }).selectOption("soft", { timeout: 15_000 });
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status").filter({ hasText: "Plan saved" })).toBeVisible();
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await page.getByRole("group", { name: "Compound-aware strategy", exact: true }).getByRole("button", { name: "Load", exact: true }).click();
    await expect.poll(async () => (await activePlan(api, evidence))?.name).toBe("Compound-aware strategy");
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
    await expect(compact.getByTestId("race-strategy-next-stint")).toContainText("hard");
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
    await expect(compact.getByTestId("strategy-adherence-window")).toHaveAttribute("data-window-state", "unknown");
    await expect(tireRows.nth(0)).toContainText("hard");
    await expect(tireRows.nth(0)).toContainText("120.0");
    await expect(compact).not.toContainText("finish instead of pit");
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
    const plan = RacePlanSchema.parse(await response.json());
    expect((await api.put("/api/race-plans/active", { data: { gameId: plan.gameId, carId: plan.carId, trackId: plan.trackId, planId: plan.id } })).ok()).toBe(true);
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
    const forzaPlan = RacePlanSchema.parse(await forza.json());
    expect((await api.put("/api/race-plans/active", { data: { gameId: forzaPlan.gameId, carId: forzaPlan.carId, trackId: forzaPlan.trackId, planId: forzaPlan.id } })).ok()).toBe(true);
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
    const nativeRun = (fuelUsed: number, wear: number, timestampMs: number, lapCount = 6) => ({
      carId: 639, trackId: 5, pi: 800, firstLap: 7, timestampMs, initialFuel: 0.9,
      laps: Array.from({ length: lapCount }, () => ({ fuelUsed, wear: [wear, wear, wear, wear] as [number, number, number, number] })),
    });
    const bridge = async (timestampMs: number) => {
      const run: NativeRun = { carId: 642, trackId: 6, pi: 800, firstLap: 7, timestampMs, initialFuel: 0.9, laps: [] };
      await primeNativeRun(run, runtime.udpPort, runtime.apiURL);
      await ingestNativeRun(run, runtime.udpPort);
    };
    await ingestNativeRun(nativeRun(0.03, 0.002, 0), runtime.udpPort);
    const source = await sessionFor(api, "fm-2023");
    await bridge(400_000);
    await ingestNativeRun(nativeRun(0.06, 0.016, 500_000, 3), runtime.udpPort);
    const secondSource = await sessionFor(api, "fm-2023");
    await bridge(750_000);
    await ingestNativeRun(nativeRun(0.04, 0.008, 1_000_000, 4), runtime.udpPort);
    const wetSource = await sessionFor(api, "fm-2023");
    await bridge(1_300_000);
    expect(secondSource.id).not.toBe(source.id);
    expect(wetSource.id).not.toBe(secondSource.id);
    const readStints = async (sessionId: number) => StintsResponseSchema.parse(await (await api.get(`/api/sessions/${sessionId}/stints`, { headers: { "X-Game-Id": "fm-2023" } })).json()).stints;
    for (const sourceSession of [source, secondSource, wetSource]) {
      await expect.poll(async () => (await readStints(sourceSession.id)).some((stint) => stint.status !== "active" && stint.fuel.value != null && stint.fuel.value > 0 && stint.tires.every((tire) => tire.value != null))).toBe(true);
    }
    const evidence = (await readStints(source.id)).find((stint) => stint.status !== "active" && stint.fuel.value != null && stint.fuel.value > 0 && stint.tires.every((tire) => tire.value != null))!;
    const secondEvidence = (await readStints(secondSource.id)).find((stint) => stint.status !== "active" && stint.fuel.value != null && stint.fuel.value > 0 && stint.tires.every((tire) => tire.value != null))!;
    const wetEvidence = (await readStints(wetSource.id)).find((stint) => stint.status !== "active" && stint.fuel.value != null && stint.fuel.value > 0 && stint.tires.every((tire) => tire.value != null))!;
    await runtime.stop();
    const compound = getTireCompoundOptions("fm-2023")[0]!;
    for (const [sessionId, stint, weather] of [[source.id, evidence, "dry"], [secondSource.id, secondEvidence, "dry"], [wetSource.id, wetEvidence, "wet"]] as const) {
      const rows = await runtime.databaseStatement("SELECT payload FROM strategy_stints WHERE id=? AND session_id=?", [stint.id, sessionId]) as { payload: string }[];
      const payload = JSON.parse(rows[0]!.payload) as { compounds: (string | null)[]; compatibility: { conditions: { weather: string | null } } };
      payload.compounds = [compound, compound, compound, compound];
      payload.compatibility.conditions.weather = weather;
      await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=? AND session_id=?", [JSON.stringify(payload), stint.id, sessionId], true);
    }
    const baselineFor = async (weather: "any" | "dry" | "wet") => RacePlanGenerationEvidenceResponseSchema.parse(await (await api.get(`/api/race-plans/generation-evidence?gameId=fm-2023&carId=${evidence.carId}&trackId=${evidence.trackId}&weather=${weather}`)).json()).baseline;
    await runtime.restart();
    const dryBaseline = (await baselineFor("dry"))!;
    expect(dryBaseline.sources.map((item) => item.sessionId)).toEqual(expect.arrayContaining([source.id, secondSource.id]));
    expect(dryBaseline.sources.map((item) => item.sessionId)).not.toContain(wetSource.id);
    expect((await baselineFor("wet"))?.sources.map((item) => item.sessionId)).toEqual([wetSource.id]);
    expect((await baselineFor("any"))?.sources.map((item) => item.sessionId)).toEqual([wetSource.id]);
    const baseline = dryBaseline;
    expect(baseline.fuel.eligibleLaps).toBe(evidence.fuel.eligibleLaps + secondEvidence.fuel.eligibleLaps);
    expect(baseline.fuel.value).toBeCloseTo((evidence.fuel.value! * evidence.fuel.eligibleLaps + secondEvidence.fuel.value! * secondEvidence.fuel.eligibleLaps) / baseline.fuel.eligibleLaps, 8);
    expect(baseline.fuel.value).not.toBeCloseTo(evidence.fuel.value!, 8);
    const reserve = 0.01;
    const capacity = 1;
    const insufficientFuel = reserve + baseline.fuel.value! * 0.5;
    const maxWear = Math.max(...baseline.tires.map((tire) => tire.value!));
    const initialThresholds = Object.fromEntries([...new Set(baseline.compounds)].map((compound) => [compound!, { cliffPct: 100 - maxWear * 525, deadPct: 1 }]));
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "fm-2023": initialThresholds } } })).ok()).toBe(true);
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const generator = page.getByTestId("race-strategy-generator");
    await generator.getByLabel("Track").selectOption(evidence.trackId);
    await generator.getByLabel("Car").selectOption(evidence.carId);
    await expect(generator.getByLabel("Track")).toHaveValue(evidence.trackId);
    await expect(generator.getByLabel("Car")).toHaveValue(evidence.carId);
    await expect(generator.getByLabel("Evidence stint")).toHaveCount(0);
    await expect(generator.getByLabel("History session")).toHaveCount(0);
    await generator.getByLabel("Weather").selectOption("dry");
    await expect(generator).toContainText(`Session ${source.id}`);
    await expect(generator).toContainText(`Session ${secondSource.id}`);
    await expect(generator).not.toContainText(`Session ${wetSource.id}`);
    await generator.getByLabel("Plan name").fill("Generated measured strategy");
    await generator.getByLabel("Total laps").fill("12");
    await generator.getByLabel("Fuel tank capacity (%)").fill(String(insufficientFuel * 100));
    await generator.getByLabel("Fuel reserve at each stop (%)").fill(String(reserve * 100));
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByRole("alert")).toContainText("Check race length");
    await generator.getByLabel("Fuel reserve at each stop (%)").fill(String(reserve * 100));
    await generator.getByLabel("Fuel tank capacity (%)").fill(String(capacity * 100));
    await generator.getByLabel("Total laps").fill("10000");
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByRole("alert")).toContainText("no more than 100 stints");
    await generator.getByLabel("Total laps").fill("12");
    await generator.getByLabel("Fuel tank capacity (%)").fill(String(insufficientFuel * 100));
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(generator.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("race-strategy-planner")).not.toBeAttached();
    await generator.getByLabel("Fuel tank capacity (%)").fill(String(capacity * 100));
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const planner = page.getByTestId("race-strategy-planner");
    await expect.poll(() => planner.getByLabel("Pit / finish lap").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["5", "10", "12"]);
    await expect(planner.getByTestId("race-plan-refuel")).toHaveCount(2);
    await planner.screenshot({ path: testInfo.outputPath("generated-strategy-preview.png") });
    await page.route("**/api/race-plans", async (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 503, json: { error: "Injected plan-save failure" } })
      : route.continue());
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("alert")).toContainText("Could not save plan");
    await expect(planner.getByRole("alert")).toContainText("Retry");
    await expect.poll(() => planner.getByLabel("Pit / finish lap").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["5", "10", "12"]);
    await page.unroute("**/api/race-plans");
    await planner.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    const saved = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans[0]!;
    expect(saved.stints.map((stint) => stint.endLap)).toEqual([5, 10, 12]);
    expect(saved.weather).toBe("dry");
    for (let index = 0; index < saved.stints.length; index++) {
      const stint = saved.stints[index]!;
      const previousEnd = saved.stints[index - 1]?.endLap ?? 0;
      expect(stint.startFuel!).toBeCloseTo(Math.min(capacity, (stint.endLap - previousEnd) * baseline.fuel.value! + reserve), 8);
      expect(stint.startFuel! - (stint.endLap - previousEnd) * baseline.fuel.value!).toBeCloseTo(reserve, 8);
      expect(stint.evidence).toBeNull();
      expect(stint.baseline?.sources.map((item) => item.sessionId)).toEqual(expect.arrayContaining([source.id, secondSource.id]));
      expect(stint.baseline?.fuel.value).toBeCloseTo(baseline.fuel.value!, 8);
      expect(stint.baseline?.tires.map((tire) => tire.value)).toEqual(baseline.tires.map((tire) => tire.value));
    }
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    const table = page.getByTestId("saved-strategies-table");
    await expect(table).toContainText(saved.name);
    await page.reload();
    await expect(table).toContainText(saved.name);
    await table.getByRole("button", { name: "Load", exact: true }).click();
    await expect.poll(async () => (await activePlan(api, saved))?.id).toBe(saved.id);
    await table.getByRole("button", { name: saved.name, exact: true }).click();
    await planner.getByLabel("Notes").fill("Reviewed generated proposal");
    await planner.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await table.getByRole("group", { name: saved.name }).getByRole("button", { name: "Clone", exact: true }).click();
    await expect(planner.getByLabel("History session")).toHaveCount(0);
    await expect(planner.getByLabel("Evidence stint")).toHaveCount(0);
    await expect(planner).toContainText(`Session ${source.id}`);
    await planner.getByLabel("Plan name").fill("Cloned aggregate strategy");
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    const clonePlan = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.name === "Cloned aggregate strategy")!;
    await bridge(1_800_000);
    await ingestNativeRun(nativeRun(0.064, 0.028, 2_000_000), runtime.udpPort);
    const freshSource = await sessionFor(api, "fm-2023");
    await bridge(2_500_000);
    await expect.poll(async () => (await readStints(freshSource.id)).some((stint) => stint.status !== "active" && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null))).toBe(true);
    const freshEvidence = (await readStints(freshSource.id)).find((stint) => stint.status !== "active" && stint.fuel.value != null && stint.tires.every((tire) => tire.value != null))!;
    await runtime.stop();
    const freshPayloadRows = await runtime.databaseStatement("SELECT payload FROM strategy_stints WHERE id=? AND session_id=?", [freshEvidence.id, freshSource.id]) as { payload: string }[];
    const freshPayload = JSON.parse(freshPayloadRows[0]!.payload) as { compounds: (string | null)[]; compatibility: { conditions: { weather: string | null } } };
    freshPayload.compounds = [compound, compound, compound, compound];
    freshPayload.compatibility.conditions.weather = "dry";
    await runtime.databaseStatement("UPDATE strategy_stints SET payload=? WHERE id=? AND session_id=?", [JSON.stringify(freshPayload), freshEvidence.id, freshSource.id], true);
    await runtime.restart();
    await page.reload();
    const idsBeforeRecalculation = new Set(RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.map((plan) => plan.id));
    await table.getByRole("group", { name: saved.name }).getByRole("button", { name: "Clone & recalculate", exact: true }).click();
    const recalculator = page.getByTestId("race-strategy-recalculator");
    await recalculator.getByRole("button", { name: "Clone & recalculate", exact: true }).click();
    await expect(planner).toBeVisible();
    await expect(planner).toContainText(`Session ${freshSource.id}`);
    const recalculatedBeforeSave = RacePlanGenerationEvidenceResponseSchema.parse(await (await api.get(`/api/race-plans/generation-evidence?gameId=fm-2023&carId=${evidence.carId}&trackId=${evidence.trackId}&weather=dry`)).json()).baseline!;
    expect(recalculatedBeforeSave.sources.map((item) => item.sessionId)).toContain(freshSource.id);
    expect(recalculatedBeforeSave.fuel.value!).toBeGreaterThan(baseline.fuel.value!);
    expect(Math.max(...recalculatedBeforeSave.tires.map((tire) => tire.value!))).toBeGreaterThan(Math.max(...baseline.tires.map((tire) => tire.value!)));
    await planner.getByLabel("Plan name").fill("Recalculated aggregate strategy");
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    const recalculatedCopy = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => !idsBeforeRecalculation.has(plan.id))!;
    expect(recalculatedCopy.name).toBe("Recalculated aggregate strategy");
    expect(recalculatedCopy.weather).toBe("dry");
    expect(recalculatedCopy.stints.map((stint) => stint.endLap)).not.toEqual(saved.stints.map((stint) => stint.endLap));
    expect(recalculatedCopy.stints.every((stint) => stint.baseline?.sources.some((item) => item.sessionId === freshSource.id))).toBe(true);
    const savedAfterRecalculation = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.id === saved.id)!;
    expect(savedAfterRecalculation.stints[0]!.baseline!.fuel.value).toBe(baseline.fuel.value);
    await bridge(3_000_000);
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("strategies-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("strategies-mobile.png") });
    await runtime.stop();
    await runtime.databaseStatement("DELETE FROM sessions WHERE id=?", [source.id], true);
    await runtime.restart();
    await page.reload();
    await expect(table).toContainText(saved.name);
    const persisted = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.id === saved.id)!;
    expect(persisted.stints.every((stint) => stint.baseline?.sources.some((item) => item.sessionId === source.id))).toBe(true);
    const cloned = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.id === clonePlan.id)!;
    expect(cloned.stints.every((stint) => stint.baseline?.sources.some((item) => item.sessionId === source.id))).toBe(true);
    await table.getByRole("group", { name: cloned.name }).getByRole("button", { name: "Delete", exact: true }).click();
    await table.getByRole("group", { name: saved.name }).getByRole("button", { name: "Delete", exact: true }).click();
    await table.getByRole("group", { name: recalculatedCopy.name }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(table.getByRole("group")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New plan", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate race strategy", exact: true })).toBeVisible();
    expect(await activePlan(api, saved)).toBeNull();
    const timedBaseline = RacePlanGenerationEvidenceResponseSchema.parse(await (await api.get(`/api/race-plans/generation-evidence?gameId=fm-2023&carId=${evidence.carId}&trackId=${evidence.trackId}&weather=dry`)).json()).baseline!;
    const timedMaxWear = Math.max(...timedBaseline.tires.map((tire) => tire.value!));
    expect(timedMaxWear).toBeGreaterThan(0);
    const compoundThresholds = Object.fromEntries([...new Set(timedBaseline.compounds)].map((compound) => [compound!, { cliffPct: 100 - timedMaxWear * 250, deadPct: 1 }]));
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "fm-2023": compoundThresholds } } })).ok()).toBe(true);
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await generator.getByLabel("Track").selectOption(evidence.trackId);
    await generator.getByLabel("Car").selectOption(evidence.carId);
    await generator.getByLabel("Weather").selectOption("dry");
    await generator.getByLabel("Plan name").fill("Timed tire-limited proposal");
    await expect(generator.getByLabel("Evidence stint")).toHaveCount(0);
    await generator.getByLabel("Race length", { exact: true }).selectOption("time");
    await generator.getByLabel("Race time (minutes)").fill(String(timedBaseline.averageLapSeconds! * 11.5 / 60));
    await generator.getByLabel("Fuel tank capacity (%)").fill("100");
    await generator.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await expect(planner.getByLabel("Race length", { exact: true })).toHaveValue("time");
    const timedEnds = await planner.getByLabel("Pit / finish lap").evaluateAll((inputs) => inputs.map((input) => Number((input as HTMLInputElement).value)));
    expect(timedEnds).toEqual([2, 4, 6, 8, 10, 12]);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
