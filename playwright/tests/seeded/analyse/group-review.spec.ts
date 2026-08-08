import { expect, test } from "@playwright/test";
import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";

for (const game of SEEDED_GAME_CASES) {
  test(`Analyse track-car review works for ${game.gameId}`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const target = await getSeededLapTarget(request, game.gameId);
    const lapsResponse = await request.get(`/api/laps?gameId=${game.gameId}`);
    expect(lapsResponse.ok()).toBe(true);
    const groupLaps = ((await lapsResponse.json()) as LapMeta[])
      .filter((lap) => lap.trackOrdinal === target.trackOrdinal && lap.carOrdinal === target.carOrdinal && lap.isValid && lap.lapTime > 0)
      .sort((a, b) => a.lapTime - b.lapTime);
    const requestedIds = (groupLaps.length > 0 ? groupLaps.slice(0, Math.min(6, groupLaps.length)) : [target]).map((lap) => lap.id);
    await page.goto(`/${game.prefix}/analyse?track=${target.trackOrdinal}&car=${target.carOrdinal}&laps=${requestedIds.join(",")}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Post-lap", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Track", exact: true })).toBeVisible();
    await expect(page.getByText(/Evaluating fastest \d+ of \d+ laps/, { exact: true })).toBeVisible();

    const lapPicker = page.locator("select").first();
    await expect(lapPicker).toBeVisible();
    await lapPicker.selectOption(String(target.id));
    await expect.poll(() => new URL(page.url()).searchParams.get("track")).toBe(String(target.trackOrdinal));
    expect(new URL(page.url()).searchParams.get("car")).toBe(String(target.carOrdinal));
    expect(new URL(page.url()).searchParams.get("lap")).toBe(String(target.id));
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
    expect(browserErrors.errors, `unexpected browser errors for ${game.gameId}`).toEqual([]);
  });
}
