import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { GameId } from "../shared/games/ids";
import type { LapMeta } from "../shared/racing/sessions/types";
import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import {
  collectBrowserErrors,
  getSeededLapTarget,
} from "./seeded-e2e-helpers";

type ComparisonPayload = {
  traces: {
    distance: number[];
    speedA: number[];
    speedB: number[];
    throttleA: number[];
    throttleB: number[];
    brakeA: number[];
    brakeB: number[];
    rpmA: number[];
    rpmB: number[];
  };
  timeDelta: number[];
};

type ComparePair = {
  lapA: LapMeta;
  lapB: LapMeta;
};

function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

async function getLaps(request: APIRequestContext, gameId: GameId): Promise<LapMeta[]> {
  const response = await request.get(`/api/laps?gameId=${gameId}`);
  expect(response.ok(), `${gameId} seeded laps`).toBe(true);
  return (await response.json()) as LapMeta[];
}

async function getDistinctPair(request: APIRequestContext, gameId: GameId): Promise<ComparePair> {
  const first = await getSeededLapTarget(request, gameId);
  const laps = await getLaps(request, gameId);
  const second = laps.find(
    (lap) =>
      lap.id !== first.id &&
      lap.isValid &&
      lap.trackOrdinal === first.trackOrdinal &&
      lap.carOrdinal === first.carOrdinal,
  );
  expect(second, `${gameId} needs two valid seeded laps on one track/car`).toBeDefined();
  return { lapA: first, lapB: second! };
}

function comparePath(pair: ComparePair): string {
  return `/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}`;
}

function compareQuery(pair: ComparePair): string {
  return new URLSearchParams({
    track: String(pair.lapA.trackOrdinal),
    carA: String(pair.lapA.carOrdinal),
    carB: String(pair.lapB.carOrdinal),
    lapA: String(pair.lapA.id),
    lapB: String(pair.lapB.id),
    cursor: "7",
  }).toString();
}

