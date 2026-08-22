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

async function dragChart(page: Page, chart: Locator, startFraction: number, endFraction: number): Promise<void> {
  const overlay = chart.locator(".u-over");
  await overlay.scrollIntoViewIfNeeded();
  const box = await overlay.boundingBox();
  expect(box, "comparison chart overlay bounds").not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + box!.width * startFraction, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * endFraction, y, { steps: 12 });
  await page.mouse.up();
}

async function cursorDistance(chart: Locator, fraction: number): Promise<number> {
  const overlay = chart.locator(".u-over");
  const box = await overlay.boundingBox();
  expect(box, "comparison chart overlay bounds").not.toBeNull();
  await overlay.hover({ position: { x: box!.width * fraction, y: box!.height / 2 } });
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

test("Compare chart double-click restores full-lap x scale", async ({ page, request }) => {
  test.setTimeout(180_000);
  const chart = await openComparison(page, request);

  const response = rangeRequest(page);
  await dragChart(page, chart, 0.2, 0.55);
  await response;
  const zoomedSpan = await visibleDistanceSpan(chart);

  await chart.locator(".u-over").dblclick({ position: { x: 300, y: 60 } });

  await expect.poll(() => visibleDistanceSpan(chart)).toBeGreaterThan(zoomedSpan * 2);
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
