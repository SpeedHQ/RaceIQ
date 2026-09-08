import { expect, test, type Page, type Request } from "@playwright/test";
import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { getSeededLapTarget } from "../../support/seeded/laps";

const REVIEW_GAMES = SEEDED_GAME_CASES.filter((game) => game.gameId === "acc" || game.gameId === "ac-evo");

function alignedBody(request: Request): { ids: number[]; step: number; start?: number; end?: number } | null {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/laps/aligned-telemetry") return null;
  return request.postDataJSON() as { ids: number[]; step: number; start?: number; end?: number };
}

async function dragTelemetryLane(page: Page): Promise<void> {
  const lanes = page.locator('svg[style*="crosshair"]');
  await expect.poll(() => lanes.count(), { timeout: 30_000 }).toBeGreaterThan(1);
  const lane = lanes.nth(1);
  const box = await lane.boundingBox();
  if (!box) throw new Error("Track telemetry lane has no bounds");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.55, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 10 });
  await page.mouse.up();
}

for (const game of REVIEW_GAMES) {
  test(`Analyse session review reuses base telemetry for ${game.gameId}`, async ({ page, request }) => {
    test.setTimeout(180_000);
    const browserErrors = collectBrowserErrors(page);
    const target = await getSeededLapTarget(request, game.gameId);
    const lapsResponse = await request.get(`/api/laps?gameId=${game.gameId}`);
    expect(lapsResponse.ok()).toBe(true);
    const targetLap = ((await lapsResponse.json()) as LapMeta[]).find((lap) => lap.id === target.id);
    if (!targetLap) throw new Error(`Seeded target lap ${target.id} missing`);
    const sessionId = targetLap.sessionId;
    const reviewResponse = await request.get(`/api/laps/review?gameId=${game.gameId}&sessionId=${sessionId}&limit=5`);
    expect(reviewResponse.ok()).toBe(true);
    const evaluationLaps = (await reviewResponse.json()) as LapMeta[];
    const expectedIds = evaluationLaps.map((lap) => lap.id);
    expect(expectedIds.length).toBeGreaterThan(0);

    const alignedRequests: Array<{ ids: number[]; step: number; start?: number; end?: number }> = [];
    let semanticRequests = 0;
    page.on("request", (candidate) => {
      const body = alignedBody(candidate);
      if (body) alignedRequests.push(body);
      if (candidate.method() === "GET" && new URL(candidate.url()).pathname.endsWith("/semantic-telemetry")) semanticRequests += 1;
    });

    const baseResponse = page.waitForResponse((response) => alignedBody(response.request())?.step === 1);
    await page.goto(`/${game.prefix}/sessions/analyse?session=${sessionId}`, { waitUntil: "domcontentloaded" });
    expect((await baseResponse).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Track", exact: true })).toBeVisible();
    await expect(page.getByText("Showing up to five fastest clean laps.", { exact: true })).toBeVisible();
    expect(alignedRequests.filter((entry) => entry.step === 1)).toEqual([{ ids: expectedIds, step: 1 }]);
    expect(semanticRequests).toBe(0);

    await page.getByRole("button", { name: "Sector 1", exact: true }).click();
    await expect(page.getByText("Issues in this sector", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Track", exact: true }).click();
    await expect(page.getByRole("button", { name: "Consistency", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();

    if (evaluationLaps.length > 1) {
      const lap = evaluationLaps[1]!;
      await page.getByRole("combobox", { name: "Select lap" }).click();
      await page.getByRole("option", { name: new RegExp(`^Lap ${lap.lapNumber} —`) }).click();
      await expect(page.getByRole("combobox", { name: "Select lap" })).toHaveValue(new RegExp(`Lap ${lap.lapNumber} —`));
    }
    expect(alignedRequests.filter((entry) => entry.step === 1)).toHaveLength(1);
    expect(semanticRequests).toBe(0);

    await page.getByRole("button", { name: "Track", exact: true }).click();
    const detailResponse = page.waitForResponse((response) => alignedBody(response.request())?.step === 0.1);
    await dragTelemetryLane(page);
    expect((await detailResponse).ok()).toBe(true);
    const detail = alignedRequests.findLast((entry) => entry.step === 0.1);
    expect(detail?.ids).toEqual(expectedIds);
    expect(detail?.start).toBeLessThan(detail?.end ?? 0);
    expect(alignedRequests.filter((entry) => entry.step === 1)).toHaveLength(1);
    expect(semanticRequests).toBe(0);
    expect(browserErrors.errors, `unexpected browser errors for ${game.gameId} review`).toEqual([]);
  });
}
