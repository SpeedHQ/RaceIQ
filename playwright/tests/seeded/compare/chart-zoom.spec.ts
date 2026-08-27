import { expect, test, type Locator, type Page } from "@playwright/test";

import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { compareQuery, getDistinctPair } from "./interaction-helpers";

const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "f1-2025")!;

async function openComparison(page: Page, request: Parameters<typeof getDistinctPair>[0]) {
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}`, { waitUntil: "domcontentloaded" });
  const chart = page.getByTestId("lap-compare-workspace").locator(".uplot").nth(1);
  await expect(chart).toBeVisible({ timeout: 30_000 });
  return chart;
}

type OverlayBounds = { x: number; y: number; width: number; height: number };
async function overlayBounds(overlay: Locator): Promise<OverlayBounds> {
  let settled: OverlayBounds | null = null;
  await expect.poll(
    async () => {
      const box = await overlay.boundingBox();
      settled = box !== null && box.width > 0 && box.height > 0 ? box : null;
      return settled !== null;
    },
    { timeout: 30_000, message: "comparison chart overlay must have settled bounds" },
  ).toBe(true);
  return settled!;
}

async function dragChart(page: Page, chart: Locator, startFraction: number, endFraction: number): Promise<void> {
  const overlay = chart.locator(".u-over");
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  const box = await overlayBounds(overlay);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * startFraction, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * endFraction, y, { steps: 12 });
  await page.mouse.up();
}
async function cursorDistance(chart: Locator, fraction: number): Promise<number> {
  const overlay = chart.locator(".u-over");
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  const box = await overlayBounds(overlay);
  await overlay.hover({ position: { x: box.width * fraction, y: box.height / 2 } });
  const valueLocator = chart.locator(".u-legend .u-series").first().locator(".u-value");
  const parseValue = async () => Number((await valueLocator.textContent())?.replace(/[^0-9.-]/g, ""));
  await expect.poll(parseValue).toBeGreaterThanOrEqual(0);
  return parseValue();
}

async function visibleDistanceSpan(chart: Locator): Promise<number> {
  const low = await cursorDistance(chart, 0.1);
  const high = await cursorDistance(chart, 0.9);
  return Math.abs(high - low);
}

async function hoverAndAssertCursorMarkers(chart: Locator, fraction: number): Promise<string> {
  const overlay = chart.locator(".u-over");
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  const overlayBox = await overlayBounds(overlay);
  await overlay.hover({ position: { x: overlayBox.width * fraction, y: overlayBox.height / 2 } });

  const markers = chart.locator(".u-cursor-pt");
  await expect(markers).toHaveCount(2);
  const markerBoxes = await markers.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }),
  );
  expect(Math.abs(markerBoxes[0].left - markerBoxes[1].left), "cursor markers share x position").toBeLessThanOrEqual(1);
  for (const markerBox of markerBoxes) {
    expect(Number.isFinite(markerBox.left)).toBe(true);
    expect(Number.isFinite(markerBox.top)).toBe(true);
    expect(Number.isFinite(markerBox.width)).toBe(true);
    expect(Number.isFinite(markerBox.height)).toBe(true);
    expect(markerBox.left).toBeGreaterThanOrEqual(overlayBox.x - markerBox.width);
    expect(markerBox.right).toBeLessThanOrEqual(overlayBox.x + overlayBox.width + markerBox.width);
    expect(markerBox.top).toBeGreaterThanOrEqual(overlayBox.y - markerBox.height);
    expect(markerBox.bottom).toBeLessThanOrEqual(overlayBox.y + overlayBox.height + markerBox.height);
  }
  const value = chart.locator(".u-legend .u-series").first().locator(".u-value");
  await expect.poll(async () => Number.isFinite(Number((await value.textContent())?.replace(/[^0-9.-]/g, "")))).toBe(true);
  return (await value.textContent()) ?? "";
}

function rangeRequest(page: Page) {
  return page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/range"));
}

function rangeBounds(url: string): { start: number; end: number } {
  const parsed = new URL(url);
  return { start: Number(parsed.searchParams.get("start")), end: Number(parsed.searchParams.get("end")) };
}

test("Compare chart supports consecutive narrower zooms", async ({ page, request }) => {
  test.setTimeout(180_000);
  const chart = await openComparison(page, request);

  const firstResponse = rangeRequest(page);
  await dragChart(page, chart, 0.2, 0.55);
  const first = rangeBounds((await firstResponse).url());

  const secondResponse = rangeRequest(page);
  await dragChart(page, chart, 0.3, 0.65);
  const second = rangeBounds((await secondResponse).url());

  expect(second.start).toBeGreaterThan(first.start);
  expect(second.end).toBeLessThan(first.end);
  expect(second.end - second.start).toBeLessThan(first.end - first.start);
});

test("Compare chart double-click steps back one zoom level", async ({ page, request }) => {
  test.setTimeout(180_000);
  const chart = await openComparison(page, request);
  const fullSpan = await visibleDistanceSpan(chart);

  const firstResponse = rangeRequest(page);
  await dragChart(page, chart, 0.2, 0.55);
  await firstResponse;
  const firstSpan = await visibleDistanceSpan(chart);

  const secondResponse = rangeRequest(page);
  await dragChart(page, chart, 0.3, 0.65);
  await secondResponse;
  const secondSpan = await visibleDistanceSpan(chart);
  expect(secondSpan).toBeLessThan(firstSpan);
  expect(firstSpan).toBeLessThan(fullSpan);

  await chart.locator(".u-over").dblclick({ position: { x: 300, y: 60 } });
  await expect.poll(() => visibleDistanceSpan(chart)).toBeGreaterThanOrEqual(firstSpan * 0.9);
  await expect.poll(() => visibleDistanceSpan(chart)).toBeLessThanOrEqual(firstSpan * 1.1);
  expect(await visibleDistanceSpan(chart)).toBeLessThan(fullSpan * 0.9);

  await chart.locator(".u-over").dblclick({ position: { x: 300, y: 60 } });
  await expect.poll(() => visibleDistanceSpan(chart)).toBeGreaterThanOrEqual(fullSpan * 0.9);
  await expect.poll(() => visibleDistanceSpan(chart)).toBeLessThanOrEqual(fullSpan * 1.1);

  await chart.locator(".u-over").dblclick({ position: { x: 300, y: 60 } });
  await page.waitForTimeout(500);
  const afterThirdDoubleClick = await visibleDistanceSpan(chart);
  expect(afterThirdDoubleClick).toBeGreaterThanOrEqual(fullSpan * 0.9);
  expect(afterThirdDoubleClick).toBeLessThanOrEqual(fullSpan * 1.1);
});

test("Compare chart click does not submit a zoom range", async ({ page, request }) => {
  test.setTimeout(180_000);
  const chart = await openComparison(page, request);

  const response = rangeRequest(page);
  await dragChart(page, chart, 0.2, 0.55);
  await response;

  const rangeRequests: string[] = [];
  page.on("request", (candidate) => {
    if (candidate.method() === "GET" && new URL(candidate.url()).pathname.endsWith("/range")) rangeRequests.push(candidate.url());
  });
  await chart.locator(".u-over").click({ position: { x: 300, y: 60 } });
  await page.waitForTimeout(500);

  expect(rangeRequests).toEqual([]);
});

test("Compare zoom keeps hover markers aligned with zoomed chart", async ({ page, request }) => {
  test.setTimeout(180_000);
  const chart = await openComparison(page, request);

  const response = rangeRequest(page);
  await dragChart(page, chart, 0.24, 0.68);
  await response;

  const legendValues = [];
  for (const fraction of [0.2, 0.5, 0.8]) {
    legendValues.push(await hoverAndAssertCursorMarkers(chart, fraction));
  }
  expect(new Set(legendValues).size).toBeGreaterThan(1);
});
