import { expect, test } from "@playwright/test";
import type { DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";
import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";

import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";

test("global landing cards, period filters, and recent sessions navigate", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Latest Session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent sessions" })).toBeVisible();

  for (const game of SEEDED_GAME_CASES) {
    await expect(page.locator(`a[data-game-brand="${game.gameId}"]`)).toHaveAttribute("href", `/${game.prefix}`);
  }

  const today = page.getByRole("button", { name: "Today", exact: true });
  const year = page.getByRole("button", { name: "This Year", exact: true });
  await expect(page.getByRole("button", { name: "This Week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await today.click();
  await expect(today).toHaveAttribute("aria-pressed", "true");
  await year.click();
  await expect(year).toHaveAttribute("aria-pressed", "true");

  const fmRow = page.locator("tbody tr").filter({ has: page.locator('[data-game-brand="fm-2023"]') }).first();
  await expect(fmRow).toBeVisible();
  await fmRow.click();
  await expect(page).toHaveURL(/\/(fm23|f125|acc|ac-evo|iracing|lmu)\/sessions\/\d+\/analyse(?:\?|$)/);
  const sessionId = Number(new URL(page.url()).pathname.match(/\/sessions\/(\d+)\/analyse$/)?.[1]);
  expect(sessionId, "recent session destination ID").toBeGreaterThan(0);
  const reviewResponse = await page.request.get(`/api/laps/review?gameId=fm-2023&sessionId=${sessionId}&limit=5`);
  expect(reviewResponse.ok()).toBe(true);
  const reviewLaps = await reviewResponse.json() as Array<{ id: number; lapNumber: number }>;
  if (reviewLaps.length === 0) {
    await expect(page.getByText("No valid laps are available for review.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: /^Laps: \d+ · Primary: Lap \d+$/ })).toBeVisible();
    await page.getByRole("button", { name: `Analyse lap ${reviewLaps[0].lapNumber}`, exact: true }).click();
    await expect(page).toHaveURL(/\/(fm23|f125|acc|ac-evo|iracing|lmu)\/sessions\/\d+\/replay\/\d+(?:\?|$)/);
    await expect(page.getByRole("slider", { name: "Lap timeline" })).toBeVisible({ timeout: 20_000 });
  }
  expect(browserErrors.errors, "unexpected browser errors in landing flow").toEqual([]);
});

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} dashboard recap navigates to session laps`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(`/${game.prefix}`, { waitUntil: "domcontentloaded" });
    const yearResponsePromise = page.waitForResponse((response) => response.url().includes("/api/dashboard?") && response.request().headers()["x-game-id"] === game.gameId);
    await page.getByRole("button", { name: "This Year", exact: true }).click();
    const dashboardResponse = await yearResponsePromise;
    expect(dashboardResponse.ok(), `${game.gameId} dashboard data`).toBe(true);
    const dashboard = await dashboardResponse.json() as DashboardResponse;
    expect(dashboard.recentSessions.length, `${game.gameId} seeded sessions`).toBeGreaterThan(0);
    const latestSession = dashboard.recentSessions.find((session) => session.id === dashboard.latestRecapSessionId);
    expect(latestSession, `${game.gameId} recap-eligible seeded session`).toBeDefined();
    expect(latestSession!.gameId).toBe(game.gameId);
    expect(latestSession!.lapCount).toBeGreaterThan(0);

    const reviewResponse = await request.get(`/api/laps/review?gameId=${game.gameId}&sessionId=${latestSession!.id}&limit=5`);
    expect(reviewResponse.ok()).toBe(true);
    const reviewLaps = await reviewResponse.json() as Array<{ id: number; lapNumber: number }>;
    const eligibleLapIds = new Set(reviewLaps.map((lap) => lap.id));
    const recapResponse = await request.get(`/api/dashboard/sessions/${latestSession!.id}/recap`, {
      headers: { "X-Game-Id": game.gameId },
    });
    expect(recapResponse.ok(), `${game.gameId} current dashboard recap`).toBe(true);
    const recap = await recapResponse.json() as SessionRecap;
    const validLaps = recap.sparkline.filter((lap) => lap.isValid && lap.lapTimeSec > 0 && eligibleLapIds.has(lap.lapId));
    if (validLaps.length > 0) {
      expect(recap.bestLapId, `${game.gameId} recap best lap id`).not.toBeNull();
      expect(recap.bestLapSec, `${game.gameId} recap best lap time`).toBeGreaterThan(0);
      expect(validLaps.some((lap) => lap.lapId === recap.bestLapId), `${game.gameId} recap best lap is valid`).toBe(true);
    } else {
      expect(recap.bestLapId, `${game.gameId} no-valid-lap recap id`).toBeNull();
      expect(recap.bestLapSec, `${game.gameId} no-valid-lap recap time`).toBeNull();
    }

    const latestSessionAction = page.getByRole("link", { name: new RegExp(`Analyse Session: ${latestSession!.track.name ?? ""}`) });
    await expect(latestSessionAction).toBeVisible();
    await latestSessionAction.click();
    await expect(page).toHaveURL(new RegExp(`/${game.prefix}/sessions/${latestSession!.id}/analyse(?:\\?|$)`));
    if (reviewLaps.length === 0) {
      const inventoryResponse = await request.get(`/api/laps?gameId=${game.gameId}`);
      expect(inventoryResponse.ok()).toBe(true);
      const inventory = await inventoryResponse.json() as Array<{ id: number; sessionId: number }>;
      expect(inventory.some((lap) => lap.sessionId === latestSession!.id), `${game.gameId} session inventory remains available`).toBe(true);
      await expect(page.getByText("No valid laps are available for review.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: /^Laps: \d+ · Primary: Lap \d+$/ })).toBeVisible();
      const targetLap = reviewLaps[0];
      await page.getByRole("button", { name: `Analyse lap ${targetLap.lapNumber}`, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/${game.prefix}/sessions/${latestSession!.id}/replay/${targetLap.id}(?:\\?|$)`));
      await expect(page.getByRole("slider", { name: "Lap timeline" })).toBeVisible({ timeout: 20_000 });
    }
    expect(browserErrors.errors, `unexpected browser errors on ${game.prefix} dashboard`).toEqual([]);
  });
}

test("landing presents empty state when game has no recorded sessions", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.route("**/api/dashboard?**", async (route) => {
    if (route.request().headers()["x-game-id"] !== "iracing") return route.continue();
    const upstream = await route.fetch();
    const dashboard = await upstream.json() as DashboardResponse;
    await route.fulfill({ response: upstream, json: { ...dashboard, recentSessions: [], latestRecapSessionId: null } });
  });

  await page.goto("/iracing", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("No data", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Analyse Session:/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Analyse Session:/ })).toHaveCount(0);
  expect(browserErrors.errors, "unexpected browser errors in landing empty state").toEqual([]);
});

test("landing recovers after dashboard API error", async ({ page }) => {
  await page.route("**/api/dashboard?**", async (route) => {
    if (route.request().headers()["x-game-id"] !== "fm-2023") return route.continue();
    await route.fulfill({ status: 503, contentType: "text/plain", body: "seeded error" });
  });

  await page.goto("/fm23", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert").first()).toBeVisible();
  await page.unroute("**/api/dashboard?**");

  const browserErrors = collectBrowserErrors(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /^Analyse Session:/ }).first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(browserErrors.errors, "unexpected browser errors after dashboard recovery").toEqual([]);
});
