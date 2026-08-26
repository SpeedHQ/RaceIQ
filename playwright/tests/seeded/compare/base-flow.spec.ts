import { expect, test } from "@playwright/test";
import type { ComparisonData } from "../../../../shared/racing/comparison/types";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";
import { comparePath, findTrackCarPairWithTwoLaps, getSeededLaps, lapOptionLabel } from "./helpers";

const fm23 = SEEDED_GAME_CASES.find((game) => game.gameId === "fm-2023");
if (!fm23) throw new Error("fm-2023 seeded case missing");

test("Compare complete seeded flow (FM23) preserves identity/order, renders traces/deltas, and persists layout state", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page, [/Failed to load resource: the server responded with a status of 400 \(Bad Request\)/, new RegExp(`/api/laps/(\\d+)/compare/\\1$`)]);
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
  const firstBody = await compareResponse.text();
  const comparison = JSON.parse(firstBody) as ComparisonData;
  const repeatResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}`);
  expect(repeatResponse.headers()["x-raceiq-cache"], "repeat comparison cache header").toBe("HIT");
  expect(await repeatResponse.text(), "cached comparison body parity").toBe(firstBody);
  const detailResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}/range?step=0.1&start=100&end=300`);
  expect(detailResponse.ok(), "high-fidelity comparison range").toBe(true);
  expect(detailResponse.headers()["x-raceiq-alignment-cache"], "warm alignment index header").toBe("HIT");
  const detail = (await detailResponse.json()) as { traces: { distance: number[] }; stepMeters: number };
  expect(detail.stepMeters).toBeCloseTo(0.1, 9);
  expect(detail.traces.distance.length).toBeLessThanOrEqual(100_000);
  const secondDetailResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}/range?step=0.1&start=500&end=700`);
  expect(secondDetailResponse.ok(), "second high-fidelity comparison range").toBe(true);
  expect(secondDetailResponse.headers()["x-raceiq-alignment-cache"], "reused alignment index header").toBe("HIT");
  const secondDetail = (await secondDetailResponse.json()) as { traces: { distance: number[] }; stepMeters: number };
  expect(secondDetail.stepMeters).toBeCloseTo(0.1, 9);
  expect(secondDetail.traces.distance.length).toBeLessThanOrEqual(100_000);
  await page.goto(`/${fm23.prefix}/compare?${query}`, { waitUntil: "domcontentloaded" });
  expect(comparison.traces.distance.length, "trace length").toBeGreaterThan(1);
  expect(comparison.traces.distance).toHaveLength(comparison.timeDelta.length);
  expect(comparison.traces.sourceIndicesA).toHaveLength(comparison.traces.distance.length);
  expect(comparison.traces.sourceIndicesB).toHaveLength(comparison.traces.distance.length);
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
    return response.request().method() === "GET" && comparePath(Number(persistedParams.get("lapA")), Number(persistedParams.get("lapB"))).test(url.pathname);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await reloadCompare;
  await expect(page.getByText("Select two different laps to compare")).toHaveCount(0);
  await expect(page.getByTestId("lap-compare-workspace")).toBeVisible();
  expect(Number(await page.getByRole("separator", { name: "Resize track map" }).getAttribute("aria-valuenow"))).toBe(adjustedWidth);

  const sameLapResponse = await request.get(`/api/laps/${pair.lapA.id}/compare/${pair.lapA.id}`);
  expect(sameLapResponse.status(), "same-lap compare rejects").toBe(400);
  const sameLapBody = (await sameLapResponse.json()) as { error?: string };
  expect(sameLapBody.error ?? "").toContain("Cannot compare a lap with itself");

  const cacheForward = await request.post(`/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}/inputs-analyse?cacheOnly=true`);
  const cacheReverse = await request.post(`/api/laps/${pair.lapB.id}/compare/${pair.lapA.id}/inputs-analyse?cacheOnly=true`);
  expect(cacheForward.ok()).toBe(true);
  expect(cacheReverse.ok()).toBe(true);
  const cacheForwardBody = (await cacheForward.json()) as { analysis?: string | null; cached?: boolean };
  const cacheReverseBody = (await cacheReverse.json()) as { analysis?: string | null; cached?: boolean };
  expect(cacheForwardBody.cached, "cache key is order-independent").toBe(cacheReverseBody.cached);

  expect(browserErrors.errors, "unexpected browser errors in FM23 compare flow").toEqual([]);
});
