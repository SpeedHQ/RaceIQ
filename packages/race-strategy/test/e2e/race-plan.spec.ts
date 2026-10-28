import { z } from "zod";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ActiveRacePlansResponseSchema, RacePlanGenerationEvidenceResponseSchema, RacePlanSchema, RacePlansResponseSchema, type RacePlanCombo } from "@raceiq/shared/racing/live/race-plan";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { getTireCompoundOptions } from "@raceiq/shared/racing/live/tire-thresholds";
import { ingestF1Laps } from "./f1-source";
import { ingestNativeRun, primeNativeRun, type NativeRun } from "./native-source";
import { StrategyRuntime } from "./runtime";

async function selectFirstSearchOption(page: Page, generator: Locator, label: "Track" | "Car") {
  const input = generator.getByLabel(label);
  await input.click();
  const optionText = (await page.getByRole("option").first().innerText()).trim();
  await input.fill(optionText);
  const matchingOption = page.getByRole("option", { name: optionText, exact: true });
  await expect(matchingOption).toBeVisible();
  await matchingOption.click();
}
async function selectSearchOption(page: Page, generator: Locator, label: "Track" | "Car", visibleLabel: string) {
  const input = generator.getByLabel(label);
  await input.click();
  await input.fill(visibleLabel);
  const matchingOption = page.getByRole("option", { name: visibleLabel, exact: true });
  await expect(matchingOption).toBeVisible();
  await matchingOption.click();
}

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

