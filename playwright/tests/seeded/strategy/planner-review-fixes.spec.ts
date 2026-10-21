import { expect, test, type APIRequestContext } from "@playwright/test";
import { RacePlansResponseSchema } from "@raceiq/shared/racing/live/race-plan";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { z } from "zod";
import { ingestF1Laps } from "./f1-source";
import { ingestNativeRun, type NativeLap } from "./native-source";
import { StrategyRuntime } from "./runtime";

const fmHeaders = { "X-Game-Id": "fm-2023" };
const SessionSchema = z.object({ id: z.number().int(), carId: z.string() });

async function f1Session(api: APIRequestContext) {
  let session: z.infer<typeof SessionSchema> | undefined;
  await expect.poll(async () => {
    const response = await api.get("/api/sessions?gameId=f1-2025");
    expect(response.ok(), await response.text()).toBe(true);
    session = z.array(SessionSchema).parse(await response.json()).sort((a, b) => b.id - a.id)[0];
    return session?.id;
  }).toBeTruthy();
  return session!;
}
async function fmSession(api: APIRequestContext) {
  let session: z.infer<typeof SessionSchema> | undefined;
  await expect.poll(async () => {
    const response = await api.get("/api/sessions?gameId=fm-2023");
    expect(response.ok(), await response.text()).toBe(true);
    session = z.array(SessionSchema).parse(await response.json()).filter((row) => row.carId === "642").sort((a, b) => b.id - a.id)[0];
    return session?.id;
  }).toBeTruthy();
  return session!;
}

async function fmSessions(api: APIRequestContext) {
  let sessions: z.infer<typeof SessionSchema>[] = [];
  await expect.poll(async () => {
    const response = await api.get("/api/sessions?gameId=fm-2023");
    expect(response.ok(), await response.text()).toBe(true);
    sessions = z.array(SessionSchema).parse(await response.json()).filter((session) => session.carId === "642").sort((a, b) => a.id - b.id);
    return sessions.length;
  }).toBeGreaterThanOrEqual(3);
  return sessions.slice(-3);
}

async function sourceStint(api: APIRequestContext, sessionId: number) {
  let selected: z.infer<typeof StintsResponseSchema>["stints"][number] | undefined;
  await expect.poll(async () => {
    const response = await api.get(`/api/sessions/${sessionId}/stints`, { headers: fmHeaders });
    expect(response.ok(), await response.text()).toBe(true);
    selected = StintsResponseSchema.parse(await response.json()).stints.find((stint) =>
      (stint.status === "completed" || stint.status === "interrupted") && stint.fuel.value != null,
    );
    return selected?.id;
  }).toBeTruthy();
  return selected!;
}

function manualForzaPlan(name: string) {
  return {
    name, gameId: "fm-2023", carId: "642", trackId: "5", pi: 800,
    totalLaps: 20, fuelUnit: "tankFraction", notes: "",
    stints: [{ endLap: 20, startFuel: 0.8, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null }],
  };
}

