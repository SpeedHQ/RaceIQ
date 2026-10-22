import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { collectBrowserErrors } from "../../support/browser-errors";
import deMessages from "../../../../client/messages/de.json";

interface ImportedLap { lapId: number; sessionId: number }
interface ImportedCapture { laps?: ImportedLap[] }
interface Settings { recordLmuOpponents: boolean; language: string }
interface OpponentSummary {
  opponentLapId: string;
  lapNumber: number | null;
  className: string | null;
  coverage: "complete" | "partial";
  validity: "valid" | "invalid" | "unknown";
  mode: "timing-only" | "telemetry" | "unavailable";
  lapTime: { state: string; value: number | null };
  comparableSemanticIds: string[];
  reasons: string[];
}
interface OpponentCatalog { sourceRevision: string; opponentRetention: string; laps: OpponentSummary[] }
interface ImportedFixture { lap: LapMeta; sessionId: number }

async function importFixture(request: APIRequestContext, identity: string): Promise<ImportedFixture> {
  const response = await request.post("/api/laps/import", {
    timeout: 120_000,
    multipart: {
      file: { name: `lmu-opponents-${identity}.bin.gz`, mimeType: "application/octet-stream", buffer: makeLmuOpponentCapture({ identity }) },
      ownership: "mine",
    },
  });
  expect(response.ok(), `controlled LMU import: ${await response.text()}`).toBe(true);
  const imported = (await response.json()) as ImportedCapture;
  const rows = imported.laps ?? [];
  expect(rows.length).toBeGreaterThan(0);
  const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
  expect(sessionIds).toHaveLength(1);
  const allLapsResponse = await request.get("/api/laps?gameId=lmu");
  expect(allLapsResponse.ok()).toBe(true);
  const laps = (await allLapsResponse.json()) as LapMeta[];
  const lap = laps.find((candidate) => candidate.id === rows[0]!.lapId);
  expect(lap).toBeDefined();
  return { lap: lap!, sessionId: sessionIds[0]! };
}

async function removeFixture(request: APIRequestContext, sessionId: number): Promise<void> {
  const response = await request.post("/api/sessions/bulk-delete", { data: { ids: [sessionId] } });
  expect(response.ok(), `remove isolated LMU fixture session ${sessionId}: ${await response.text()}`).toBe(true);
}