test("G0 generator without evidence keeps generation unavailable without offering manual planning", async ({ browser }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-generator-no-evidence"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.route("**/api/cars", (route) => route.fulfill({ status: 503, json: { error: "Injected car catalogue failure" } }));
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    const generator = page.getByTestId("race-strategy-generator");
    await expect(generator.getByLabel("Track")).toBeVisible();
    await expect(generator.getByLabel("Track")).toHaveAttribute("role", "combobox");
    await expect(generator.getByLabel("Car")).toBeVisible();
    await expect(generator.getByRole("alert")).toContainText("Could not load track and car catalogues.");
    await expect(generator.getByRole("alert")).toContainText("Retry");
    await page.unroute("**/api/cars");
    await generator.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(generator.getByLabel("Car")).toBeVisible();
    await selectFirstSearchOption(page, generator, "Track");
    await selectFirstSearchOption(page, generator, "Car");
    await expect(generator.getByRole("status")).toContainText("No suitable recorded evidence.");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New plan", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Clone(?: & recalculate)?$/ })).toHaveCount(0);
    await expect(generator.getByRole("button", { name: /manual|no history/i })).toHaveCount(0);
    await expect(page.getByTestId("race-strategy-planner")).not.toBeAttached();
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
    const selectedTrack = generator.getByLabel("Track");
    const selectedCar = generator.getByLabel("Car");
    await expect(selectedTrack).not.toHaveValue("");
    await expect(selectedCar).not.toHaveValue("");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeVisible();
    const sourceTrackValue = await selectedTrack.inputValue();
    const sourceCarValue = await selectedCar.inputValue();
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
    await expect(selectedTrack).not.toHaveValue("");
    await expect(selectedCar).not.toHaveValue("");
    await expect(generator.getByLabel("History session")).toHaveCount(0);
    await expect(generator.getByLabel("Evidence stint")).toHaveCount(0);
    await expect(generator.getByTestId("generation-evidence")).toContainText(`Completed laps: ${readyEvidence.completedLaps}`);
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
    await expect(planner.getByRole("button", { name: "New plan", exact: true })).toHaveCount(0);
    await planner.getByRole("button", { name: "Save plan", exact: true }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    await page.reload();
    await expect(page.getByTestId("saved-strategies-table")).toContainText("Generated native strategy");
    const saved = RacePlansResponseSchema.parse(await (await api.get("/api/race-plans?gameId=fm-2023")).json()).plans.find((plan) => plan.name === "Generated native strategy")!;
    expect(saved.carId).toBe("639");
    expect(saved.trackId).toBe("5");
    expect(saved.stints[0]?.evidence).toBeNull();
    expect(saved.gameId).toBe("fm-2023");
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
    await expect(selectedCar).not.toHaveValue(sourceCarValue);
    await expect(selectedTrack).not.toHaveValue(sourceTrackValue);
    await expect(selectedCar).not.toHaveValue("");
    await expect(selectedTrack).not.toHaveValue("");
    await expect(generator.getByRole("button", { name: "Generate race strategy", exact: true })).toBeDisabled();
    await expect(generator).toContainText("No suitable recorded evidence.");
    await selectSearchOption(page, generator, "Car", sourceCarValue);
    await selectSearchOption(page, generator, "Track", sourceTrackValue);
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


test("F1 keeps its built-in strategy instead of showing RaceIQ planning and estimates", async ({ browser }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-f1-built-in-strategy"));
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 2, 2801n);
    await page.goto(`${runtime.baseURL}/live/pit`);
    await expect(page.locator("[data-live-dashboard-layout]")).toBeVisible();
    await expect(page.getByTestId("pit-estimate-live")).not.toBeAttached();
    await expect(page.getByTestId("race-strategy-live")).not.toBeAttached();
    await expect(page.getByTestId("strategy-adherence")).not.toBeAttached();
  } finally {
    await context.close();
    await runtime.stop();
  }
});


test("S2 active-plan request failure preserves automatic estimates and Retry restores selection", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(360_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-selection-error"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestNativeRun({ carId: 639, trackId: 5, pi: 800, laps: [] }, runtime.udpPort);
    const source = await sessionFor(api, "fm-2023");
    const response = await api.post("/api/race-plans", { data: {
      name: "Manual selected strategy", gameId: "fm-2023", carId: source.carId, trackId: "5",
      pi: 800, totalLaps: 20, fuelUnit: "tankFraction", notes: "",
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
    const [tracksResponse, carsResponse] = await Promise.all([
      api.get("/api/tracks?gameId=fm-2023"),
      api.get("/api/cars", { headers: { "X-Game-Id": "fm-2023" } }),
    ]);
    const tracks = await tracksResponse.json() as { id: string; name: string; variant?: string }[];
    const cars = await carsResponse.json() as { id: string; name: string }[];
    const sourceTrack = tracks.find((track) => track.id === evidence.trackId)!;
    const sourceCar = cars.find((car) => car.id === evidence.carId)!;
    const trackLabel = sourceTrack.variant ? `${sourceTrack.name} · ${sourceTrack.variant}` : sourceTrack.name;
    const carLabel = sourceCar.name;
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
    await selectSearchOption(page, generator, "Track", trackLabel);
    await selectSearchOption(page, generator, "Car", carLabel);
    await expect(generator.getByLabel("Track")).toHaveValue(trackLabel);
    await expect(generator.getByLabel("Car")).toHaveValue(carLabel);
    await expect(generator.getByLabel("Evidence stint")).toHaveCount(0);
    await expect(generator.getByLabel("History session")).toHaveCount(0);
    await generator.getByLabel("Weather").selectOption("dry");
    await expect(generator).toContainText(`Session ${source.id}`);
    await expect(generator).toContainText(`Session ${secondSource.id}`);
    await expect(generator).not.toContainText(`Session ${wetSource.id}`);
    await expect(generator.getByTestId("generation-evidence")).toContainText(`Completed laps: ${baseline.sources.reduce((total, item) => total + item.completedLaps, 0)}`);
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
    await bridge(3_000_000);
    await page.getByRole("button", { name: "Strategies", exact: true }).click();
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await selectSearchOption(page, generator, "Track", trackLabel);
    await selectSearchOption(page, generator, "Car", carLabel);
    await generator.getByLabel("Weather").selectOption("dry");
    const beforeDelete = (await baselineFor("dry"))!;
    await expect(generator.getByTestId("generation-evidence")).toContainText(`Completed laps: ${beforeDelete.sources.reduce((total, item) => total + item.completedLaps, 0)}`);
    const deletedSource = await api.post("/api/sessions/bulk-delete", { data: { ids: [source.id] } });
    expect(deletedSource.ok(), await deletedSource.text()).toBe(true);
    await expect(generator.getByTestId("generation-evidence")).toContainText(`Completed laps: ${beforeDelete.sources.filter((item) => item.sessionId !== source.id).reduce((total, item) => total + item.completedLaps, 0)}`);
    await expect(generator.getByTestId("generation-evidence")).not.toContainText(`Session ${source.id}`);
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
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
    await table.getByRole("group", { name: saved.name }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(table.getByRole("group")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Generate race strategy", exact: true })).toBeVisible();
    expect(await activePlan(api, saved)).toBeNull();
    const timedBaseline = RacePlanGenerationEvidenceResponseSchema.parse(await (await api.get(`/api/race-plans/generation-evidence?gameId=fm-2023&carId=${evidence.carId}&trackId=${evidence.trackId}&weather=dry`)).json()).baseline!;
    const timedMaxWear = Math.max(...timedBaseline.tires.map((tire) => tire.value!));
    expect(timedMaxWear).toBeGreaterThan(0);
    const compoundThresholds = Object.fromEntries([...new Set(timedBaseline.compounds)].map((compound) => [compound!, { cliffPct: 100 - timedMaxWear * 250, deadPct: 1 }]));
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { "fm-2023": compoundThresholds } } })).ok()).toBe(true);
    await page.goto(`${runtime.baseURL}/fm23/strategy`);
    await page.getByRole("button", { name: "Generate race strategy", exact: true }).click();
    await selectSearchOption(page, generator, "Track", trackLabel);
    await selectSearchOption(page, generator, "Car", carLabel);
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
