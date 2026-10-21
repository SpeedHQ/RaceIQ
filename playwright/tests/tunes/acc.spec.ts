import { test, expect } from "@playwright/test";
import { collectBrowserErrors } from "../support/browser-errors";
import { completeOnboarding, resetTunes } from "../support/tunes";

// ACC structured editor preserves its nested setup JSON through catalog CRUD.
test.describe("ACC tunes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);
    await resetTunes(page);
  });
  test.afterEach(async ({ page }) => {
    await resetTunes(page);
  });

  test("create setup with tyre values, duplicate, delete", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    // /acc/setups is now the community-setups browser (no "+ New tune" button
    // there). Navigate directly to the user-tune create form and verify the
    // create → duplicate → delete cycle via the API, which is what the UI
    // ultimately calls anyway.
    await page.goto("/acc/setups/new");
    await expect(page.getByRole("heading", { name: /create new acc tune/i })).toBeVisible();

    await page.getByLabel("Name").fill("E2E ACC Tune");
    await page.getByLabel("Description").fill("Playwright-created");

    await page.getByRole("spinbutton", { name: "Pressure (clicks) FL", exact: true }).fill("49");
    await page.getByRole("spinbutton", { name: "Pressure (clicks) FR", exact: true }).fill("45");
    await page.getByRole("button", { name: /save setup/i }).click();

    // Poll the API for the newly-created tune (the browse page no longer lists
    // user tunes for ACC — verifying via UI here would be a lie).
    await expect(async () => {
      const list = await page.request.get("/api/tunes?gameId=acc");
      const tunes = (await list.json()) as { id: number; name: string }[];
      expect(tunes.map((t) => t.name)).toContain("E2E ACC Tune");
    }).toPass({ timeout: 10_000 });

    const listRes = await page.request.get("/api/tunes?gameId=acc");
    const created = ((await listRes.json()) as { id: number; name: string; settings: { basicSetup: { tyres: { tyrePressure: number[] } } } }[]).find((t) => t.name === "E2E ACC Tune");
    expect(created).toBeDefined();
    expect(created!.settings.basicSetup.tyres.tyrePressure).toEqual([49, 45, 0, 0]);

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
