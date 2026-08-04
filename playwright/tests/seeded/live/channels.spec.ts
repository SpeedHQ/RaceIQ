import { expect, test } from "@playwright/test";

import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";
import { assertDisconnectReconnect } from "./connection";
import { RECORDING_BY_GAME } from "./fixtures";
import { assertRecordingChangesLiveChannels, assertRecordingChangesRawValue } from "./replay";

test.describe.configure({ mode: "serial" });

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} live channels and reconnect use committed recording`, async ({ page, request }) => {
    test.setTimeout(75_000);
    const browserErrors = collectBrowserErrors(page);
    const livePath = game.gameId === "iracing" ? "/iracing/live/driver" : `/${game.prefix}/live`;
    await page.goto(livePath, { waitUntil: "domcontentloaded" });
    await assertRecordingChangesLiveChannels(page, request, game.gameId, RECORDING_BY_GAME[game.gameId]);

    if (game.gameId === "iracing") {
      await expect(page.getByRole("link", { name: "Driver", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Pit Crew", exact: true }).click();
      await expect(page).toHaveURL(/\/iracing\/live\/pit$/);
      await expect(page.getByText(/Telemetry \(60s\)/)).toBeVisible();
      await expect(page.getByText(/Tires/).first()).toBeVisible();
    }

    await assertDisconnectReconnect(page, request, game.gameId);
    await page.goto(`/${game.prefix}/raw`, { waitUntil: "domcontentloaded" });
    await assertRecordingChangesRawValue(page, request, RECORDING_BY_GAME[game.gameId]);
    expect(browserErrors.errors, `unexpected ${game.gameId} live browser errors`).toEqual([]);
  });
}