async function exerciseOpponentComparison(page: Page, request: APIRequestContext): Promise<void> {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const identity = `pw-${crypto.randomUUID()}`;
  const settingsResponse = await request.get("/api/settings");
  expect(settingsResponse.ok()).toBe(true);
  const originalSettings = (await settingsResponse.json()) as Settings;
  const savedFalse = await request.put("/api/settings", { data: { recordLmuOpponents: false } });
  expect(savedFalse.ok()).toBe(true);
  let fixture: ImportedFixture | null = null;
  let zipSessionIds: number[] = [];
  try {
    fixture = await importFixture(request, identity);
    const { lap } = fixture;
    const catalogResponse = await request.get(`/api/laps/${lap.id}/opponent-laps`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(catalogResponse.ok()).toBe(true);
    const catalog = (await catalogResponse.json()) as OpponentCatalog;
    expect(catalog.opponentRetention).toBe("retained");
    expect(catalog.laps.length).toBeGreaterThan(0);
    expect(catalog.laps.some((entry) => entry.validity === "unknown"), "uncertain native lap validity remains explicit").toBe(true);
    const candidate = catalog.laps.find((entry) => entry.mode === "telemetry" && entry.coverage === "complete");
    expect(candidate, "fixture should provide a complete source-backed opponent lap").toBeDefined();
    expect(lap.lapTime).toBeCloseTo(12, 0);
    expect(candidate!.lapTime).toMatchObject({ state: "ok", value: 18 });
    expect(candidate!.className).toBeTruthy();
    const comparisonResponse = await request.post(`/api/laps/${lap.id}/opponent-comparison`, {
      timeout: 60_000,
      headers: { "X-Game-Id": "lmu" },
      data: { opponentLapId: candidate!.opponentLapId, sourceRevision: catalog.sourceRevision, step: 1 },
    });
    expect(comparisonResponse.ok()).toBe(true);
    const comparison = await comparisonResponse.json() as { traces: { semanticId: string; player: unknown[]; opponent: unknown[] }[]; opponent: OpponentSummary };
    expect(comparison.opponent.opponentLapId).toBe(candidate!.opponentLapId);
    expect(comparison.traces.map((trace) => trace.semanticId)).toEqual(expect.arrayContaining(["motion.position-x", "motion.position-z"]));
    expect(comparison.traces.every((trace) => trace.player.length === trace.opponent.length)).toBe(true);
    expect(candidate!.comparableSemanticIds).toContain("motion.speed");
    expect(candidate!.comparableSemanticIds.some((semantic) => /throttle|brake|steering/i.test(semantic))).toBe(false);

    const exportResponse = await request.get(`/api/laps/export-zip?ids=${lap.id}&opponentLap=${encodeURIComponent(candidate!.opponentLapId)}&opponentRevision=${encodeURIComponent(catalog.sourceRevision)}`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(exportResponse.ok(), "selected opponent export includes its full interval").toBe(true);
    const selectedZip = await exportResponse.body();
    expect(selectedZip.byteLength).toBeGreaterThan(0);
    const oldLapIds = new Set(((await (await request.get("/api/laps?gameId=lmu")).json()) as LapMeta[]).map((entry) => entry.id));
    const zipImport = await request.post("/api/laps/import-zip", {
      timeout: 120_000,
      multipart: { file: { name: `opponent-${identity}.zip`, mimeType: "application/zip", buffer: selectedZip }, ownership: "mine" },
    });
    expect(zipImport.ok(), `selected opponent ZIP import: ${await zipImport.text()}`).toBe(true);
    expect(((await zipImport.json()) as { imported: number }).imported).toBeGreaterThan(0);
    const afterZip = (await (await request.get("/api/laps?gameId=lmu")).json()) as LapMeta[];
    const restoredLaps = afterZip.filter((entry) => !oldLapIds.has(entry.id) && entry.trackId === lap.trackId);
    expect(restoredLaps.length).toBeGreaterThan(0);
    zipSessionIds = [...new Set(restoredLaps.map((entry) => entry.sessionId).filter((id): id is number => id != null))];
    const restoredCatalogResponse = await request.get(`/api/laps/${restoredLaps[0]!.id}/opponent-laps`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(restoredCatalogResponse.ok()).toBe(true);
    const restoredCatalog = (await restoredCatalogResponse.json()) as OpponentCatalog;
    expect(restoredCatalog.opponentRetention).toBe("retained");
    expect(restoredCatalog.laps.some((entry) => entry.coverage === "complete" && entry.mode === "telemetry")).toBe(true);

    const alignedRequests: string[] = [];
    page.on("request", (browserRequest) => {
      const path = new URL(browserRequest.url()).pathname;
      if (path.startsWith("/api/laps/") && (path.includes("aligned-telemetry") || path.endsWith("/compare"))) alignedRequests.push(`${browserRequest.method()} ${path}`);
    });
    const params = new URLSearchParams({ track: lap.trackId!, carA: lap.carId!, lapA: String(lap.id) });
    await page.goto(`/lmu/compare?${params}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("lap-compare-workspace")).toBeVisible();
    await page.getByRole("button", { name: "Opponents", exact: true }).click();
    const opponentSelect = page.getByRole("combobox", { name: "Recorded opponent lap" });
    await expect(opponentSelect).toBeEnabled({ timeout: 30_000 });
    await opponentSelect.click();
    await expect(page.getByRole("option").filter({ hasText: "Partial" }).first()).toBeVisible();
    await expect(page.getByRole("option").filter({ hasText: /unknown/i }).first()).toBeVisible();
    await opponentSelect.press("Escape");
    expect(new URL(page.url()).searchParams.get("opponentLap"), "Escape cancels pending selection").toBeNull();
    await opponentSelect.fill(candidate!.className!);
    await expect(page.getByRole("option").filter({ hasText: candidate!.className! }).first()).toBeVisible();
    await opponentSelect.fill("Controlled opponent");
    await expect(page.getByRole("option").filter({ hasText: "Controlled opponent" }).first()).toBeVisible();
    await opponentSelect.press("ArrowDown");
    await opponentSelect.press("Enter");
    expect(new URL(page.url()).searchParams.get("opponentLap"), "preview does not commit a reference").toBeNull();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(new URL(page.url()).searchParams.get("opponentLap"), "Cancel preserves committed reference").toBeNull();
    await opponentSelect.fill(`Lap ${candidate!.lapNumber} ·`);
    await opponentSelect.press("ArrowDown");
    await opponentSelect.press("Enter");
    await page.getByRole("button", { name: "Lap compare", exact: true }).click();
    await expect(page.getByTestId("opponent-comparison")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("opponent-comparison")).toContainText("Controlled opponent");
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentLap")).toBe(candidate!.opponentLapId);
    await expect.poll(() => new URL(page.url()).searchParams.get("lapA")).toBe(String(lap.id));
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentRevision")).toBe(catalog.sourceRevision);
    const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
    const exportRequest = page.waitForResponse((response) => response.url().includes("/api/laps/export-zip"), { timeout: 60_000 });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const uiExport = await exportRequest;
    expect(uiExport.ok()).toBe(true);
    expect(new URL(uiExport.url()).searchParams.get("opponentLap")).toBe(candidate!.opponentLapId);
    expect(new URL(uiExport.url()).searchParams.get("opponentRevision")).toBe(catalog.sourceRevision);
    expect(await (await downloadEvent).failure()).toBeNull();
    await expect(page.locator("[data-opponent-replay]")).toBeVisible();
    const clock = page.locator("[data-spectate-playback]");
    await expect(clock).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const canvas = page.locator("[data-spectate-scene] canvas").first();
    for (const side of ["a", "b"]) {
      await expect.poll(async () => Number(await canvas.getAttribute(`data-${side}-racing-line-segments`))).toBeGreaterThan(0);
    }
    const seek = page.getByRole("slider", { name: "Replay position" });
    await seek.press("Home");
    await seek.press("ArrowRight");
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
    await expect.poll(async () => Number(await clock.getAttribute("data-a-distance"))).toBeGreaterThan(0);
    await expect.poll(async () => Number(await clock.getAttribute("data-b-distance"))).toBeGreaterThan(0);
    expect(alignedRequests, "opponent selection must not request player-only aligned comparison").toEqual([]);
    const persistedUrl = page.url();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("opponent-comparison")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("combobox", { name: "Recorded opponent lap" })).toHaveValue(/Controlled opponent/);
    await page.goBack();
    await expect.poll(() => page.url()).not.toBe(persistedUrl);
    await page.goForward();
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentLap")).toBe(candidate!.opponentLapId);
    await expect(page.getByTestId("opponent-comparison")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "comparison fits viewport").toBe(true);
    await page.screenshot({ path: test.info().outputPath("opponent-comparison.png"), fullPage: true });
    if (page.viewportSize()!.width < 600) {
      const localized = await request.put("/api/settings", { data: { language: "de" } });
      expect(localized.ok()).toBe(true);
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByRole("combobox", { name: deMessages.compare_opponent_lap })).toHaveValue(/Controlled opponent/, { timeout: 30_000 });
        await expect(page.getByTestId("opponent-comparison")).toContainText(deMessages.compare_opponent_coverage_complete);
        await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath("opponent-comparison-de.png"), fullPage: true });
      } finally {
        const restored = await request.put("/api/settings", { data: { language: originalSettings.language } });
        expect(restored.ok()).toBe(true);
      }
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    const staleUrl = new URL(page.url());
    staleUrl.searchParams.set("opponentRevision", "stale-revision");
    await page.goto(staleUrl.toString(), { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-opponent-state="source-changed"]')).toBeVisible();
    await expect(page.locator("[data-opponent-replay]")).toHaveCount(0);
    await page.goto(persistedUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-opponent-replay]")).toBeVisible();
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const removed = await request.post("/api/storage/session-opponents", { data: { sessionIds: [fixture.sessionId] } });
    expect(removed.status()).toBe(202);
    await expect.poll(async () => (await (await request.get("/api/storage/session-opponents")).json()).status, { timeout: 60_000 }).toBe("success");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-opponent-state="removed"]')).toBeVisible();
    await expect(page.locator("[data-opponent-replay]")).toHaveCount(0);
    const playerReplay = await request.get(`/api/laps/${lap.id}/semantic-telemetry`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(playerReplay.ok(), "player replay remains readable after opponent removal").toBe(true);
    const strippedExport = await request.get(`/api/laps/export-zip?ids=${lap.id}`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(strippedExport.ok()).toBe(true);
    const strippedImport = await request.post("/api/laps/import-zip", {
      timeout: 120_000,
      multipart: { file: { name: `stripped-${identity}.zip`, mimeType: "application/zip", buffer: await strippedExport.body() }, ownership: "mine" },
    });
    expect(strippedImport.ok(), "stripped comparison ZIP reimports as player-only history").toBe(true);
    const stripped = await strippedImport.json() as { laps: ImportedLap[] };
    zipSessionIds.push(...new Set(stripped.laps.map((entry) => entry.sessionId)));
    expect(stripped.laps.length).toBeGreaterThan(0);
    const strippedCatalog = await request.get(`/api/laps/${stripped.laps[0]!.lapId}/opponent-laps`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(strippedCatalog.ok()).toBe(true);
    expect(await strippedCatalog.json()).toMatchObject({ opponentRetention: "removed", opponentAvailability: null, laps: [] });
    expect(browserErrors.errors).toEqual([]);
  } finally {
    const restored = await request.put("/api/settings", { data: { recordLmuOpponents: originalSettings.recordLmuOpponents } });
    expect(restored.ok()).toBe(true);
    if (fixture) {
      await removeFixture(request, fixture.sessionId);
      if (zipSessionIds.length) {
        const cleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: zipSessionIds } });
        expect(cleanup.ok(), "remove selected ZIP round-trip sessions").toBe(true);
      }
    }
  }
}

test.describe("LMU opponent comparison — desktop keyboard", () => {
  test("imports retained history with recording disabled and selects exact lap through shared replay", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await exerciseOpponentComparison(page, request);
  });
});

test.describe("LMU opponent comparison — mobile keyboard", () => {
  test("supports touch-sized viewport and keyboard selection", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await exerciseOpponentComparison(page, request);
  });
});
