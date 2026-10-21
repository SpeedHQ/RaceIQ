import { expect, test } from "@playwright/test";
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers"

for (const resource of ["aligned", "semantic"] as const) {
  test(`Spectate defaults and shares ${resource} work across view switches`, async ({ page, request }) => {
    const pair = await getDistinctPair(request, "acc");
    const query = compareQuery(pair);
    const calls: string[] = [];
    const failed: string[] = [];
    const matches = (url: string) => resource === "aligned"
      ? url.endsWith("/api/laps/aligned-telemetry")
      : /\/api\/laps\/\d+\/semantic-telemetry$/.test(url);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    page.on("requestfailed", (req) => { if (matches(req.url())) failed.push(req.url()); });
    await page.route(resource === "aligned" ? "**/api/laps/aligned-telemetry" : "**/api/laps/*/semantic-telemetry", async (route) => {
      calls.push(route.request().url());
      const response = await route.fetch();
      await pending;
      await route.fulfill({ response });
    });
    try {
      await page.goto(`/acc/compare?${query}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#compare-tab-spectate")).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => calls.length).toBe(resource === "aligned" ? 1 : 2);
      const split = page.getByRole("button", { name: "Split recordings", exact: true });
      if (await split.isVisible()) await split.click();
      await page.locator("#compare-tab-compare").click();
      await expect(page.locator("#compare-tab-compare")).toHaveAttribute("aria-selected", "true");
      await expect(page).toHaveURL(/view=compare/);
      if (resource === "aligned") await expect(page.locator("#compare-body-compare")).not.toBeVisible();
      // Detach every observer, then return while the original responses are pending.
      await page.locator('a[href="/acc/sessions"]').first().click();
      await expect(page).toHaveURL(/\/acc\/sessions/);
      await page.goBack();
      await expect(page.locator("#compare-tab-compare")).toHaveAttribute("aria-selected", "true");
      release();
      await expect(page.locator("#compare-body-compare")).toBeVisible();
      await page.locator("#compare-tab-spectate").click();
      await expect(page.locator("[data-spectate-playback]")).toBeVisible();
      await page.locator("#compare-tab-compare").click();
      await page.locator("#compare-tab-spectate").click();
      await expect(page.locator("[data-spectate-playback]")).toBeVisible();
      expect(failed).toEqual([]);
      expect(calls.length).toBe(resource === "aligned" ? 1 : 2);
      expect(new Set(calls).size).toBe(calls.length);
    } finally {
      release();
    }
  });
}
