import { expect, test, type Page, type Request } from "@playwright/test";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { collectBrowserErrors } from "../../../../playwright/tests/support/browser-errors";
import { SEEDED_GAME_CASES } from "../../../../playwright/tests/support/seeded/cases";
import { getSeededLapTarget } from "../../../../playwright/tests/support/seeded/laps";

const REVIEW_GAMES = SEEDED_GAME_CASES.filter((game) => game.gameId === "acc" || game.gameId === "ac-evo");

function alignedBody(request: Request): { ids: number[]; step: number; start?: number; end?: number } | null {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/laps/aligned-telemetry") return null;
  return request.postDataJSON() as { ids: number[]; step: number; start?: number; end?: number };
}

async function dragTelemetryLane(page: Page): Promise<void> {
  const lanes = page.locator("[data-track-telemetry-lane] .u-over");
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

for (const game of REVIEW_GAMES.filter((game) => game.gameId === "acc")) {
  test(`Analyse session review reuses base telemetry for ${game.gameId}`, async ({ page, request }) => {
    test.setTimeout(200_000);
    const browserErrors = collectBrowserErrors(page);
    const lapsResponse = await request.get(`/api/laps?gameId=${game.gameId}`);
    expect(lapsResponse.ok()).toBe(true);
    const laps = (await lapsResponse.json()) as LapMeta[];
    const sessions = [...new Set(laps.filter((lap) => lap.isValid).map((lap) => lap.sessionId))];
    let sessionId: number | undefined;
    let expectedIds: number[] = [];
    for (const candidateSessionId of sessions) {
      const reviewResponse = await request.get(`/api/laps/review?gameId=${game.gameId}&sessionId=${candidateSessionId}&limit=5`);
      expect(reviewResponse.ok()).toBe(true);
      const evaluationLaps = (await reviewResponse.json()) as LapMeta[];
      if (evaluationLaps.length > 0) {
        sessionId = candidateSessionId;
        expectedIds = evaluationLaps.map((lap) => lap.id);
        break;
      }
    }
    expect(sessionId, `${game.gameId} seeded data needs a session with reviewable laps`).toBeDefined();
    if (sessionId == null) throw new Error(`${game.gameId} seeded data has no reviewable session`);

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
    await expect(page.getByRole("button", { name: "Issues", exact: true })).toBeVisible();
    const baseRequests = alignedRequests.filter((entry) => entry.step === 1);
    expect(baseRequests.length).toBeGreaterThan(0);
    expect(baseRequests.every((entry) => [...entry.ids].sort((a, b) => a - b).join(",") === [...expectedIds].sort((a, b) => a - b).join(","))).toBe(true);
    expect(semanticRequests).toBe(0);

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await expect(page).toHaveURL(/view=issues/);
    await expect(page.getByText("Detected from telemetry", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(page).not.toHaveURL(/view=issues/);
    await expect(page.getByText("Detected from telemetry", { exact: true })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /^Sector \d+$/ })).toHaveCount(0);
    await expect(page.getByTestId("stint-analysis")).toBeVisible();
    await expect(page.getByTestId("stint-analysis")).toBeVisible();
    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    await expect(page.getByRole("button", { name: "Consistency", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Overview", exact: true }).click();

    const baseRequestsAfterInteraction = alignedRequests.filter((entry) => entry.step === 1);
    expect(baseRequestsAfterInteraction.length).toBeGreaterThan(0);
    expect(baseRequestsAfterInteraction.every((entry) => [...entry.ids].sort((a, b) => a - b).join(",") === [...expectedIds].sort((a, b) => a - b).join(","))).toBe(true);
    expect(semanticRequests).toBe(0);

    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    const detailResponse = page.waitForResponse((response) => alignedBody(response.request())?.step === 0.1);
    await dragTelemetryLane(page);
    expect((await detailResponse).ok()).toBe(true);
    const detail = alignedRequests.findLast((entry) => entry.step === 0.1);
    expect(detail?.ids ? [...detail.ids].sort((a, b) => a - b) : detail?.ids).toEqual([...expectedIds].sort((a, b) => a - b));
    expect(detail?.start).toBeLessThan(detail?.end ?? 0);

    const baseRequestsAtEnd = alignedRequests.filter((entry) => entry.step === 1);
    expect(baseRequestsAtEnd.length).toBeGreaterThan(0);
    expect(baseRequestsAtEnd.every((entry) => [...entry.ids].sort((a, b) => a - b).join(",") === [...expectedIds].sort((a, b) => a - b).join(","))).toBe(true);
    expect(semanticRequests).toBe(0);
    expect(browserErrors.errors, `unexpected browser errors for ${game.gameId} review`).toEqual([]);
  });
}

for (const game of REVIEW_GAMES) {
  test(`Analyse lap header returns to session review for ${game.gameId}`, async ({ page, request }) => {
    const target = await getSeededLapTarget(request, game.gameId);
    const lapsResponse = await request.get(`/api/laps?gameId=${game.gameId}`);
    expect(lapsResponse.ok()).toBe(true);
    const targetLap = ((await lapsResponse.json()) as LapMeta[]).find((lap) => lap.id === target.id);
    if (!targetLap || targetLap.sessionId == null || !targetLap.trackId || !targetLap.carId) {
      throw new Error(`Seeded target lap ${target.id} has incomplete route metadata`);
    }

    await page.goto(`/${game.prefix}/sessions/${targetLap.sessionId}/analyse?track=${encodeURIComponent(targetLap.trackId)}&car=${encodeURIComponent(targetLap.carId)}&lap=${targetLap.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Analyse Session", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${game.prefix}/sessions/${targetLap.sessionId}/analyse(?:\\?|$)`));
    const reviewResponse = await request.get(`/api/laps/review?gameId=${game.gameId}&sessionId=${targetLap.sessionId}&limit=5`);
    expect(reviewResponse.ok()).toBe(true);
    const reviewLaps = (await reviewResponse.json()) as LapMeta[];
    if (reviewLaps.length > 0) {
      await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    } else {
      await expect(page.getByText("No valid laps are available for review.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toBeVisible();
    }
  });

}

test("Analyse session review preserves invalid laps for ac-evo", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const lapsResponse = await request.get("/api/laps?gameId=ac-evo");
  expect(lapsResponse.ok()).toBe(true);
  const laps = (await lapsResponse.json()) as LapMeta[];
  const sessionId = laps.find((lap) => lap.invalidReason === "track limits")?.sessionId;
  expect(sessionId, "AC Evo seed needs a session with track-limit violations").toBeDefined();
  if (sessionId == null) throw new Error("AC Evo seed has no invalid session");
  const sessionLaps = laps.filter((lap) => lap.sessionId === sessionId);
  expect(sessionLaps.every((lap) => !lap.isValid && lap.invalidReason != null)).toBe(true);

  const reviewResponse = await request.get(`/api/laps/review?gameId=ac-evo&sessionId=${sessionId}&limit=5`);
  expect(reviewResponse.ok()).toBe(true);
  expect(await reviewResponse.json()).toEqual([]);

  await page.goto(`/ac-evo/sessions/analyse?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("No valid laps are available for review.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toBeVisible();
  expect(browserErrors.errors, "unexpected browser errors for invalid AC Evo session").toEqual([]);
});
 
test("Analyse session route rejects mixed session and lap selections", async ({ page }) => {
  await page.goto("/acc/sessions/analyse?session=1&lap=2", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Invalid Analyse selection" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Session selection must contain only a positive session ID.");
});

test("Session Analyse selection cancel, apply and reload preserve primary lap", async ({ page, request }) => {
  const response = await request.get("/api/laps?gameId=acc");
  expect(response.ok()).toBe(true);
  const laps = await response.json() as LapMeta[];
  let selected: LapMeta[] = [];
  for (const sessionId of new Set(laps.map((lap) => lap.sessionId))) {
    const review = await request.get(`/api/laps/review?gameId=acc&sessionId=${sessionId}&limit=5`);
    expect(review.ok()).toBe(true);
    const candidates = await review.json() as LapMeta[];
    if (candidates.length >= 2) {
      selected = candidates.slice(0, 2);
      break;
    }
  }
  expect(selected.length, "ACC seed needs a session with two reviewable laps").toBe(2);
  const [first, second] = selected as [LapMeta, LapMeta];
  await page.goto(`/acc/sessions/${first.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
  const selectionButton = page.getByRole("button", { name: /^Laps: \d+ · Primary: Lap / });
  await expect(selectionButton).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("primary")).toBe(true);
  const initialUrl = page.url();
  await selectionButton.click();
  const dialog = page.getByRole("dialog", { name: "Choose laps to display" });
  await expect(dialog).toBeVisible();
  const firstCheckbox = dialog.getByRole("checkbox", { name: `Display Lap ${first.lapNumber}`, exact: true });
  await firstCheckbox.setChecked(!(await firstCheckbox.isChecked()));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(initialUrl);

  await selectionButton.click();
  for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.uncheck();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: `Display Lap ${first.lapNumber}`, exact: true }).check();
  await dialog.getByRole("checkbox", { name: `Display Lap ${second.lapNumber}`, exact: true }).check();
  await dialog.getByRole("radio", { name: `Primary Lap ${second.lapNumber}`, exact: true }).check();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(selectionButton).toHaveText(`Laps: 2 · Primary: Lap ${second.lapNumber}`);
  const expectedIds = selected.map((lap) => String(lap.id)).sort();
  expect(new URL(page.url()).searchParams.get("laps")?.split(",").sort()).toEqual(expectedIds);
  expect(new URL(page.url()).searchParams.get("primary")).toBe(String(second.id));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(selectionButton).toHaveText(`Laps: 2 · Primary: Lap ${second.lapNumber}`);
  expect(new URL(page.url()).searchParams.get("laps")?.split(",").sort()).toEqual(expectedIds);
});

test("Session Analyse rejects malformed selections and reports missing sessions", async ({ page }) => {
  for (const search of [
    "session=-1",
    "session=1&laps=1,1&primary=1",
    "session=1&laps=1,2,3,4,5,6&primary=1",
    "session=1&laps=1,2&primary=3",
    "session=1&laps=bad&primary=1",
  ]) {
    await page.goto(`/acc/sessions/analyse?${search}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Invalid Analyse selection" })).toBeVisible();
  }
  await page.goto("/acc/sessions/999999999/analyse", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toHaveText("Session not found.");
  await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
  await expect(page).toHaveURL(/\/acc\/sessions\/?$/);
});
