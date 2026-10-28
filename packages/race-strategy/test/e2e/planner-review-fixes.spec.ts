import { expect, test } from "@playwright/test";
import { StrategyRuntime } from "./runtime";



test("R7 save locks draft edits and navigation until real API request settles", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-planner-review"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  try {
    const created = await api.post("/api/race-plans", { data: {
      name: "Locked plan", gameId: "fm-2023", carId: "642", trackId: "5", pi: 800,
      totalLaps: 20, fuelUnit: "tankFraction", notes: "",
      stints: [{ endLap: 20, startFuel: 0.8, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null }],
    } });
    expect(created.status()).toBe(201);
    await page.goto(`${runtime.baseURL}/fm23/strategy`, { waitUntil: "domcontentloaded" });
    const planner = page.getByTestId("race-strategy-planner");
    await page.getByRole("button", { name: "Locked plan", exact: true }).click();
    await expect(planner).toBeVisible();
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

    await expect(page.getByRole("button", { name: "Strategies", exact: true })).toBeDisabled();
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
    await expect(page.getByRole("button", { name: "Strategies", exact: true })).toBeEnabled();
    await expect(planner.getByLabel("Plan name")).toBeEnabled();
    await expect(planner.getByLabel("History session")).toBeEnabled();
    await expect(planner.getByLabel("Car")).toBeEnabled();
    await expect(planner.getByLabel("Track")).toBeEnabled();
    await expect(planner.getByLabel("PI", { exact: true })).toBeEnabled();
    await expect(planner.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await expect(planner.getByRole("button", { name: "Add pit stop" })).toBeEnabled();
  } finally {
    gate.resolve();
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});

test("Add pit stop splits eligible stints and disables after every stint reaches one lap", async ({ browser, playwright }, testInfo) => {
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-planner-stop-splitting"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const created = await api.post("/api/race-plans", { data: {
      name: "Split boundaries", gameId: "fm-2023", carId: "642", trackId: "5", pi: 800,
      totalLaps: 4, fuelUnit: "tankFraction", notes: "",
      stints: [3, 4].map((endLap) => ({ endLap, startFuel: null, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null })),
    } });
    expect(created.status()).toBe(201);
    await page.goto(`${runtime.baseURL}/fm23/strategy`, { waitUntil: "domcontentloaded" });
    const planner = page.getByTestId("race-strategy-planner");
    await page.getByRole("button", { name: "Split boundaries", exact: true }).click();
    const addStop = planner.getByRole("button", { name: "Add pit stop" });
    await addStop.click();
    await addStop.click();
    await expect(addStop).toBeDisabled();
    const boundaries = async () => {
      const stints = planner.getByRole("group", { name: /Stint/ });
      const values: number[] = [];
      for (const stint of await stints.all()) values.push(Number(await stint.getByLabel("Pit / finish lap").inputValue()));
      return values;
    };
    expect(await boundaries()).toEqual([1, 2, 3, 4]);
    await planner.getByRole("button", { name: "Save changes" }).click();
    await expect(planner.getByRole("status")).toContainText("Plan saved");
    const saved = (await api.get("/api/race-plans?gameId=fm-2023").then((response) => response.json())).plans.find((plan: { name: string }) => plan.name === "Split boundaries");
    expect(saved.stints.map((stint: { endLap: number }) => stint.endLap)).toEqual([1, 2, 3, 4]);
  } finally {
    await runtime.stop();
    await context.close();
    await api.dispose();
  }
});
