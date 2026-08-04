import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ComparisonData } from "../shared/racing/comparison/types";
import type { LapMeta } from "../shared/racing/sessions/types";
import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import { collectBrowserErrors } from "./seeded-e2e-helpers";

interface SeededLapMeta extends LapMeta {
  trackOrdinal: number;
  carOrdinal: number;
  lapNumber: number;
}

function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

function lapOptionLabel(lap: SeededLapMeta): string {
  return `Lap ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${lap.isValid ? "" : " (inv)"}`;
}

function findTrackCarPairWithTwoLaps(laps: readonly SeededLapMeta[]): {
  trackOrdinal: number;
  carOrdinal: number;
  lapA: SeededLapMeta;
  lapB: SeededLapMeta;
} | null {
  const byTrack = new Map<number, Map<number, SeededLapMeta[]>>();
  for (const lap of laps) {
    if (!lap.trackOrdinal || !lap.carOrdinal) continue;
    if (!lap.isValid) continue;
    let cars = byTrack.get(lap.trackOrdinal);
    if (!cars) {
      cars = new Map();
      byTrack.set(lap.trackOrdinal, cars);
    }
    const list = cars.get(lap.carOrdinal) ?? [];
    list.push(lap);
    cars.set(lap.carOrdinal, list);
  }

  const tracks = Array.from(byTrack.keys()).sort((a, b) => a - b);
  for (const trackOrdinal of tracks) {
    const cars = byTrack.get(trackOrdinal);
    if (!cars) continue;
    const carOrdinals = Array.from(cars.keys()).sort((a, b) => a - b);
    for (const carOrdinal of carOrdinals) {
      const candidate = cars.get(carOrdinal)?.slice().sort((a, b) => a.lapNumber - b.lapNumber || a.id - b.id) ?? [];
      if (candidate.length >= 2) {
        return {
          trackOrdinal,
          carOrdinal,
          lapA: candidate[0],
          lapB: candidate[1],
        };
      }
    }
  }

  return null;
}

function getFirstSeededLap(laps: readonly SeededLapMeta[]): SeededLapMeta | null {
  return laps
    .filter((lap) => lap.trackOrdinal !== undefined && lap.carOrdinal !== undefined)
    .sort((a, b) => a.id - b.id)[0] ?? null;
}

function comparePath(idA: number, idB: number): RegExp {
  return new RegExp(`^/api/laps/${idA}/compare/${idB}$`);
}

async function getSeededLaps(request: APIRequestContext, gameId: string): Promise<SeededLapMeta[]> {
  const response = await request.get(`/api/laps?gameId=${gameId}`);
  expect(response.ok(), `seeded lap list for ${gameId}`).toBe(true);
  const laps = (await response.json()) as SeededLapMeta[];
  expect(laps.length, `seeded laps for ${gameId}`).toBeGreaterThan(0);
  return laps;
}

const fm23 = SEEDED_GAME_CASES.find((game) => game.gameId === "fm-2023");
if (!fm23) throw new Error("fm-2023 seeded case missing");


