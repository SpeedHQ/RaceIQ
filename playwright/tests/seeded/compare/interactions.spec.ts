import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { assertSynchronizedCursors } from "./charts";
import { compareQuery, getDistinctPair } from "./interaction-helpers";
import { alignedRequestMatches, ALIGNED_TELEMETRY_ENDPOINT, fetchAlignedSet, lapOptionLabel } from "./helpers";

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} Compare renders distinct seeded traces and synchronized controls`, async ({ page, request }) => {
    test.setTimeout(180_000);
    const browserErrors = collectBrowserErrors(page);
    const pair = await getDistinctPair(request, game.gameId);
    const { response: compareResponse, set } = await fetchAlignedSet(request, pair);
    expect(compareResponse.ok(), `${game.name} compare API`).toBe(true);
    expect(set).not.toBeNull();
    const traceA = set!.laps[0]!;
    const traceB = set!.laps[1]!;
    const requiredTraces = {
      distance: set!.distanceMeters,
      speedA: traceA.speedMps,
      speedB: traceB.speedMps,
      throttleA: traceA.throttle,
      throttleB: traceB.throttle,
      brakeA: traceA.brake,
      brakeB: traceB.brake,
      rpmA: traceA.rpm,
      rpmB: traceB.rpm,
    };
    for (const [traceName, trace] of Object.entries(requiredTraces)) {
      expect(trace.length, `${game.name} ${traceName} packet count`).toBeGreaterThan(10);
    }
    expect(Boolean(traceA.tireWear), `${game.name} tyre-wear capability symmetry`).toBe(Boolean(traceB.tireWear));
    if (traceA.tireWear && traceB.tireWear) {
      expect(traceA.tireWear.FL.length, `${game.name} tyre-wear packet count`).toBe(traceB.tireWear.FL.length);
    }
    expect(
      traceA.speedMps.some((speed, index) => Math.abs(speed - traceB.speedMps[index]!) > 0.0001),
      `${game.name} distinct speed traces`,
    ).toBe(true);
    expect(set!.distanceMeters.length).toBe(traceA.speedMps.length);
    expect(set!.distanceMeters.length).toBe(traceB.speedMps.length);
    expect(
      traceA.elapsedTimeS.some((time, index) => Math.abs(time - traceB.elapsedTimeS[index]!) > 0.0001),
      `${game.name} has non-zero delta`,
    ).toBe(true);

    const sameLapResponse = await request.post(ALIGNED_TELEMETRY_ENDPOINT, { data: { ids: [pair.lapA.id, pair.lapA.id], step: 1 } });
    expect(sameLapResponse.status(), `${game.name} same-lap API rejection`).toBe(400);

    let releaseLoading!: () => void;
    const loadingGate = new Promise<void>((resolve) => {
      releaseLoading = resolve;
    });
    await page.route(ALIGNED_TELEMETRY_ENDPOINT, async (route) => {
      const body = route.request().postDataJSON() as { ids?: number[]; step?: number } | null;
      if (body?.step === 1 && body.ids?.[0] === pair.lapA.id && body.ids?.[1] === pair.lapB.id) await loadingGate;
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
      const initialResponse = page.waitForResponse((response) => alignedRequestMatches(response, pair.lapA.id, pair.lapB.id, 1));
      releaseLoading();
      expect((await initialResponse).ok(), `${game.name} initial comparison load`).toBe(true);
      await page.unroute(ALIGNED_TELEMETRY_ENDPOINT);
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
      await page
        .getByRole("option", {
          name: lapOptionLabel(pair.lapB),
          exact: true,
        })
        .click();
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
      await expect(workspace.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("separator", { name: "Resize track map" })).toHaveAttribute("aria-valuenow", String(widthBefore + 16));

      const aiToggle = page.getByRole("button", { name: /AI Analysis/ });
      await expect(aiToggle).toBeVisible();
      await aiToggle.click();
      await expect(page.getByText("Analyse both laps to start a comparison chat", { exact: true })).toBeVisible();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(workspace.locator(".uplot").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Analyse both laps to start a comparison chat", { exact: true })).toBeVisible();

      expect(browserErrors.errors, `unexpected browser errors before injected Compare failure in ${game.name}`).toEqual([]);
      const errorBody = JSON.stringify({ error: "Seeded compare failure" });
      await page.route(ALIGNED_TELEMETRY_ENDPOINT, (route) => route.fulfill({ status: 503, contentType: "application/json", body: errorBody }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("Seeded compare failure", { exact: true })).toBeVisible();
      await page.unroute(ALIGNED_TELEMETRY_ENDPOINT);

      const expectedFailureUrl = new URL(ALIGNED_TELEMETRY_ENDPOINT, page.url()).toString();
      const expectedResourceError = "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
      expect(
        browserErrors.errors.filter((error) => error !== expectedResourceError && !error.includes(`http 503: ${expectedFailureUrl}`)),
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