async function assertSynchronizedCursors(page: Page): Promise<void> {
  const charts = page.getByTestId("lap-compare-workspace").locator(".uplot");
  await expect.poll(() => charts.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const overlays = charts.locator(".u-over");
  const overlay = overlays.nth(1);
  await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox();
  expect(box, "comparison chart overlay bounds").not.toBeNull();
  await overlay.hover({ position: { x: box!.width * 0.63, y: box!.height * 0.45 } });

  const chartCount = await charts.count();
  await expect
    .poll(
      async () => {
        const legends = await charts.locator(".u-legend").allTextContents();
        return legends.filter((legend) => /\d/.test(legend)).length;
      },
      { timeout: 10_000 },
    )
    .toBe(chartCount);
  const speedLegend = charts.nth(1).locator(".u-legend");
  await expect(speedLegend).toContainText("Speed A");
  await expect(speedLegend).toContainText("Speed B");
  await expect(speedLegend).toContainText(/\d/);
}

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} Compare renders distinct seeded traces and synchronized controls`, async ({ page, request }) => {
    test.setTimeout(180_000);
    const browserErrors = collectBrowserErrors(page);
    const pair = await getDistinctPair(request, game.gameId);
    const endpoint = comparePath(pair);

    const compareResponse = await request.get(endpoint);
    expect(compareResponse.ok(), `${game.name} compare API`).toBe(true);
    const payload = (await compareResponse.json()) as ComparisonPayload;
    const traceArrays = Object.values(payload.traces);
    expect(traceArrays.every((trace) => trace.length > 10), `${game.name} trace packet count`).toBe(true);
    expect(
      payload.traces.speedA.some((speed, index) => Math.abs(speed - payload.traces.speedB[index]!) > 0.0001),
      `${game.name} distinct speed traces`,
    ).toBe(true);
    expect(payload.traces.distance.length).toBe(payload.traces.speedA.length);
    expect(payload.traces.distance.length).toBe(payload.traces.speedB.length);
    expect(payload.timeDelta, `${game.name} time delta`).toBeDefined();
    expect(payload.timeDelta.some((delta) => Math.abs(delta) > 0.0001), `${game.name} has non-zero delta`).toBe(true);

    const sameLapResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapA.id}`);
    expect(sameLapResponse.status(), `${game.name} same-lap API rejection`).toBe(400);
    const sameLapBody = (await sameLapResponse.json()) as { error?: string };
    expect(sameLapBody.error).toContain("itself");

    const endpointPattern = new RegExp(`${endpoint.replaceAll("/", "\\/")}$`);
    let releaseLoading!: () => void;
    const loadingGate = new Promise<void>((resolve) => {
      releaseLoading = resolve;
    });
    await page.route(endpointPattern, async (route) => {
      await loadingGate;
      await route.continue();
    });

    await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}`, { waitUntil: "domcontentloaded" });
    const originalStorage = await page.evaluate(() => ({
      mapWidth: localStorage.getItem("compare-left-column-width"),
      aiPanel: localStorage.getItem("compare-ai-panel-open"),
    }));
    try {
    const workspace = page.getByTestId("lap-compare-workspace");
    await expect(workspace).toBeVisible();
    await expect(workspace.getByText(/loading/i)).toBeVisible();
    const initialResponse = page.waitForResponse(
      (response) => response.request().method() === "GET" && response.url().endsWith(endpoint),
    );
    releaseLoading();
    expect((await initialResponse).ok(), `${game.name} initial comparison load`).toBe(true);
    await page.unroute(endpointPattern);
    await expect(workspace.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });

    const lapB = page.getByLabel("Lap B");
    await lapB.click();
    await page
      .getByRole("option", {
        name: `Lap ${pair.lapA.lapNumber} — ${formatLapTime(pair.lapA.lapTime)}`,
        exact: true,
      })
      .click();
    await expect(page.getByText("Select two different laps to compare")).toBeVisible();

    await lapB.click();
    const reloadResponse = page.waitForResponse(
      (response) => response.request().method() === "GET" && response.url().endsWith(endpoint),
    );
    await page
      .getByRole("option", {
        name: `Lap ${pair.lapB.lapNumber} — ${formatLapTime(pair.lapB.lapTime)}`,
        exact: true,
      })
      .click();
    expect((await reloadResponse).ok(), `${game.name} comparison reload`).toBe(true);
    await expect(workspace.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });
    await expect(workspace.getByText("Time Delta", { exact: true })).toBeVisible();
    await expect(workspace.getByText("Gaining", { exact: true })).toBeVisible();
    await expect(workspace.getByText("Losing", { exact: true })).toBeVisible();
    await expect(workspace.getByText("Overview", { exact: true })).toBeVisible();
    await expect(workspace.getByText("Zoomed", { exact: true })).toBeVisible();
    await assertSynchronizedCursors(page);

    const followMode = page.getByRole("button", { name: "Fixed View", exact: true });
    await expect(followMode).toBeVisible();
    await followMode.click();
    await expect(page.getByRole("button", { name: "Follow View", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Follow View", exact: true }).click();
    await expect(page.getByRole("button", { name: "Fixed View", exact: true })).toBeVisible();

    const resizeHandle = page.getByRole("separator", { name: "Resize track map" });
    await expect(resizeHandle).toBeVisible();
    const widthBefore = Number(await resizeHandle.getAttribute("aria-valuenow"));
    await resizeHandle.press("ArrowRight");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", String(widthBefore + 16));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("separator", { name: "Resize track map" })).toHaveAttribute(
      "aria-valuenow",
      String(widthBefore + 16),
    );

    const aiToggle = page.getByRole("button", { name: /AI Analysis/ });
    await expect(aiToggle).toBeVisible();
    await aiToggle.click();
    await expect(page.getByText("Analyse both laps to start a comparison chat", { exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Analyse both laps to start a comparison chat", { exact: true })).toBeVisible();

    expect(browserErrors.errors, `unexpected browser errors before injected Compare failure in ${game.name}`).toEqual([]);
    const errorBody = JSON.stringify({ error: "Seeded compare failure" });
    await page.route(endpointPattern, (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: errorBody }),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Seeded compare failure", { exact: true })).toBeVisible();
    await page.unroute(endpointPattern);

    const expectedFailureUrl = new URL(endpoint, page.url()).toString();
    const expectedResourceError =
      "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
    expect(
      browserErrors.errors.filter(
        (error) => error !== expectedResourceError && !error.includes(`http 503: ${expectedFailureUrl}`),
      ),
      `unexpected browser errors in ${game.name} Compare flow`,
    ).toEqual([]);
    } finally {
      await page.evaluate(({ mapWidth, aiPanel }) => {
        if (mapWidth === null) localStorage.removeItem("compare-left-column-width");
        else localStorage.setItem("compare-left-column-width", mapWidth);
        if (aiPanel === null) localStorage.removeItem("compare-ai-panel-open");
        else localStorage.setItem("compare-ai-panel-open", aiPanel);
      }, originalStorage);
    }
  });
}
