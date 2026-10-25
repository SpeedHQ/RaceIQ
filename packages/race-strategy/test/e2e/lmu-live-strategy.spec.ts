import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { RacePlanGenerationEvidenceResponseSchema, RacePlanSchema, RacePlansResponseSchema } from "@raceiq/shared/racing/live/race-plan";
import { generateRacePlanStints } from "@raceiq/race-strategy/contracts";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";

import { StrategyRuntime } from "./runtime";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary = resolve(root, "dist", `lmu-live-e2e-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
const headers = { "X-Game-Id": "lmu" };

test.beforeAll(async () => {
  await promisify(execFile)("bun", ["build", "--compile", "--root", ".", "--external", "@duckdb/node-bindings-*",
    "--define", 'process.env.NODE_ENV="production"', "--define", 'process.env.RACEIQ_FEATURE_F1_EXPERIMENTS="true"',
    "--define", 'process.env.RACEIQ_FEATURE_IRACING_ADAPTER="true"',
    "packages/race-strategy/test/e2e/lmu-live-entry.ts", "server/experiments/lap-issues-worker.ts",
    "apps/backend/src/runtime/startup-worker-entry.ts", "packages/capture-splitting/src/worker.ts", "--outfile", binary], { cwd: root });
});
test.afterAll(async () => { await rm(binary, { force: true }); });

test("LMU-L1-L4 native live energy independently limits windows and actual service never restores unrelated resources", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(300_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-native-lmu-live"), binary);
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL, extraHTTPHeaders: headers });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const readStints = async (id: number) => {
    const response = await api.get(`/api/sessions/${id}/stints`);
    expect(response.ok(), await response.text()).toBe(true);
    return StintsResponseSchema.parse(await response.json()).stints;
  };
  try {
    await runtime.nativeInput({ laps: 6, rainIntensity: 0 });
    await runtime.nativeInput({ sessionEvent: 2, laps: 6, rainIntensity: 0 });
    const listed = await api.get("/api/sessions?gameId=lmu");
    expect(listed.ok(), await listed.text()).toBe(true);
    const sessions = z.array(z.object({ id: z.number().int() })).parse(await listed.json()).sort((a, b) => a.id - b.id);
    expect(sessions).toHaveLength(2);
    const source = sessions[0]!;
    const live = sessions[1]!;
    await expect.poll(async () => (await readStints(source.id))[0]?.virtualEnergy?.eligibleLaps).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => (await readStints(live.id))[0]?.tires[0].eligibleLaps).toBeGreaterThanOrEqual(3);
    const reference = (await readStints(source.id))[0]!;
    expect(reference.fuelUnit).toBe("L");
    expect(reference.virtualEnergy!.value).toBeGreaterThan(0);
    const created = await api.post("/api/race-plans", { data: {
      name: "Native LMU live energy", gameId: "lmu", carId: reference.carId, trackId: reference.trackId, pi: reference.pi,
      totalLaps: 20, fuelUnit: "L", notes: "Native live adaptation must not rewrite this baseline.",
      generation: { fuelCapacity: 100, fuelReserve: 2, energyReserveFraction: 0.07 },
      stints: [12, 20].map((endLap) => ({ endLap, startFuel: 100, compounds: reference.compounds, sourceSessionId: source.id, sourceStintId: reference.id })),
    } });
    expect(created.status(), await created.text()).toBe(201);
    const saved = RacePlanSchema.parse(await created.json());
    const pinned = await api.put("/api/race-plans/active", { data: { gameId: saved.gameId, carId: saved.carId, trackId: saved.trackId, planId: saved.id } });
    expect(pinned.ok(), await pinned.text()).toBe(true);
    const unchanged = async () => {
      const response = await api.get("/api/race-plans?gameId=lmu");
      expect(response.ok(), await response.text()).toBe(true);
      expect(RacePlansResponseSchema.parse(await response.json()).plans.find((plan) => plan.id === saved.id)).toEqual(saved);
    };
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const graph = page.getByTestId("strategy-adherence");
    const window = graph.getByTestId("strategy-adherence-window");
    const tire = graph.getByRole("figure", { name: /^Tire wear FL:/ });
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    await expect(window).toHaveAttribute("data-window-state", /^(upcoming|open)$/);
    const initialLatest = Number(await window.getAttribute("data-latest-lap"));
    expect(initialLatest).toBeGreaterThan(7);
    expect(initialLatest).toBeLessThan(14);
    await expect(tire).toContainText("14.8%");
    await expect(graph.getByRole("img", { name: /Fuel remaining/ })).toBeVisible();
    await graph.screenshot({ path: testInfo.outputPath("lmu-live-within-desktop.png") });

    await runtime.nativeInput({ laps: 0, energy: null });
    await expect(window).toHaveAttribute("data-window-state", "unknown");
    await expect(graph).toHaveAttribute("data-adherence-state", "unknown");
    await expect(window).toContainText(/virtual.energy/i);
    await expect(tire).toContainText("14.8%");
    await runtime.nativeInput({ laps: 0, energy: 0.52 });
    await expect(window).toHaveAttribute("data-latest-lap", String(initialLatest));
    await expect(graph).toHaveAttribute("data-adherence-state", "within");

    await runtime.nativeInput({ laps: 0, advanceSeconds: 10, scoringLagSeconds: 10 });
    await expect(graph).toHaveAttribute("data-adherence-state", "unknown");
    await expect(window).toHaveAttribute("data-window-state", "unknown");
    await expect(tire).toContainText("14.8%");
    await runtime.nativeInput({ laps: 0 });
    await expect(window).toHaveAttribute("data-latest-lap", String(initialLatest));
    await expect(graph).toHaveAttribute("data-adherence-state", "within");

    await runtime.nativeInput({ laps: 0, energy: 0.25 });
    await expect(window).toHaveAttribute("data-window-state", /^(upcoming|open)$/);
    await expect.poll(async () => Number(await window.getAttribute("data-latest-lap"))).toBeLessThan(initialLatest);
    const depletedLatest = await window.getAttribute("data-latest-lap");
    await runtime.nativeInput({ laps: 0, fuel: 100 });
    await expect(tire).toContainText("14.8%");
    await expect(graph.getByTestId("adherence-plot-fuel").locator("figcaption")).toContainText("100.0 L");
    await expect(window).toHaveAttribute("data-window-state", /^(upcoming|open)$/);
    await expect(window).toHaveAttribute("data-latest-lap", depletedLatest!);
    await unchanged();
    await runtime.nativeInput({ laps: 4, energy: 0.9 });
    await expect.poll(async () => (await readStints(live.id)).find((stint) => stint.status === "active")?.tires.every((rate) => rate.eligibleLaps >= 3)).toBe(true);
    // Lap persistence updates live rates asynchronously; the next actual source
    // frame publishes the committed rates, as continuous gameplay does.
    await runtime.nativeInput({ laps: 0 });
    await expect(graph).toHaveAttribute("data-adherence-state", "within");
    await expect.poll(async () => Number(await window.getAttribute("data-latest-lap"))).toBeGreaterThan(initialLatest);
    await expect(tire).toContainText("18.0%");
    await unchanged();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const invalidGeometry = await graph.locator("svg").evaluateAll((elements) => elements.flatMap((svg) => [...svg.querySelectorAll("*")].flatMap((element) => [...element.attributes].filter((attribute) => /NaN|Infinity|undefined/.test(attribute.value)).map((attribute) => attribute.name))));
    expect(invalidGeometry).toEqual([]);
    await graph.screenshot({ path: testInfo.outputPath("lmu-live-service-mobile.png") });
    await runtime.nativeInput({ laps: 3, rainIntensity: 0.4 });
    await runtime.nativeInput({ sessionEvent: 3, laps: 0 });
    await expect(graph).toHaveAttribute("data-adherence-state", "unknown");
    await unchanged();
    const transitioned = await readStints(live.id);
    expect(transitioned.map((stint) => stint.compatibility.conditions.weather)).toEqual(expect.arrayContaining(["dry", "wet"]));
    const query = `/api/race-plans/generation-evidence?gameId=lmu&carId=${encodeURIComponent(reference.carId)}&trackId=${encodeURIComponent(reference.trackId)}`;
    const dry = RacePlanGenerationEvidenceResponseSchema.parse(await (await api.get(`${query}&weather=dry`)).json()).baseline;
    const wet = RacePlanGenerationEvidenceResponseSchema.parse(await (await api.get(`${query}&weather=wet`)).json()).baseline;
    expect(dry?.sources.every((stint) => stint.compatibility.conditions.weather === "dry")).toBe(true);
    expect(wet?.sources.every((stint) => stint.compatibility.conditions.weather === "wet")).toBe(true);
    expect(dry?.sources.some((stint) => stint.sessionId === live.id)).toBe(true);
    expect(wet?.sources.some((stint) => stint.sessionId === live.id)).toBe(true);
    const totalLaps = 20;
    const generation = { fuelCapacity: 100, fuelReserve: 2, energyReserveFraction: 0.07 };
    const tireThresholds: Record<string, { cliffPct: number; deadPct: number }> = Object.fromEntries([...new Set(dry.compounds)].filter((compound): compound is string => compound != null)
      .map((compound) => [compound, { cliffPct: 70, deadPct: 50 }]));
    expect((await api.put("/api/settings", { data: { tireThresholdOverrides: { lmu: tireThresholds } } })).ok()).toBe(true);
    const aggregateStints = generateRacePlanStints(dry, totalLaps, generation.fuelCapacity, generation.fuelReserve,
      (compound) => tireThresholds[compound]!, generation.energyReserveFraction);
    if (!aggregateStints) throw new Error("Expected generated aggregate LMU stints");
    const aggregateResponse = await api.post("/api/race-plans", { data: {
      name: "Aggregate LMU live forecast", gameId: "lmu", carId: reference.carId, trackId: reference.trackId, pi: reference.pi,
      totalLaps, fuelUnit: "L", weather: "dry", notes: "Aggregate evidence must drive live forecast.",
      generation, stints: aggregateStints,
    } });
    expect(aggregateResponse.status(), await aggregateResponse.text()).toBe(201);
    const aggregatePlan = RacePlanSchema.parse(await aggregateResponse.json());
    expect(aggregatePlan.stints.every((stint) => stint.evidence === null && stint.baseline?.sources.length === dry.sources.length &&
      stint.sourceStints?.length === dry.sources.length)).toBe(true);
    const active = await api.put("/api/race-plans/active", { data: {
      gameId: aggregatePlan.gameId, carId: aggregatePlan.carId, trackId: aggregatePlan.trackId, planId: aggregatePlan.id,
    } });
    expect(active.ok(), await active.text()).toBe(true);
    await runtime.nativeInput({ sessionEvent: 4, laps: 1, rainIntensity: 0 });
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.goto(`${runtime.baseURL}/live/pit`, { waitUntil: "domcontentloaded" });
    const liveSummary = page.getByTestId("race-strategy-summary");
    await expect(liveSummary).toBeVisible();
    const currentStintLaps = aggregatePlan.stints[0]!.endLap;
    await expect(liveSummary).toContainText((dry.fuel.value! * currentStintLaps).toFixed(1));
    await expect(liveSummary.getByTestId("race-strategy-tire-life").first()).toContainText(((1 - 70 / 100) / dry.tires[0]!.value!).toFixed(1));
    await page.getByRole("button", { name: "Open strategy timeline", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("summary").filter({ hasText: "Race strategy" }).click();
    const liveStrategy = dialog.getByTestId("live-race-strategy");
    await expect(liveStrategy).toContainText(aggregatePlan.name);
    for (const source of dry.sources) await expect(liveStrategy).toContainText(`Session ${source.sessionId}`);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});