test("R6 retry submits edited current draft after a failed save", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-planner-review"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await ingestF1Laps(runtime.udpPort, 3, 710n);
    const source = await f1Session(api);
    const planner = page.getByTestId("race-strategy-planner");
    await page.goto(`${runtime.baseURL}/f125/sessions/${source.id}/analyse`, { waitUntil: "domcontentloaded" });
    await expect(planner).toBeVisible();
    await planner.getByLabel("Plan name").fill("Before failure");
    await planner.getByLabel("Total laps").fill("20");
    await planner.getByLabel("Fuel unit").selectOption("tankFraction");
    await planner.getByRole("button", { name: "Add pit stop" }).click();
    const stints = planner.getByRole("group", { name: /Stint/ });
    await stints.nth(0).getByLabel("Pit / finish lap").fill("10");
    await stints.nth(0).locator('input[type="number"]').nth(1).fill("65");

    let failNextPost = true;
    await page.route("**/api/race-plans", async (route) => {
      if (route.request().method() === "POST" && failNextPost) {
        failNextPost = false;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected save failure" }) });
      } else await route.continue();
    });
    await planner.getByRole("button", { name: "Save plan" }).click();
    await expect(planner.getByRole("alert")).toBeVisible();
    await planner.getByLabel("Plan name").fill("Edited retry draft");
    await stints.nth(0).getByLabel("Pit / finish lap").fill("8");
    await stints.nth(0).locator('input[type="number"]').nth(1).fill("72");
    await page.unroute("**/api/race-plans");
    await planner.getByRole("button", { name: "Retry" }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");

    const response = await api.get("/api/race-plans?gameId=f1-2025");
    expect(response.ok(), await response.text()).toBe(true);
    const saved = RacePlansResponseSchema.parse(await response.json()).plans[0]!;
    expect(saved).toMatchObject({ name: "Edited retry draft", stints: [{ endLap: 8, startFuel: 0.72 }, { endLap: 20 }] });
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("R7 save locks draft edits and navigation until real API request settles", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-planner-review"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  try {
    const lap: NativeLap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] };
    await ingestNativeRun({ carId: 642, pi: 800, laps: [lap, lap, lap] }, runtime.udpPort);
    const source = await fmSession(api);
    const created = await api.post("/api/race-plans", { data: manualForzaPlan("Locked plan") });
    expect(created.status()).toBe(201);
    await page.goto(`${runtime.baseURL}/fm23/sessions/${source.id}/analyse`, { waitUntil: "domcontentloaded" });
    const planner = page.getByTestId("race-strategy-planner");
    await expect(planner).toBeVisible();
    await planner.getByRole("button", { name: /Locked plan/ }).click();
    await planner.getByRole("button", { name: "Add pit stop" }).click();
    const stints = planner.getByRole("group", { name: /Stint/ });
    await planner.getByLabel("Notes").fill("Update in progress");
    await page.route("**/api/race-plans/**", async (route) => {
      if (route.request().method() === "PUT") {
        held.resolve();
        await gate.promise;
      }
      await route.continue();
    });
    await planner.getByRole("button", { name: "Save changes" }).click();
    await held.promise;

    await expect(planner.getByRole("button", { name: "New plan" })).toBeDisabled();
    await expect(planner.getByRole("button", { name: /Locked plan/ })).toBeDisabled();
    await expect(planner.getByRole("button", { name: "Load", exact: true })).toBeDisabled();
    await expect(planner.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await expect(planner.getByLabel("History session")).toBeDisabled();
    await expect(planner.getByLabel("Plan name")).toBeDisabled();
    await expect(planner.getByLabel("Total laps")).toBeDisabled();
    await expect(planner.locator("select").nth(1)).toBeDisabled();
    await expect(planner.getByLabel("Car")).toBeDisabled();
    await expect(planner.getByLabel("Track")).toBeDisabled();
    await expect(planner.getByLabel("Notes")).toBeDisabled();
    await expect(planner.getByLabel("PI", { exact: true })).toBeDisabled();
    await expect(planner.getByRole("button", { name: "Add pit stop" })).toBeDisabled();
    await expect(stints.nth(0).getByLabel("Pit / finish lap")).toBeDisabled();
    for (const select of await stints.nth(0).locator("select").all()) await expect(select).toBeDisabled();
    await expect(stints.nth(0).locator('input[type="number"]').nth(1)).toBeDisabled();
    await expect(stints.nth(0).getByRole("button", { name: "Remove stint" })).toBeDisabled();
    await expect(planner.getByRole("button", { name: "Unload active plan" })).toBeDisabled();
    gate.resolve();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    await expect(planner.getByRole("button", { name: "New plan" })).toBeEnabled();
    await expect(planner.getByLabel("Plan name")).toBeEnabled();
    await expect(planner.getByLabel("History session")).toBeEnabled();
    await expect(planner.getByLabel("Car")).toBeEnabled();
    await expect(planner.getByLabel("Track")).toBeEnabled();
    await expect(planner.getByLabel("PI", { exact: true })).toBeEnabled();
    await expect(planner.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await expect(planner.getByRole("button", { name: "Add pit stop" })).toBeEnabled();
    await expect(planner.getByRole("button", { name: /Locked plan/ })).toBeEnabled();
  } finally {
    gate.resolve();
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("R8 compatible Forza session switches retain PI and reject conflicting source PI", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-planner-review"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const lap: NativeLap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] };
  try {
    await ingestNativeRun({ carId: 642, pi: 800, laps: [lap, lap, lap] }, runtime.udpPort);
    await ingestNativeRun({ carId: 643, pi: 700, laps: [] }, runtime.udpPort);
    await ingestNativeRun({ carId: 642, pi: 800, timestampMs: 300_000, laps: [lap, lap, lap] }, runtime.udpPort);
    await ingestNativeRun({ carId: 643, pi: 700, timestampMs: 600_000, laps: [] }, runtime.udpPort);
    await ingestNativeRun({ carId: 642, pi: 801, timestampMs: 900_000, laps: [lap, lap, lap] }, runtime.udpPort);
    await ingestNativeRun({ carId: 643, pi: 700, timestampMs: 1_200_000, laps: [] }, runtime.udpPort);
    const [first, second, conflicting] = await fmSessions(api);
    const firstStint = await sourceStint(api, first!.id);
    const secondStint = await sourceStint(api, second!.id);
    const conflictingStint = await sourceStint(api, conflicting!.id);
    expect(firstStint.pi).toBe(800);
    expect(secondStint.pi).toBe(800);
    expect(conflictingStint.pi).toBe(801);

    const planner = page.getByTestId("race-strategy-planner");
    await page.goto(`${runtime.baseURL}/fm23/sessions/${first!.id}/analyse`, { waitUntil: "domcontentloaded" });
    await expect(planner).toBeVisible();
    await planner.getByLabel("Plan name").fill("Compatible Forza history");
    await planner.getByLabel("Total laps").fill("20");
    await planner.getByRole("button", { name: "Add pit stop" }).click();
    const stints = planner.getByRole("group", { name: /Stint/ });
    const firstSource = `${first!.id}:${firstStint.id}`;
    const secondSource = `${second!.id}:${secondStint.id}`;
    await expect.poll(() => stints.nth(0).locator("select").first().locator("option").evaluateAll(
      (options, value) => options.some((option) => (option as HTMLOptionElement).value === value), firstSource,
    )).toBe(true);
    await stints.nth(0).locator("select").first().selectOption(firstSource);
    await planner.getByLabel("History session").selectOption(String(second!.id));
    await expect.poll(() => stints.nth(1).locator("select").first().locator("option").evaluateAll(
      (options, value) => options.some((option) => (option as HTMLOptionElement).value === value), secondSource,
    )).toBe(true);
    await stints.nth(1).locator("select").first().selectOption(secondSource);
    await stints.nth(1).locator("select").first().selectOption("");
    await planner.getByLabel("PI", { exact: true }).fill("");
    await stints.nth(1).locator("select").first().selectOption(secondSource);
    await expect(planner.getByLabel("PI", { exact: true })).toHaveValue("800");
    await stints.nth(0).locator('input[type="number"]').nth(1).fill("80");
    await stints.nth(1).locator('input[type="number"]').nth(1).fill("80");
    const conflictingSource = `${conflicting!.id}:${conflictingStint.id}`;
    const conflictingStintsLoaded = page.waitForResponse((response) =>
      response.url().includes(`/api/sessions/${conflicting!.id}/stints`) && response.ok(),
    );
    await planner.getByLabel("History session").selectOption(String(conflicting!.id));
    await conflictingStintsLoaded;
    await expect.poll(() => stints.nth(1).locator("select").first().locator("option").evaluateAll(
      (options, value) => options.some((option) => (option as HTMLOptionElement).value === value), conflictingSource,
    )).toBe(false);
    await expect(planner.getByLabel("PI", { exact: true })).toHaveValue("800");
    await planner.getByLabel("History session").selectOption(String(first!.id));

    await expect(planner.getByLabel("PI", { exact: true })).toHaveValue("800");
    await expect(planner).toContainText("Expected fuel used");
    await expect(planner.getByRole("button", { name: "Save plan" })).toBeEnabled();
    await planner.getByRole("button", { name: "Save plan" }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");

    const response = await api.get("/api/race-plans?gameId=fm-2023");
    expect(response.ok(), await response.text()).toBe(true);
    const saved = RacePlansResponseSchema.parse(await response.json()).plans[0]!;
    expect(saved).toMatchObject({ pi: 800, stints: [{ sourceSessionId: first!.id }, { sourceSessionId: second!.id }] });
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});
