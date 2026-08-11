import { test, expect } from "@playwright/test";
import { collectBrowserErrors } from "../support/browser-errors";
import { completeOnboarding, resetTunes } from "../support/tunes";

// ACC's setup JSON is arbitrary (server does not validate its internal shape),
// so the form's JSON paste + duplicate flow can be exercised end-to-end
// without a real setup file.
test.describe("ACC tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });
  test.afterEach(async ({ page }) => {
    await resetTunes(page);
  });

  test("create via form, see covered sections, duplicate, delete", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    // /acc/setups is now the community-setups browser (no "+ New tune" button
    // there). Navigate directly to the user-tune create form and verify the
    // create → duplicate → delete cycle via the API, which is what the UI
    // ultimately calls anyway.
    await page.goto("/acc/setups/new");
    await expect(page.getByRole("heading", { name: /create new acc tune/i })).toBeVisible();

    await page.getByLabel("Name").fill("E2E ACC Tune");
    await page.getByLabel("Description").fill("Playwright-created");

    // Switch from the default structured form to the raw JSON paste mode.
    await page.getByRole("radio", { name: "Paste JSON" }).click();

    // Populate every ACC tunable section so the "covered" counter hits 8/8.
    const setupJson = {
      basicSetup: {
        tyres: { tyreCompound: 0, tyrePressure: [26, 26, 26, 26] },
        alignment: { camber: [1, 1, 1, 1], toe: [0, 0, 0, 0], casterLF: 30, casterRF: 30, steerRatio: 6 },
        electronics: { tC1: 5, tC2: 5, abs: 3, ecuMap: 2, fuelMix: 1, telemetryLaps: 3 },
        strategy: { fuel: 30, tyreSet: 1, frontBrakePadCompound: 1, rearBrakePadCompound: 1, pitStrategy: [] },
      },
      advancedSetup: {
        mechanicalBalance: { aRBFront: 4, aRBRear: 4, brakeTorque: 80, brakeBias: 55, steerRatio: 6, wheelRate: [0, 0, 0, 0] },
        dampers: { bumpSlow: [5, 5, 5, 5], bumpFast: [5, 5, 5, 5], reboundSlow: [5, 5, 5, 5], reboundFast: [5, 5, 5, 5] },
        aeroBalance: { rideHeight: [55, 55], splitter: 1, rearWing: 6, brakeDuct: [3, 3] },
        drivetrain: { preload: 6 },
      },
    };
    await page.getByLabel("Setup JSON").fill(JSON.stringify(setupJson, null, 2));
    await expect(page.getByText(/8 \/ 8 covered/)).toBeVisible();

    await page.getByRole("button", { name: /save tune/i }).click();

    // Poll the API for the newly-created tune (the browse page no longer lists
    // user tunes for ACC — verifying via UI here would be a lie).
    await expect(async () => {
      const list = await page.request.get("/api/tunes?gameId=acc");
      const tunes = (await list.json()) as { id: number; name: string }[];
      expect(tunes.map((t) => t.name)).toContain("E2E ACC Tune");
    }).toPass({ timeout: 10_000 });

    const listRes = await page.request.get("/api/tunes?gameId=acc");
    const created = ((await listRes.json()) as { id: number; name: string }[]).find((t) => t.name === "E2E ACC Tune");
    expect(created).toBeDefined();

    // Duplicate + delete via the same endpoints the UI would hit.
    const dupRes = await page.request.post(`/api/tunes/${created!.id}/duplicate`);
    expect(dupRes.ok()).toBeTruthy();
    const copy = (await dupRes.json()) as { id: number; name: string };
    expect(copy.name).toBe("E2E ACC Tune (copy)");

    const delRes = await page.request.delete(`/api/tunes/${copy.id}`);
    expect(delRes.ok()).toBeTruthy();

    const finalList = await page.request.get("/api/tunes?gameId=acc");
    const remaining = (await finalList.json()) as { name: string }[];
    expect(remaining.map((t) => t.name)).not.toContain("E2E ACC Tune (copy)");
    expect(browserErrors.errors, "unexpected browser errors in ACC tune form").toEqual([]);
  });

  test("import page renders empty state when Documents folder absent", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto("/acc/setups/import");
    // Test DB has no mocked Documents folder — we expect the "not found" UI.
    await expect(page.getByText(/could not find your acc setups folder/i)).toBeVisible({
      timeout: 10_000,
    });
    expect(browserErrors.errors, "unexpected browser errors in ACC import page").toEqual([]);
  });
});