test("Compare complete seeded flow (FM23) preserves identity/order, renders traces/deltas, and persists layout state", async ({
  page,
  request,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const laps = await getSeededLaps(request, fm23.gameId);
  const pair = findTrackCarPairWithTwoLaps(laps);
  if (!pair) {
    throw new Error(`No valid seeded lap pair for ${fm23.name}`);
  }

  const query = new URLSearchParams({
    track: String(pair.trackOrdinal),
    carA: String(pair.carOrdinal),
    carB: String(pair.carOrdinal),
    lapA: String(pair.lapA.id),
    lapB: String(pair.lapB.id),
  });

  const compareResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}`);
  expect(compareResponse.ok(), "seeded FM comparison response").toBe(true);
  const comparison = (await compareResponse.json()) as ComparisonData;

  await page.goto(`/${fm23.prefix}/compare?${query}`, { waitUntil: "domcontentloaded" });
  expect(comparison.traces.distance.length, "trace length").toBeGreaterThan(1);
  expect(comparison.traces.distance).toHaveLength(comparison.timeDelta.length);
  expect(comparison.timeDelta).not.toHaveLength(0);

  const workspace = page.getByTestId("lap-compare-workspace");
  await expect(workspace).toBeVisible({ timeout: 30_000 });

  const searchParams = new URL(page.url()).searchParams;
  expect(searchParams.get("lapA"), "lapA from URL query").toBe(String(pair.lapA.id));
  expect(searchParams.get("lapB"), "lapB from URL query").toBe(String(pair.lapB.id));

  await expect(workspace.getByText("Time Delta")).toBeVisible();
  expect(await workspace.locator("canvas").count(), "trace and delta canvases").toBeGreaterThanOrEqual(4);

  const lapAOption = lapOptionLabel(pair.lapA);
  const lapBOption = lapOptionLabel(pair.lapB);

  const lapASelect = page.getByLabel("Lap A");
  await lapASelect.click();
  const lapAListboxId = await lapASelect.getAttribute("aria-controls");
  expect(lapAListboxId, "Lap A listbox").not.toBeNull();
  await page.locator(`[id="${lapAListboxId}"]`).getByRole("option", { name: lapBOption, exact: true }).click();
  await expect(page.getByText("Select two different laps to compare")).toBeVisible();

  const swapResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && comparePath(pair.lapB.id, pair.lapA.id).test(url.pathname);
  });
  const lapBSelect = page.getByLabel("Lap B");
  await lapBSelect.click();
  const lapBListboxId = await lapBSelect.getAttribute("aria-controls");
  expect(lapBListboxId, "Lap B listbox").not.toBeNull();
  await page.locator(`[id="${lapBListboxId}"]`).getByRole("option", { name: lapAOption, exact: true }).click();
  await swapResponse;

  const swappedParams = new URL(page.url()).searchParams;
  expect(swappedParams.get("lapA"), "lapA after swap").toBe(String(pair.lapB.id));
  expect(swappedParams.get("lapB"), "lapB after swap").toBe(String(pair.lapA.id));

  const layoutMode = page.getByRole("button", { name: /Follow View|Fixed View/ });
  const initialMode = (await layoutMode.innerText()).trim();
  await expect(layoutMode).toBeVisible();
  await layoutMode.click();
  await expect(layoutMode, "layout mode toggles").toHaveText(initialMode === "Fixed View" ? "Follow View" : "Fixed View");

  const resizeHandle = page.getByRole("separator", { name: "Resize track map" });
  await expect(resizeHandle).toBeVisible();
  const savedWidth = Number(await resizeHandle.getAttribute("aria-valuenow"));
  await resizeHandle.press("ArrowRight");
  const adjustedWidth = Number(await resizeHandle.getAttribute("aria-valuenow"));
  expect(adjustedWidth, "resized map width").toBeGreaterThanOrEqual(savedWidth);

  const persistedParams = new URLSearchParams(swappedParams);
  const reloadCompare = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && comparePath(Number(persistedParams.get("lapA")), Number(persistedParams.get("lapB"))).test(url.pathname);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await reloadCompare;
  await expect(page.getByText("Select two different laps to compare")).toHaveCount(0);
  await expect(page.getByTestId("lap-compare-workspace")).toBeVisible();
  expect(Number(await page.getByRole("separator", { name: "Resize track map" }).getAttribute("aria-valuenow"))).toBe(
    adjustedWidth,
  );

  const sameLapResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapA.id}`);
  expect(sameLapResponse.status(), "same-lap compare rejects").toBe(400);
  const sameLapBody = (await sameLapResponse.json()) as { error?: string };
  expect(sameLapBody.error ?? "").toContain("Cannot compare a lap with itself");

  const cacheForward = await request.post(
    `/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}/inputs-analyse?cacheOnly=true`,
  );
  const cacheReverse = await request.post(
    `/api/laps/${pair.lapB.id}/compare/${pair.lapA.id}/inputs-analyse?cacheOnly=true`,
  );
  expect(cacheForward.ok()).toBe(true);
  expect(cacheReverse.ok()).toBe(true);
  const cacheForwardBody = (await cacheForward.json()) as { analysis?: string | null; cached?: boolean };
  const cacheReverseBody = (await cacheReverse.json()) as { analysis?: string | null; cached?: boolean };
  expect(cacheForwardBody.cached, "cache key is order-independent").toBe(cacheReverseBody.cached);

  expect(browserErrors.errors, "unexpected browser errors in FM23 compare flow").toEqual([]);
});

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

    await page.goto(
      `/${game.prefix}/compare?track=${pair.trackOrdinal}&carA=${pair.carOrdinal}&carB=${pair.carOrdinal}&lapA=${pair.lapA.id}&lapB=${pair.lapB.id}`,
      { waitUntil: "domcontentloaded" },
    );

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

    await page.goto(
      `/${game.prefix}/compare?track=${lap.trackOrdinal}&carA=${lap.carOrdinal}&lapA=${lap.id}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByText("Select two laps above to compare")).toBeVisible({ timeout: 30_000 });
    expect(browserErrors.errors, `no route errors in ${game.name} incomplete compare state`).toEqual([]);
  });
}
