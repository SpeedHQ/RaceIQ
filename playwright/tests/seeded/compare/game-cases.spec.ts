import { expect, test } from "@playwright/test";
import type { ComparisonData } from "../../../../shared/racing/comparison/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { findTrackCarPairWithTwoLaps, getFirstSeededLap, getSeededLaps } from "./helpers";

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} compare supports seeded pair when available`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const laps = await getSeededLaps(request, game.gameId);
    const pair = findTrackCarPairWithTwoLaps(laps);
    if (!pair) {
      test.skip(true, `No seeded same-track same-car valid pair for ${game.name}`);
      return;
    }

    const response = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}`);
    expect(response.ok(), `${game.name} seeded comparison response`).toBe(true);
    const payload = (await response.json()) as ComparisonData;

    await page.goto(`/${game.prefix}/compare?track=${pair.trackOrdinal}&carA=${pair.carOrdinal}&carB=${pair.carOrdinal}&lapA=${pair.lapA.id}&lapB=${pair.lapB.id}`, { waitUntil: "domcontentloaded" });

    expect(payload.timeDelta.length).toBe(payload.traces.distance.length);
    await expect(page.getByTestId("lap-compare-workspace")).toBeVisible({ timeout: 30_000 });
    expect(browserErrors.errors, `no compare route errors for ${game.name}`).toEqual([]);
  });

  test(`${game.name} compare handles incomplete selection without route errors`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const laps = await getSeededLaps(request, game.gameId);
    const lap = getFirstSeededLap(laps);
    if (!lap) {
      test.skip(true, `No seeded laps available for ${game.name}`);
      return;
    }

    await page.goto(`/${game.prefix}/compare?track=${lap.trackOrdinal}&carA=${lap.carOrdinal}&lapA=${lap.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Select two laps above to compare")).toBeVisible({ timeout: 30_000 });
    expect(browserErrors.errors, `no route errors in ${game.name} incomplete compare state`).toEqual([]);
  });
}
