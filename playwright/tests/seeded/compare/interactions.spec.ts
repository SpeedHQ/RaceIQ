import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { assertSynchronizedCursors } from "./charts";
import { compareQuery, getDistinctPair, type ComparisonPayload } from "./interaction-helpers";
import { compareEndpoint, lapOptionLabel } from "./helpers";

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} Compare renders distinct seeded traces and synchronized controls`, async ({ page, request }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const browserErrors = collectBrowserErrors(page);
    const pair = await getDistinctPair(request, game.gameId);
    const endpoint = compareEndpoint(pair);

    const compareResponse = await request.get(endpoint);
    expect(compareResponse.ok(), `${game.name} compare API`).toBe(true);
    const payload = (await compareResponse.json()) as ComparisonPayload;
    const requiredTraces = {
      distance: payload.traces.distance,
      speedA: payload.traces.speedA,
      speedB: payload.traces.speedB,
      throttleA: payload.traces.throttleA,
      throttleB: payload.traces.throttleB,
      brakeA: payload.traces.brakeA,
      brakeB: payload.traces.brakeB,
      rpmA: payload.traces.rpmA,
      rpmB: payload.traces.rpmB,
    };
    for (const [traceName, trace] of Object.entries(requiredTraces)) {
      expect(trace.length, `${game.name} ${traceName} packet count`).toBeGreaterThan(10);
    }
    expect(payload.traces.tireWearA.length, `${game.name} tyre-wear capability symmetry`).toBe(payload.traces.tireWearB.length);
    expect(
      payload.traces.speedA.some((speed, index) => Math.abs(speed - payload.traces.speedB[index]!) > 0.0001),
      `${game.name} distinct speed traces`,
    ).toBe(true);
    expect(payload.traces.distance.length).toBe(payload.traces.speedA.length);
    expect(payload.traces.distance.length).toBe(payload.traces.speedB.length);
    expect(payload.timeDelta, `${game.name} time delta`).toBeDefined();
    expect(
      payload.timeDelta.some((delta) => Math.abs(delta) > 0.0001),
      `${game.name} has non-zero delta`,
    ).toBe(true);

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
    const originalAiPanel = await page.evaluate(() => localStorage.getItem("compare-ai-panel-open"));
    try {
      const workspace = page.getByTestId("lap-compare-workspace");
      await expect(workspace).toBeVisible();
      await expect(workspace.getByText(/loading/i)).toBeVisible();
      const initialResponse = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(endpoint), { timeout: 30_000 });
      releaseLoading();
      expect((await initialResponse).ok(), `${game.name} initial comparison load`).toBe(true);
      await page.unroute(endpointPattern);
      await expect(workspace.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });

      const lapB = page.getByLabel("Lap B");
      await lapB.click();
      await page
        .getByRole("option", {
          name: lapOptionLabel(pair.lapA),
          exact: true,
        })
        .click();
      await expect(page.getByText("Select two different laps to compare")).toBeVisible();

      await lapB.click();
      const reloadResponse = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(endpoint), { timeout: 30_000 });
      await page
        .getByRole("option", {
          name: lapOptionLabel(pair.lapB),
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

      const aiToggle = page.getByRole("button", { name: /AI Analysis/ });
      await expect(aiToggle).toBeVisible();
      await aiToggle.click();
      await expect(page.getByText("Analyse both laps to start a comparison chat", { exact: true })).toBeVisible();
      const persistedAiResponse = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(endpoint), { timeout: 60_000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      expect((await persistedAiResponse).ok(), `${game.name} persisted-AI comparison reload`).toBe(true);
      await expect(workspace.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Analyse both laps to start a comparison chat", { exact: true })).toBeVisible({ timeout: 60_000 });

      expect(browserErrors.errors, `unexpected browser errors before injected Compare failure in ${game.name}`).toEqual([]);
      const errorBody = JSON.stringify({ error: "Seeded compare failure" });
      await page.route(endpointPattern, (route) => route.fulfill({ status: 503, contentType: "application/json", body: errorBody }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("Seeded compare failure", { exact: true })).toBeVisible();
      await page.unroute(endpointPattern);

      const expectedFailureUrl = new URL(endpoint, page.url()).toString();
      const expectedResourceError = "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
      expect(
        browserErrors.errors.filter((error) => error !== expectedResourceError && !error.includes(`http 503: ${expectedFailureUrl}`)),
        `unexpected browser errors in ${game.name} Compare flow`,
      ).toEqual([]);
    } finally {
      await page.evaluate((aiPanel) => {
        if (aiPanel === null) localStorage.removeItem("compare-ai-panel-open");
        else localStorage.setItem("compare-ai-panel-open", aiPanel);
      }, originalAiPanel);
    }
  });
}

test("iRacing Compare uses shared overview and zoom track canvases", async ({ page, request }) => {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === "iracing")!;
  const pair = await getDistinctPair(request, game.gameId);
  await page.goto(`/${game.prefix}/compare?${compareQuery(pair)}`, { waitUntil: "domcontentloaded" });

  const workspace = page.getByTestId("lap-compare-workspace");
  await expect(workspace.getByTestId("compare-overview-track-map")).toBeVisible({ timeout: 30_000 });
  await expect(workspace.getByTestId("compare-zoom-track-map")).toBeVisible();
  await assertSynchronizedCursors(page);

  const fixedMode = page.getByRole("button", { name: "Fixed View", exact: true });
  await fixedMode.click();
  await expect(page.getByRole("button", { name: "Follow View", exact: true })).toBeVisible();
});
