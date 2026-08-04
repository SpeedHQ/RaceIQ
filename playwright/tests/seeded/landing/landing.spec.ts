import { expect, test } from "@playwright/test";

import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";

test("global landing cards, period filters, and recent laps navigate", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "RaceIQ" })).toBeVisible();

  for (const game of SEEDED_GAME_CASES) {
    await expect(page.locator(`a[data-game-brand="${game.gameId}"]`)).toHaveAttribute("href", `/${game.prefix}`);
  }

  const today = page.getByRole("button", { name: "Today", exact: true });
  const allTime = page.getByRole("button", { name: "All Time", exact: true });
  await expect(allTime).toHaveClass(/bg-app-accent\/20/);
  await today.click();
  await expect(today).toHaveClass(/bg-app-accent\/20/);
  await expect(allTime).not.toHaveClass(/bg-app-accent\/20/);

  const recentRows = page.locator("tbody tr");
  await expect(recentRows.first()).toBeVisible();
  await recentRows.first().click();
  await expect(page).toHaveURL(/\/(fm23|f125|acc|ac-evo|iracing)\/analyse\?/);
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({
    timeout: 20_000,
  });

  expect(browserErrors.errors, "unexpected browser errors in landing flow").toEqual([]);
});

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} landing primary action navigates with lap data`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const lapsResponse = await request.get(`/api/laps?gameId=${game.gameId}`);
    expect(lapsResponse.ok(), `${game.gameId} seeded landing laps`).toBe(true);
    const laps = (await lapsResponse.json()) as Array<{
      id: number;
      lapNumber: number;
      isValid: boolean;
      lapTime: number;
    }>;
    const validLapIds = new Set(laps.filter((lap) => lap.isValid && lap.lapTime > 0).map((lap) => lap.id));

    const sessionsResponse = await request.get(`/api/sessions?gameId=${game.gameId}`);
    expect(sessionsResponse.ok(), `${game.gameId} seeded landing sessions`).toBe(true);
    const sessions = (await sessionsResponse.json()) as Array<{ id: number; createdAt: string }>;
    const latestSession = [...sessions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

    await page.goto(`/${game.prefix}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(`[data-game-brand="${game.gameId}"]`).first()).toBeVisible();
    if (!latestSession) {
      await expect(page.getByRole("button", { name: "Analyse best lap" })).toHaveCount(0);
      await expect(page.getByText(/No laps recorded yet/)).toBeVisible();
      expect(browserErrors.errors, `unexpected browser errors on ${game.prefix} empty landing`).toEqual([]);
      return;
    }

    const recapResponse = await request.get(`/api/sessions/${latestSession.id}/recap?gameId=${game.gameId}`);
    expect(recapResponse.ok(), `${game.gameId} seeded landing recap`).toBe(true);
    const recap = (await recapResponse.json()) as { bestLapId?: number | null };
    if (recap.bestLapId == null || !validLapIds.has(recap.bestLapId)) {
      await expect(page.getByRole("button", { name: "Analyse best lap" })).toHaveCount(0);
      expect(browserErrors.errors, `unexpected browser errors on ${game.prefix} unsupported landing action`).toEqual([]);
      return;
    }

    const bestLap = laps.find((lap) => lap.id === recap.bestLapId);
    expect(bestLap, `${game.gameId} recap best lap row`).toBeDefined();
    await expect(page.getByRole("button", { name: "Analyse best lap" })).toBeVisible();
    await page.getByRole("button", { name: "Analyse best lap" }).click();
    await expect(page).toHaveURL(new RegExp(`/${game.prefix}/analyse\\?[^#]*lap=${recap.bestLapId}(?:&|$)`));
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(`Lap ${bestLap!.lapNumber}`, { exact: true })).toBeVisible();
    expect(browserErrors.errors, `unexpected browser errors on ${game.prefix} landing`).toEqual([]);
  });
}

test("landing presents empty state when game has no recorded laps", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  // Controlled empty responses exercise presentation-only state; normal flows above use seeded DB/API.
  await page.route("**/api/laps**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("gameId") === "iracing") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("gameId") === "iracing") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.continue();
  });

  await page.goto("/iracing", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/No laps recorded yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyse best lap" })).toHaveCount(0);
  expect(browserErrors.errors, "unexpected browser errors in landing empty state").toEqual([]);
});

test("landing recovers after laps API error", async ({ page }) => {
  await page.route("**/api/laps**", async (route) => {
    const gameId = new URL(route.request().url()).searchParams.get("gameId");
    if (gameId === "fm-2023") {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "seeded error" });
      return;
    }
    await route.continue();
  });

  await page.goto("/fm23", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toContainText("Error");
  await page.unroute("**/api/laps**");

  const browserErrors = collectBrowserErrors(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(browserErrors.errors, "unexpected browser errors after landing recovery").toEqual([]);
});
