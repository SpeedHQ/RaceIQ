import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { exerciseCrossGameControls } from "./controls";
import { openAnalyseLap } from "./fixtures";

test("Analyse shared controls work across seeded game recordings", async ({ page, request }) => {
  test.setTimeout(240_000);
  const browserErrors = collectBrowserErrors(page);

  for (const game of SEEDED_GAME_CASES) {
    const target = await getSeededLapTarget(request, game.gameId);
    await openAnalyseLap(page, target, game.prefix);
    await exerciseCrossGameControls(page, game.gameId === "f1-2025" && Boolean(target.telemetry[0]?.f1?.setup), target.lapNumber);
  }

  expect(browserErrors.errors, "unexpected browser errors in seeded Analyse matrix").toEqual([]);
});
