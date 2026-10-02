import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { fetchAlignedSet, findTrackCarPairWithTwoLaps, getFirstSeededLap, getSeededLaps, lapOptionLabel } from "./helpers";

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} compare supports seeded pair when available`, async ({ page, request }) => {
    const browserErrors = collectBrowserErrors(page);
    const laps = await getSeededLaps(request, game.gameId);
    const pair = findTrackCarPairWithTwoLaps(laps);
    if (!pair) {
      test.skip(true, `No seeded same-track same-car valid pair for ${game.name}`);
      return;
    }

    const { response, set } = await fetchAlignedSet(request, pair);
    expect(response.ok(), `${game.name} seeded comparison response`).toBe(true);
    const body = await response.text();
    if (game.gameId === "f1-2025") expect(Buffer.byteLength(body, "utf8"), "F1 comparison response size").toBeLessThan(5_000_000);
    expect(set).not.toBeNull();

    await page.goto(`/${game.prefix}/compare?track=${pair.trackOrdinal}&carA=${pair.carOrdinal}&carB=${pair.carOrdinal}&lapA=${pair.lapA.id}&lapB=${pair.lapB.id}`, { waitUntil: "domcontentloaded" });

    expect(set!.laps[0]!.elapsedTimeS.length).toBe(set!.distanceMeters.length);
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

test("Compare ignores a stale URL lap before selecting another F1 lap", async ({ page, request }) => {
  const f1 = SEEDED_GAME_CASES.find((game) => game.gameId === "f1-2025")!;
  const fm = SEEDED_GAME_CASES.find((game) => game.gameId === "fm-2023")!;
  const laps = await getSeededLaps(request, f1.gameId);
  const f1Lap = getFirstSeededLap(laps)!;
  const nextLap = laps.find((lap) => lap.id !== f1Lap.id && lap.trackOrdinal === f1Lap.trackOrdinal && lap.carOrdinal === f1Lap.carOrdinal)!;
  const staleLap = getFirstSeededLap(await getSeededLaps(request, fm.gameId))!;
  const alignmentRequests: number[][] = [];
  page.on("request", (req) => {
    if (!req.url().endsWith("/api/laps/aligned-telemetry")) return;
    const body: unknown = req.postDataJSON();
    if (body && typeof body === "object" && "ids" in body && Array.isArray(body.ids)) alignmentRequests.push(body.ids);
  });

  await page.goto(`/${f1.prefix}/compare?track=${f1Lap.trackOrdinal}&carA=${f1Lap.carOrdinal}&carB=${f1Lap.carOrdinal}&lapA=${staleLap.id}&lapB=${f1Lap.id}`);
  await expect(page.getByTestId("lap-compare-workspace").getByText("Select two laps above to compare")).toBeVisible();
  await expect(page.getByLabel("Lap A")).toHaveValue("");
  expect(alignmentRequests).toEqual([]);
  const lapA = page.getByLabel("Lap A");
  await lapA.click();
  const listbox = await lapA.getAttribute("aria-controls");
  await page.locator(`[id="${listbox}"]`).getByRole("option", { name: lapOptionLabel(nextLap), exact: true }).click();
  await expect(page.getByTestId("lap-compare-workspace").getByText("Time Delta")).toBeVisible();
});
