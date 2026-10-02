import { expect, test } from "@playwright/test";
import { z } from "zod";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";

const DriverProfileSchema = z.object({
  gameName: z.string(),
  fingerprint: z.object({
    trend: z.object({
      recent: z.object({ total: z.number() }),
    }),
  }),
});

const DriverRunsSchema = z.object({
  configured: z.boolean(),
  state: z.string(),
  runs: z.array(z.object({ id: z.number(), status: z.string(), createdAt: z.string() })),
});

const DriverRunMutationSchema = z.object({
  state: z.string(),
  run: z.unknown().nullable(),
});

for (const game of SEEDED_GAME_CASES.filter(({ supportedFeatures }) => supportedFeatures.includes("driver"))) {
  test(`${game.name} Driver profile matches deterministic API state`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const headers = { "X-Game-Id": game.gameId };
    const profileResponse = await request.get("/api/drivers/profile", { headers });
    expect(profileResponse.ok()).toBe(true);
    const profile = DriverProfileSchema.parse(await profileResponse.json());
    const runsResponse = await request.get("/api/drivers/profile/runs", { headers });
    expect(runsResponse.ok()).toBe(true);
    const runs = DriverRunsSchema.parse(await runsResponse.json());
    const invalidRunResponse = await request.post("/api/drivers/profile/runs", { headers });
    expect(invalidRunResponse.status()).toBe(400);
    if (!runs.configured) {
      expect(runs.state).toBe("not-configured");
      for (const action of ["runNow=true", "retry=true"]) {
        const runResponse = await request.post(`/api/drivers/profile/runs?${action}`, { headers });
        expect(runResponse.ok()).toBe(true);
        expect(DriverRunMutationSchema.parse(await runResponse.json())).toMatchObject({
          state: "not-configured",
          run: null,
        });
      }
    }

    await page.goto(`/${game.prefix}/driver`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Driver Profile" })).toBeVisible();
    await expect(page.getByText("Driver result breakdown", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Run history" })).toBeVisible();
    if (runs.runs.length === 0) {
      await expect(page.getByText("No AI runs yet.", { exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: `All ${profile.gameName} laps`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${game.prefix}/sessions(?:\\?.*)?$`));
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Driver Profile" })).toBeVisible();
    await expect(page.getByText(`latest ${profile.fingerprint.trend.recent.total}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Full profile detail" })).toBeVisible();
    await expect(page.getByText("Recurring patterns", { exact: true })).toBeVisible();
    await expect(page.getByText("Data caveats", { exact: true })).toBeVisible();
    if (!runs.configured) {
      expect(runs.state).toBe("not-configured");
      await expect(page.getByRole("heading", { name: "Provider not configured" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh AI summary" })).toBeDisabled();
    }

    expect(browserErrors.errors, `unexpected ${game.gameId} Driver browser errors`).toEqual([]);
  });
}
