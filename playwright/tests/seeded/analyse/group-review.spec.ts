import { expect, test } from "@playwright/test";
import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";

const REVIEW_GAMES = SEEDED_GAME_CASES.filter((game) => game.gameId === "acc" || game.gameId === "ac-evo");
const LEGACY_ANALYSE_GAMES = SEEDED_GAME_CASES.filter((game) => game.gameId !== "acc" && game.gameId !== "ac-evo");

for (const game of REVIEW_GAMES) {
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

    const lapPicker = page.locator("select").first();
    await expect(lapPicker).toBeVisible();
    const optionLapIds = await lapPicker.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(optionLapIds.length).toBeGreaterThan(0);
    await expect
      .poll(() => {
        const value = new URL(page.url()).searchParams.get("laps") ?? "";
        const canonicalValue = value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
        return canonicalValue.split(",").filter(Boolean).sort();
      })
      .toEqual([...optionLapIds].sort());
    expect(new URL(page.url()).searchParams.get("lap")).toBeNull();
    expect(browserErrors.errors, `unexpected browser errors for ${game.gameId} review`).toEqual([]);

    await lapPicker.selectOption(optionLapIds[0]);
    await expect.poll(() => new URL(page.url()).searchParams.get("lap")).toBe(optionLapIds[0]);
    expect(new URL(page.url()).searchParams.get("track")).toBe(String(target.trackOrdinal));
    expect(new URL(page.url()).searchParams.get("car")).toBe(String(target.carOrdinal));
    await expect(page.getByTestId("lap-analyse-workspace")).toBeVisible({ timeout: 30_000 });
  });
}

for (const game of LEGACY_ANALYSE_GAMES) {
  test(`Analyse keeps lap workspace for ${game.gameId}`, async ({ page, request }) => {
    const target = await getSeededLapTarget(request, game.gameId);
    await page.goto(`/${game.prefix}/analyse?track=${target.trackOrdinal}&car=${target.carOrdinal}&lap=${target.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("lap-analyse-workspace")).toBeVisible({ timeout: 30_000 });
  });
}
