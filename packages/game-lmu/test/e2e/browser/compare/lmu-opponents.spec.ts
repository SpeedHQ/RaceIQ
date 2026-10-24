import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { readFileSync } from "node:fs";
import { realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath } from "../../../support/fixtures";
import deMessages from "client/test-support/messages/de";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { OpponentLapCatalog, OpponentSemanticLapTelemetry } from "@raceiq/lap-replay/contracts";
import { startOpponentColdLoadServer, type OpponentColdLoadServer } from "../../../support/opponent-cold-load-server";
import { collectBrowserErrors } from "raceiq-e2e/test-support/browser-errors";

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
interface OpponentCatalog { sourceRevision: string; opponentRetention: string; indexState: "waiting-finalization" | "queued" | "building" | "ready" | "failed" | "not-required"; laps: OpponentSummary[] }
async function waitForCatalogState(
  request: APIRequestContext,
  playerLapId: number,
  state: OpponentLapCatalog["indexState"],
  appURL?: string,
): Promise<OpponentLapCatalog> {
  let latest: OpponentLapCatalog | undefined;
  const url = appURL ? new URL(`/api/laps/${playerLapId}/opponent-laps`, appURL).toString() : `/api/laps/${playerLapId}/opponent-laps`;
  await expect.poll(async () => {
    const response = await request.get(url, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    if (!response.ok()) throw new Error(`opponent catalog request: ${response.status()} ${await response.text()}`);
    latest = await response.json() as OpponentLapCatalog;
    return latest.indexState;
  }, { timeout: 120_000, intervals: [250, 500, 1_000, 2_000] }).toBe(state);
  return latest!;
}

async function waitForReadyCatalog(request: APIRequestContext, playerLapId: number, appURL?: string): Promise<OpponentLapCatalog> {
  return waitForCatalogState(request, playerLapId, "ready", appURL);
}
interface ImportedFixture { lap: LapMeta; sessionId: number }

async function importFixture(request: APIRequestContext, identity: string, capture = makeLmuOpponentCapture({ identity })): Promise<ImportedFixture> {
  const response = await request.post("/api/laps/import", {
    timeout: 120_000,
    multipart: {
      file: { name: `lmu-opponents-${identity}.bin.gz`, mimeType: "application/octet-stream", buffer: capture },
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
async function readLmuLapAt(request: APIRequestContext, appURL: string, lapId: number): Promise<LapMeta | undefined> {
  const response = await request.get(new URL("/api/laps?gameId=lmu", appURL).toString(), { timeout: 60_000 });
  expect(response.ok(), `read LMU lap metadata: ${await response.text()}`).toBe(true);
  return ((await response.json()) as LapMeta[]).find((lap) => lap.id === lapId);
}

async function waitForLmuLapReadyAt(request: APIRequestContext, appURL: string, lapId: number): Promise<LapMeta> {
  let latest: LapMeta | undefined;
  await expect.poll(async () => {
    latest = await readLmuLapAt(request, appURL, lapId);
    return latest?.processing.state ?? "missing";
  }, { timeout: 120_000, intervals: [250, 500, 1_000, 2_000] }).toBe("ready");
  return latest!;
}

async function startLiveOpponentCapture(
  cold: OpponentColdLoadServer,
  request: APIRequestContext,
  identity: string,
  opponents = true,
): Promise<{ sessionId: number; sourcePath: string; lap: LapMeta }> {
  await cold.startLmuOpponentCapture(identity, { opponents });
  await cold.feedLmuOpponentFrames();
  const capture = await cold.getLmuOpponentCaptureState();
  expect(capture.sessionId).not.toBeNull();
  expect(capture.lapIds.length).toBeGreaterThan(0);
  const sessionId = capture.sessionId!;
  const sourcePath = await cold.getLmuOpponentSessionSourcePath(sessionId);
  expect(sourcePath).toBeTruthy();
  const canonicalSourcePath = await realpath(sourcePath!);
  const lapId = capture.lapIds[0]!;
  let lap: LapMeta | undefined;
  await expect.poll(async () => {
    lap = await readLmuLapAt(request, cold.baseURL, lapId);
    return lap?.id ?? null;
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe(lapId);
  return { sessionId, sourcePath: canonicalSourcePath, lap: lap! };
}

async function finalizeLiveOpponentCapture(cold: OpponentColdLoadServer): Promise<void> {
  await cold.holdAt("direct-capture:before-final-seal");
  const finalizing = cold.finalizeLmuOpponentCapture();
  const barrier = await cold.waitForBarrier("direct-capture:before-final-seal");
  await cold.releaseBarrier(barrier.id);
  await finalizing;
}

function compareUrlForLap(baseURL: string, lap: LapMeta): string {
  const url = new URL("/lmu/compare", baseURL);
  url.searchParams.set("track", lap.trackId);
  url.searchParams.set("carA", lap.carId);
  url.searchParams.set("lapA", String(lap.id));
  url.searchParams.set("reference", "opponent");
  return url.toString();
}

function disableOpponentActions(page: Page) {
  return Promise.all([
    expect(page.locator("#compare-opponent-driver")).toBeDisabled(),
    expect(page.locator("#compare-opponent-lap")).toBeDisabled(),
    expect(page.getByRole("button", { name: "Lap compare", exact: true })).toBeDisabled(),
    expect(page.locator("[data-opponent-replay]")).toHaveCount(0),
    expect(page.getByTestId("opponent-comparison")).toHaveCount(0),
  ]);
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
    const catalog = await waitForReadyCatalog(request, lap.id) as OpponentCatalog;
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
    const restoredCatalog = await waitForReadyCatalog(request, restoredLaps[0]!.id);
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
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentLap")).toBeNull();
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
    expect(await strippedCatalog.json()).toMatchObject({ opponentRetention: "removed", opponentAvailability: null, indexState: "not-required", laps: [] });
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
async function exerciseRealOpponentSessions(page: Page, request: APIRequestContext): Promise<void> {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const identity = `pw-real-${crypto.randomUUID()}`;
  let fixture: ImportedFixture | null = null;
  try {
    const realCapture = readFileSync(fixturePath("sessions/lmu-real-opponents-2026-10-22.bin.gz"));
    fixture = await importFixture(request, identity, realCapture);
    const playerLapsResponse = await request.get("/api/laps?gameId=lmu");
    expect(playerLapsResponse.ok()).toBe(true);
    const playerLaps = await playerLapsResponse.json() as LapMeta[];
    const recordedLap = playerLaps.find((entry) => entry.sessionId === fixture!.sessionId && entry.lapNumber === 3);
    expect(recordedLap, "recorded player lap 3 spans the circuit; initial lap 2 starts mid-lap").toBeDefined();
    const lap = recordedLap!;
    const catalog = await waitForReadyCatalog(request, lap.id) as OpponentLapCatalog & { sessions: { opponentSessionId: string; sessionKey: string; vehicleId: number; incarnation: number; driverName: string | null; lapIds: string[] }[] };
    expect(catalog.opponentRetention).toBe("retained");
    expect(catalog.sessions.length).toBeGreaterThan(0);
    expect(catalog.sessions.every((session) => session.driverName !== "A Cooper#3593"), "source player is excluded").toBe(true);
    expect(new Set(catalog.sessions.map((session) => session.opponentSessionId)).size).toBe(catalog.sessions.length);
    expect(catalog.sessions.every((session) => session.lapIds.every((id) => catalog.laps.some((entry) => entry.opponentLapId === id)))).toBe(true);
    const candidate = catalog.laps.find((entry) => entry.mode === "telemetry" && entry.coverage === "partial");
    expect(candidate, "sparse source-backed comparison remains partial").toBeDefined();
    expect(catalog.laps.some((entry) => entry.validity === "unknown")).toBe(true);
    const session = catalog.sessions.find((entry) => entry.lapIds.includes(candidate!.opponentLapId));
    expect(session?.driverName).toBe("Monsieur PTITRAIN");
    expect(session?.vehicleId).toBe(16);
    expect(session?.vehicleId).not.toBe(54);
    expect(session?.incarnation).toBe(0);
    expect(session?.sessionKey).toBe("5371b669-f97a-4a38-b7ae-78e670d20e43:15");
    const repeated = await request.get(`/api/laps/${lap.id}/opponent-laps`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(repeated.ok()).toBe(true);
    expect((await repeated.json() as typeof catalog).sessions).toEqual(catalog.sessions);
    const semanticResponse = await request.get(`/api/laps/${lap.id}/opponent-laps/${candidate!.opponentLapId}/semantic-telemetry?sourceRevision=${encodeURIComponent(catalog.sourceRevision)}`, { timeout: 60_000, headers: { "X-Game-Id": "lmu" } });
    expect(semanticResponse.ok(), await semanticResponse.text()).toBe(true);
    const semantic = await semanticResponse.json() as OpponentSemanticLapTelemetry;
    expect(semantic.envelopes[0]?.receivedAt).toEqual({ domain: "wall-clock", milliseconds: 1792706591752 });
    expect(semantic.envelopes[0]?.values.find((value) => value.semanticId === "motion.position-x"))
      .toMatchObject({ state: "ok", value: -205.96434020996094 });
    expect(semantic.envelopes[1]?.values.find((value) => value.semanticId === "motion.position-x"))
      .toMatchObject({ state: "ok", value: -204.44955444335938 });
    expect(semantic.envelopes[0]?.values.find((value) => value.semanticId === "motion.speed")?.value).toBeCloseTo(66.98654314993927);
    expect(semantic.envelopes.every((value, index) => index === 0 || value.sequence > semantic.envelopes[index - 1]!.sequence)).toBe(true);
    expect(semantic.envelopes.some((value, index) => index > 0 && value.sequence > semantic.envelopes[index - 1]!.sequence + 1)).toBe(true);
    const comparison = await request.post(`/api/laps/${lap.id}/opponent-comparison`, {
      timeout: 60_000,
      headers: { "X-Game-Id": "lmu" },
      data: { opponentLapId: candidate!.opponentLapId, sourceRevision: catalog.sourceRevision, step: 1 },
    });
    expect(comparison.ok(), await comparison.text()).toBe(true);
    const compared = await comparison.json() as { opponent: OpponentSummary; traces: { semanticId: string; player: unknown[]; opponent: unknown[] }[] };
    expect(compared.opponent.opponentLapId).toBe(candidate!.opponentLapId);
    expect(compared.traces.map((trace) => trace.semanticId)).toEqual(expect.arrayContaining(["motion.position-x", "motion.position-z"]));
    expect(compared.traces.find((trace) => trace.semanticId === "motion.position-x")?.player).not.toEqual(compared.traces.find((trace) => trace.semanticId === "motion.position-x")?.opponent);
    await page.goto("/lmu/sessions", { waitUntil: "domcontentloaded" });
    const sessionRow = page.viewportSize()!.width < 600
      ? page.getByRole("button").filter({ hasText: "Bahrain Outer Circuit" }).first()
      : page.getByRole("row").filter({ hasText: "Bahrain Outer Circuit" }).first();
    await expect(sessionRow).toBeVisible();
    await sessionRow.click();
    await expect(page.locator('[data-testid="opponent-sessions"]:visible')).toBeVisible();
    await page.locator('[data-testid="opponent-player-lap"]:visible').selectOption(String(lap.id));
    const opponent = page.locator('[data-testid="opponent-session"]:visible').filter({ hasText: session!.driverName! }).first();
    await expect(opponent).toHaveAttribute("data-opponent-session-id", session!.opponentSessionId);
    const opponentLap = opponent.locator(`[data-testid="opponent-lap"][data-opponent-lap-id="${candidate!.opponentLapId}"]`);
    await expect(opponentLap).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("recorded-opponent-sessions.png"), fullPage: true });
    await opponentLap.getByRole("link", { name: /Compare/i }).click();
    await expect(page.getByTestId("lap-compare-workspace")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("lapA")).toBe(String(lap.id));
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentLap")).toBe(candidate!.opponentLapId);
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentRevision")).toBe(catalog.sourceRevision);
    await expect(page.getByTestId("opponent-comparison")).toContainText(session!.driverName!);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("opponent-comparison")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => new URL(page.url()).searchParams.get("opponentLap")).toBe(candidate!.opponentLapId);
    await expect(page.locator("[data-opponent-replay]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    await expect(page.getByText("Recorded replay could not be loaded.")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("recorded-opponent-comparison.png"), fullPage: true });
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (fixture) await removeFixture(request, fixture.sessionId);
  }
}

test("OS-E3 imports real recording and compares an individual opponent lap", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await exerciseRealOpponentSessions(page, request);
});

test("OS-E3 mobile imports real recording and compares an individual opponent lap", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await exerciseRealOpponentSessions(page, request);
});

test("[E7] U4 drives real opponent index states, visible polling, readiness, and status-only refresh", async ({ browser, request }) => {
  test.setTimeout(360_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-test-data-lmu-opponent-u4-"));
  const websocketConnections: Array<{ event: "opened" | "closed" | "error"; url: string; detail?: string }> = [];
  const websocketFrameDiagnostics: Array<{ kind: "text" | "binary"; byteLength: number; preview: string; classification: string }> = [];
  let onboardingCompleteFrameReceived = false;
  const opponentCatalogUpdates: Array<{ url: string }> = [];
  const heldBarriers = new Set<string>();
  let cold: OpponentColdLoadServer | null = null;
  const catalogReads = new Map<number, number[]>();
  page.on("websocket", (socket) => {
    const url = socket.url().slice(0, 500);
    const recordConnection = (event: "opened" | "closed" | "error", detail?: string) => {
      if (websocketConnections.length < 40) websocketConnections.push({ event, url, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    };
    recordConnection("opened");
    socket.on("close", () => recordConnection("closed"));
    socket.on("socketerror", (error) => recordConnection("error", error));
    socket.on("framereceived", (event) => {
      const payload: unknown = event && typeof event === "object" && "payload" in event ? event.payload : event;
      const isText = typeof payload === "string";
      const isBuffer = Buffer.isBuffer(payload);
      const bytes = isText ? Buffer.from(payload, "utf8") : isBuffer ? payload : Buffer.alloc(0);
      const frame = isText ? payload : "";
      let classification = isText ? "text" : isBuffer ? "binary:Buffer" : "binary:unsupported";
      if (isText) {
        try {
          const parsed: unknown = JSON.parse(frame);
          const type = parsed && typeof parsed === "object" && "type" in parsed && typeof parsed.type === "string"
            ? parsed.type
            : typeof parsed;
          classification = `json:${type}`;
        } catch {
          classification = "malformed-json";
        }
      }
      if (websocketFrameDiagnostics.length < 40) {
        const preview = isText
          ? frame.slice(0, 160).replace(/("(?:[^"\\]|\\.)*(?:token|secret|password|authorization|cookie|api[_-]?key)(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"<REDACTED>"').replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          : bytes.subarray(0, 24).toString("hex");
        websocketFrameDiagnostics.push({ kind: isText ? "text" : "binary", byteLength: bytes.length, preview, classification });
      }
      if (classification === "json:onboarding_complete") onboardingCompleteFrameReceived = true;
      if (isText && frame.includes("lmu-opponent-catalog-updated") && opponentCatalogUpdates.length < 10) {
        opponentCatalogUpdates.push({ url });
      }
    });
  });
  page.on("request", (browserRequest) => {
    const match = /^\/api\/laps\/(\d+)\/opponent-laps$/.exec(new URL(browserRequest.url()).pathname);
    if (match) {
      const lapId = Number(match[1]);
      const reads = catalogReads.get(lapId) ?? [];
      reads.push(Date.now());
      catalogReads.set(lapId, reads);
    }
  });
  const readCount = (lapId: number) => catalogReads.get(lapId)?.length ?? 0;
  try {
    cold = await startOpponentColdLoadServer({ dataDir });
    const onboarding = await request.put(new URL("/api/settings", cold.baseURL).toString(), { data: { onboardingComplete: true } });
    expect(onboarding.ok(), `complete isolated server onboarding: ${await onboarding.text()}`).toBe(true);
    const waitBarrier = async (name: string, sourcePath?: string) => {
      const barrier = await cold!.waitForBarrier(name, sourcePath ? { sourcePath } : undefined);
      heldBarriers.add(barrier.id);
      return barrier;
    };
    const releaseBarrier = async (id: string) => {
      await cold!.releaseBarrier(id);
      heldBarriers.delete(id);
    };
    const failBarrier = async (id: string) => {
      await cold!.failBarrier(id);
      heldBarriers.delete(id);
    };
    const populated = await startLiveOpponentCapture(cold, request, `u4-populated-${crypto.randomUUID()}`);
    const populatedUrl = compareUrlForLap(cold.baseURL, populated.lap);
    await page.goto(populatedUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-opponent-state="waiting-finalization"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-opponent-state="waiting-finalization"]')).toContainText("after recording ends");
    expect(await cold.isSessionActive()).toBe(true);
    const waitingReads = readCount(populated.lap.id);
    expect(waitingReads).toBeGreaterThan(0);
    await page.waitForTimeout(2_300);
    expect(readCount(populated.lap.id), "waiting-finalization must not poll").toBe(waitingReads);
    const baselineOnboarding = await request.put(new URL("/api/settings", cold.baseURL).toString(), { data: { onboardingComplete: true } });
    expect(baselineOnboarding.ok(), `trigger onboarding_complete WebSocket baseline: ${await baselineOnboarding.text()}`).toBe(true);
    await page.waitForTimeout(1_000);

    await cold.holdAt("source-discovery-complete");
    await cold.holdAt("admission-granted");
    await cold.holdAt("before-publication-fence");
    await finalizeLiveOpponentCapture(cold);
    const discovery = await waitBarrier("source-discovery-complete", populated.sourcePath);
    expect(discovery.sourcePath).toBe(populated.sourcePath);
    const queued = await waitForCatalogState(request, populated.lap.id, "queued", cold.baseURL);
    expect(queued.laps).toEqual([]);
    try {
      await expect(page.locator('[data-opponent-state="queued"]')).toBeVisible({ timeout: 30_000 });
    } catch (error) {
      throw new Error(
        `[E7] UI did not transition to queued after API reported queued. ` +
          `WebSocket connections: ${JSON.stringify(websocketConnections)}; ` +
          `onboarding_complete baseline frame received: ${onboardingCompleteFrameReceived}; ` +
          `received frame diagnostics (max 40; preview redacted/bounded): ${JSON.stringify(websocketFrameDiagnostics)}; ` +
          `opponent catalog frames (max 10): ${JSON.stringify(opponentCatalogUpdates)}; ` +
          `catalog requests: ${readCount(populated.lap.id)}; URL: ${populatedUrl}; ` +
          `DOM: ${JSON.stringify(await page.locator("body").innerText().catch(() => "<unavailable>"))}`,
        { cause: error },
      );
    }
    await disableOpponentActions(page);

    await releaseBarrier(discovery.id);
    const admission = await waitBarrier("admission-granted", populated.sourcePath);
    expect(admission.sourcePath).toBe(populated.sourcePath);
    const publicationFence = await Promise.race([
      waitBarrier("before-publication-fence", populated.sourcePath).then((barrier) => ({ barrier })),
      Promise.any([
        cold.waitForRuntimeEvent("worker-error", { sourcePath: populated.sourcePath }),
        cold.waitForRuntimeEvent("candidate-error", { sourcePath: populated.sourcePath }),
      ]).then((event) => {
        throw new Error(`[E7] ${event.type} before publication fence: ${JSON.stringify(event).slice(0, 4_000)}`);
      }),
      cold.waitForRuntimeEvent("worker-yielded", { sourcePath: populated.sourcePath }).then((event) => {
        throw new Error(`[E7] worker yielded before publication fence: ${JSON.stringify(event).slice(0, 4_000)}`);
      }),
    ]);
    expect(publicationFence.barrier.sourcePath).toBe(populated.sourcePath);
    await waitForCatalogState(request, populated.lap.id, "building", cold.baseURL);
    await expect(page.locator('[data-opponent-state="building"]')).toBeVisible({ timeout: 30_000 });
    await disableOpponentActions(page);

    const beforeVisiblePoll = readCount(populated.lap.id);
    await expect.poll(() => readCount(populated.lap.id), { timeout: 4_000, intervals: [100, 200, 400] }).toBeGreaterThan(beforeVisiblePoll);
    const firstVisiblePollAt = catalogReads.get(populated.lap.id)!.at(-1)!;
    const beforeSecondVisiblePoll = readCount(populated.lap.id);
    await expect.poll(() => readCount(populated.lap.id), { timeout: 4_000, intervals: [100, 200, 400] }).toBeGreaterThan(beforeSecondVisiblePoll);
    const secondVisiblePollAt = catalogReads.get(populated.lap.id)!.at(-1)!;
    expect(secondVisiblePollAt - firstVisiblePollAt).toBeGreaterThanOrEqual(1_700);
    expect(secondVisiblePollAt - firstVisiblePollAt).toBeLessThan(3_000);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenReads = readCount(populated.lap.id);
    await page.waitForTimeout(2_300);
    expect(readCount(populated.lap.id), "hidden mounted comparison must not poll").toBe(hiddenReads);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => readCount(populated.lap.id), { timeout: 4_000, intervals: [100, 200, 400] }).toBeGreaterThan(hiddenReads);

    const beforeNavigation = readCount(populated.lap.id);
    await page.goto(new URL("/lmu/sessions", cold.baseURL).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_300);
    expect(readCount(populated.lap.id), "unmounted comparison must stop polling").toBe(beforeNavigation);
    await page.goto(populatedUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-opponent-state="building"]')).toBeVisible({ timeout: 30_000 });
    await releaseBarrier(publicationFence.id);
    const readyCatalog = await waitForCatalogState(request, populated.lap.id, "ready", cold.baseURL);
    expect(readyCatalog.laps.length).toBeGreaterThan(0);
    const comparable = readyCatalog.laps.find((lap) => lap.mode === "telemetry" && lap.comparableSemanticIds.length > 0);
    expect(comparable, "real controlled capture should publish a selectable telemetry opponent").toBeDefined();
    await page.locator("#compare-opponent-driver").click();
    await page.getByRole("option").filter({ hasText: "Controlled opponent" }).first().click();
    await page.locator("#compare-opponent-lap").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Lap compare", exact: true }).click();
    await expect(page.getByTestId("opponent-comparison")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-opponent-replay]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const terminalReads = readCount(populated.lap.id);
    await page.waitForTimeout(2_300);
    expect(readCount(populated.lap.id), "ready catalog must stop polling").toBe(terminalReads);

    const empty = await startLiveOpponentCapture(cold, request, `u4-empty-${crypto.randomUUID()}`, false);
    await cold.holdAt("source-discovery-complete");
    await cold.holdAt("admission-granted");
    await cold.holdAt("before-publication-fence");
    await finalizeLiveOpponentCapture(cold);
    const emptyDiscovery = await waitBarrier("source-discovery-complete", empty.sourcePath);
    expect(emptyDiscovery.sourcePath).toBe(empty.sourcePath);
    await releaseBarrier(emptyDiscovery.id);
    const emptyAdmission = await waitBarrier("admission-granted", empty.sourcePath);
    expect(emptyAdmission.sourcePath).toBe(empty.sourcePath);
    await releaseBarrier(emptyAdmission.id);
    const emptyFence = await waitBarrier("before-publication-fence", empty.sourcePath);
    expect(emptyFence.sourcePath).toBe(empty.sourcePath);
    await releaseBarrier(emptyFence.id);
    const emptyCatalog = await waitForCatalogState(request, empty.lap.id, "ready", cold.baseURL);
    expect(emptyCatalog.laps).toEqual([]);
    await page.goto(compareUrlForLap(cold.baseURL, empty.lap), { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-opponent-state="ready-empty"]')).toBeVisible({ timeout: 30_000 });
    await disableOpponentActions(page);
    const emptyReads = readCount(empty.lap.id);
    await page.waitForTimeout(2_300);
    expect(readCount(empty.lap.id), "ready-empty catalog must stop polling").toBe(emptyReads);

    const failed = await startLiveOpponentCapture(cold, request, `u4-failed-${crypto.randomUUID()}`);
    await cold.holdAt("source-discovery-complete");
    await cold.holdAt("admission-granted");
    await cold.holdAt("before-publication-fence");
    await finalizeLiveOpponentCapture(cold);
    const failedDiscovery = await waitBarrier("source-discovery-complete", failed.sourcePath);
    expect(failedDiscovery.sourcePath).toBe(failed.sourcePath);
    await releaseBarrier(failedDiscovery.id);
    const failedAdmission = await waitBarrier("admission-granted", failed.sourcePath);
    expect(failedAdmission.sourcePath).toBe(failed.sourcePath);
    await releaseBarrier(failedAdmission.id);
    const failedFence = await waitBarrier("before-publication-fence", failed.sourcePath);
    expect(failedFence.sourcePath).toBe(failed.sourcePath);
    await page.goto(compareUrlForLap(cold.baseURL, failed.lap), { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-opponent-state="building"]')).toBeVisible({ timeout: 30_000 });
    await failBarrier(failedFence.id);
    await waitForCatalogState(request, failed.lap.id, "failed", cold.baseURL);
    await expect(page.locator('[data-opponent-state="failed"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-opponent-state="failed"]')).toContainText("preparation failed");
    await disableOpponentActions(page);
    const failedReads = readCount(failed.lap.id);
    await page.waitForTimeout(2_300);
    expect(readCount(failed.lap.id), "failed catalog must wait for explicit refresh").toBe(failedReads);
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect.poll(() => readCount(failed.lap.id), { timeout: 5_000, intervals: [100, 200, 400] }).toBe(failedReads + 1);
    const refreshedStatus = await request.get(new URL(`/api/laps/${failed.lap.id}/opponent-laps`, cold.baseURL).toString(), { headers: { "X-Game-Id": "lmu" } });
    expect(refreshedStatus.ok()).toBe(true);
    expect(await refreshedStatus.json()).toMatchObject({ indexState: "failed", laps: [] });
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (cold) {
      for (const barrierId of heldBarriers) {
        try { await cold.releaseBarrier(barrierId); } catch {}
      }
    }
    await context.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("OS-E4 lists only comparable opponent laps and retains timing-only drivers", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fixture = await importFixture(request, `pw-filter-${crypto.randomUUID()}`);
  try {
    const catalog = await waitForReadyCatalog(request, fixture.lap.id);
    const available = catalog.laps.filter((lap) => lap.mode !== "unavailable");
    expect(catalog.laps.some((lap) => lap.mode === "unavailable")).toBe(true);
    expect(available.some((lap) => lap.coverage === "partial")).toBe(true);
    expect(available.some((lap) => lap.lapTime.value === 18)).toBe(true);
    const params = new URLSearchParams({ track: fixture.lap.trackId!, carA: fixture.lap.carId!, lapA: String(fixture.lap.id) });
    await page.goto(`/lmu/compare?${params}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Opponents", exact: true }).click();
    const driverSelect = page.locator("#compare-opponent-driver");
    await expect(driverSelect).toBeEnabled();
    await driverSelect.click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option")).toContainText("Controlled opponent");
    await page.getByRole("option").click();
    const lapSelect = page.locator("#compare-opponent-lap");
    await lapSelect.click();
    await expect(page.getByRole("option")).toHaveCount(available.length);
    await expect(page.getByRole("option", { disabled: true })).toHaveCount(0);
    await expect(page.getByRole("option").filter({ hasText: "Partial" })).toBeVisible();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Lap compare", exact: true }).click();
    await expect(page.getByTestId("opponent-comparison")).toContainText("Controlled opponent");
    expect(available.map((lap) => lap.opponentLapId)).toContain(new URL(page.url()).searchParams.get("opponentLap"));
    await page.screenshot({ path: test.info().outputPath("comparable-opponent-laps.png"), fullPage: true });
  } finally {
    await removeFixture(request, fixture.sessionId);
  }
});

test("OS-E2 preserves all 15 recorded opponents as individual session records", async ({ page, request }) => {
  test.setTimeout(120_000);
  const capture = readFileSync(fixturePath("sessions/lmu-real-opponents-grid-2026-10-22.bin.gz"));
  const fixture = await importFixture(request, `pw-real-grid-${crypto.randomUUID()}`, capture);
  try {
    const catalog = await waitForReadyCatalog(request, fixture.lap.id);
    expect(catalog.sessions.map((entry) => entry.vehicleId).sort((a, b) => a - b))
      .toEqual([16, 17, 18, 20, 22, 24, 30, 32, 34, 35, 37, 47, 50, 51, 53]);
    expect(catalog.sessions.find((entry) => entry.vehicleId === 16)?.driverName).toBe("Monsieur PTITRAIN");
    expect(catalog.sessions.find((entry) => entry.vehicleId === 17)?.driverName).toBe("cleverson santos");
    for (const session of catalog.sessions) {
      expect(session.sessionKey).toBe("5371b669-f97a-4a38-b7ae-78e670d20e43:1");
      expect(session.lapIds).toEqual(catalog.laps.filter((lap) => lap.vehicleId === session.vehicleId && lap.incarnation === session.incarnation).map((lap) => lap.opponentLapId));
    }
    await page.goto("/lmu/sessions", { waitUntil: "domcontentloaded" });
    await page.getByRole("row").filter({ hasText: "Bahrain Outer Circuit" }).first().click();
    await page.locator('[data-testid="opponent-player-lap"]:visible').selectOption(String(fixture.lap.id));
    await expect(page.locator('[data-testid="opponent-session"]:visible')).toHaveCount(15);
    await expect(page.locator('[data-testid="opponent-session"]:visible').filter({ hasText: "cleverson santos" })).toContainText("#17/0");
    await expect(page.locator('[data-testid="opponent-session"]:visible').filter({ hasText: "A Cooper#3593" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("recorded-opponent-grid.png"), fullPage: true });
    expect(catalog.laps.every((entry) => entry.mode === "unavailable"), "grid snapshot has no comparable laps").toBe(true);
    const params = new URLSearchParams({ track: fixture.lap.trackId!, carA: fixture.lap.carId!, lapA: String(fixture.lap.id) });
    await page.goto(`/lmu/compare?${params}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Opponents", exact: true }).click();
    await expect(page.locator("#compare-opponent-driver")).toBeDisabled();
    await expect(page.locator("#compare-opponent-lap")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Lap compare", exact: true })).toBeDisabled();
    await page.locator("#compare-opponent-class").click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.locator("#compare-opponent-class").press("Escape");
    await page.screenshot({ path: test.info().outputPath("no-comparable-opponents.png"), fullPage: true });
  } finally {
    await removeFixture(request, fixture.sessionId);
  }
});


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