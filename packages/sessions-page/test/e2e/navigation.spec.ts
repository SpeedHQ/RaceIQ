import { expect, test, type Page } from "@playwright/test";
import Database from "libsql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { makeLmuOpponentCapture } from "../../../game-lmu/src/test-support/opponents";
import { collectBrowserErrors } from "../../../../playwright/tests/support/browser-errors"
import { lapsFor, sessionRows, sessionsFor } from "../../../../playwright/tests/support/session-fixtures";
import {
  readLmuOpponentColdLoadIdentity,
  seedLmuOpponentColdLoadData,
  startOpponentColdLoadServer,
} from "../../../game-lmu/test/support/opponent-cold-load-server";

function seedAccTrackLapReadiness(dataDir: string) {
  const database = new Database(join(dataDir, "app.db"));
  try {
    const readySessionId = Number(database.prepare(
      "INSERT INTO sessions(car_id,track_id,game_id,session_type) VALUES(?,?,?,?)",
    ).run("fixture-car", "20", "acc", "practice").lastInsertRowid);
    const insertLap = database.prepare(
      "INSERT INTO laps(session_id,lap_number,lap_time,is_valid,pi) VALUES(?,?,?,1,0)",
    );
    let olderReadyLapId = 0;
    for (let lapNumber = 1; lapNumber <= 201; lapNumber += 1) {
      const result = insertLap.run(readySessionId, lapNumber, 80 + lapNumber / 100);
      if (lapNumber === 1) olderReadyLapId = Number(result.lastInsertRowid);
    }

    const queuedSessionId = Number(database.prepare(
      "INSERT INTO sessions(car_id,track_id,game_id,session_type,raw_file) VALUES(?,?,?,?,?)",
    ).run("fixture-car", "20", "acc", "practice", join(dataDir, "queued-track-capture.bin")).lastInsertRowid);
    const queuedLapId = Number(insertLap.run(queuedSessionId, 1, 90).lastInsertRowid);
    database.prepare(`
      INSERT INTO session_capture_split_jobs(
        session_id,job_id,pending_source_revision,source_path,status,error_message
      ) VALUES(?,?,?,?, 'queued', NULL)
    `).run(
      queuedSessionId,
      crypto.randomUUID(),
      "queued-track-fixture-v1",
      join(dataDir, "queued-track-capture.bin"),
    );
    return { olderReadyLapId, queuedLapId };
  } finally {
    database.close();
  }
}



test("sessions sort laps and compare selected seeded laps", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const targetSessionIndex = sessions.findIndex((session) => laps.filter((lap) => lap.sessionId === session.id && lap.isValid).length >= 2);
  expect(targetSessionIndex, "seeded session with two valid laps").toBeGreaterThanOrEqual(0);
  expect(targetSessionIndex, "two-lap seeded session must be on first page").toBeLessThan(25);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const first = (await sessionRows(page)).nth(targetSessionIndex);
  await first.click();
  const lapTable = page.locator("[data-slot='table-container'] table").last();
  await expect(lapTable.getByRole("columnheader", { name: "Time" })).toBeVisible();
  await expect(lapTable.getByRole("button", { name: "Replay", exact: true }).first()).toBeVisible();
  await expect(lapTable.getByRole("columnheader", { name: /^S\d+$/ }).first()).toBeVisible();
  await expect(lapTable.getByRole("button", { name: /Add note/ }).first()).toBeVisible();
  const lapSort = lapTable.getByRole("columnheader", { name: /Lap/ }).getByRole("button");
  const previousOrder = await lapTable.locator("tr").filter({ has: page.getByRole("button", { name: "Replay", exact: true }) }).allTextContents();
  await lapSort.focus();
  await page.keyboard.press("Enter");
  await expect(lapSort.locator("..")).toHaveAttribute("aria-sort", /ascending|descending/);
  const nextOrder = await lapTable.locator("tr").filter({ has: page.getByRole("button", { name: "Replay", exact: true }) }).allTextContents();
  expect(nextOrder).not.toEqual(previousOrder);
  const lapRows = page.locator("tbody tbody tr").filter({ has: page.getByRole("button", { name: "Replay", exact: true }) });
  await expect(lapRows.nth(0)).toBeVisible();
  await expect(lapRows.nth(1)).toBeVisible();
  await lapRows.nth(0).getByRole("checkbox").check();
  await lapRows.nth(1).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Compare 2 laps", exact: true }).click();
  await expect(page).toHaveURL(/\/fm23\/compare\?/);
  expect(browserErrors.errors).toEqual([]);
});

test("replaying an available seeded lap opens analysis and AI panel", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const replayTarget = sessions.slice(0, 25).flatMap((session, sessionIndex) => {
    const visibleLaps = laps
      .filter((lap) => lap.sessionId === session.id)
      .sort((left, right) => right.lapNumber - left.lapNumber)
      .slice(0, 15);
    const lapIndex = visibleLaps.findIndex((lap) => lap.isValid && lap.telemetryAvailable && (lap.rawFrameCount ?? 0) > 0);
    return lapIndex < 0 ? [] : [{ sessionIndex, lapIndex, lap: visibleLaps[lapIndex]! }];
  })[0];
  expect(replayTarget, "visible seeded lap with available telemetry").toBeDefined();
  if (!replayTarget) throw new Error("No visible seeded lap with available telemetry");

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await (await sessionRows(page)).nth(replayTarget.sessionIndex).click();
  await page
    .locator("tbody tbody tr")
    .filter({ has: page.getByRole("button", { name: "Replay", exact: true }) })
    .nth(replayTarget.lapIndex)
    .getByRole("button", { name: "Replay", exact: true })
    .click();
  await expect(page).toHaveURL(`/fm23/sessions/${replayTarget.lap.sessionId}/replay/${replayTarget.lap.id}`);
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();
  expect(browserErrors.errors).toEqual([]);
});

test("[E9] session and lap opening stays blocked through queued, processing, failure, and recovery", async ({ page, request }) => {
  test.setTimeout(15 * 60 * 1000);
  const browserErrors = collectBrowserErrors(page);
  let dataDir: string | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  let listPage: Page | undefined;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "raceiq-test-data-e9-opponent-"));
    await seedLmuOpponentColdLoadData(dataDir);
    const seededIdentity = readLmuOpponentColdLoadIdentity(dataDir);
    const trackFixture = seedAccTrackLapReadiness(dataDir);
    const server = await startOpponentColdLoadServer({
      dataDir,
      holdAt: ["source-discovery-complete", "admission-granted", "before-publication-fence"],
    });
    stopServer = server.stop;
    const baseURL = server.baseURL;
    const appOrigin = new URL(baseURL).origin;
    const routeListRequests: string[] = [];
    const listPageRequests: string[] = [];
    const heavyReads: string[] = [];
    const isMetadataList = (url: URL) =>
      url.origin === appOrigin &&
      url.searchParams.get("gameId") === "lmu" &&
      (url.pathname === "/api/sessions" || url.pathname === "/api/laps");
    const isHeavyLapRead = (url: URL) =>
      url.origin === appOrigin &&
      /^\/api\/laps\/(?:aligned-telemetry|compare-line-spread|\d+\/(?:semantic-telemetry|insights|opponent-comparison|opponent-semantic-telemetry))$/.test(url.pathname);
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      if (browserRequest.method() === "GET" && isMetadataList(url)) routeListRequests.push(url.pathname);
      if (isHeavyLapRead(url)) heavyReads.push(url.pathname);
    });

    const latestAccLapsResponse = await request.get(`${baseURL}/api/laps?gameId=acc`);
    expect(latestAccLapsResponse.ok(), "ACC latest-200 lap metadata").toBe(true);
    const latestAccLaps = await latestAccLapsResponse.json() as { id: number }[];
    expect(latestAccLaps).toHaveLength(200);
    expect(latestAccLaps.some((lap) => lap.id === trackFixture.olderReadyLapId)).toBe(false);
    const trackLapsResponse = await request.get(`${baseURL}/api/tracks/20/all-laps?gameId=acc`);
    expect(trackLapsResponse.ok(), "real track all-laps metadata").toBe(true);
    const trackLaps = await trackLapsResponse.json() as {
      lapId: number;
      processing: { state: string; stage: string | null; error: string | null };
    }[];
    expect(trackLaps).toHaveLength(202);
    expect(trackLaps.find((lap) => lap.lapId === trackFixture.olderReadyLapId)?.processing)
      .toEqual({ state: "ready", stage: null, error: null });
    expect(trackLaps.find((lap) => lap.lapId === trackFixture.queuedLapId)?.processing)
      .toEqual({ state: "queued", stage: "capture", error: null });
    await page.goto(`${baseURL}/acc/tracks/20/laps`, { waitUntil: "domcontentloaded" });
    const classificationNotice = page.getByRole("dialog", { name: "Historical lap classification" });
    if (await classificationNotice.isVisible()) {
      await classificationNotice.getByRole("button", { name: "Close", exact: true }).click();
    }
    await expect(classificationNotice).toBeHidden();
    const olderReadyTrackRow = page.getByTestId(`track-lap-${trackFixture.olderReadyLapId}`);
    const queuedTrackRow = page.getByTestId(`track-lap-${trackFixture.queuedLapId}`);
    await expect(olderReadyTrackRow).toHaveAttribute("aria-busy", "false");
    await expect(olderReadyTrackRow.getByRole("button", { name: "Replay", exact: true })).toBeEnabled();
    await expect(queuedTrackRow).toHaveAttribute("aria-busy", "true");
    await expect(queuedTrackRow.getByText("Queued for processing…", { exact: true })).toBeVisible();
    await expect(queuedTrackRow.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
    await olderReadyTrackRow.getByRole("checkbox").check();
    await queuedTrackRow.getByRole("checkbox").check();
    await expect(page.getByRole("button", { name: /^Compare$/i }).last()).toBeDisabled();

    const captureIdentity = `opening-gates-${crypto.randomUUID()}`;
    const importResponse = await request.post(`${baseURL}/api/laps/import`, {
      timeout: 120_000,
      multipart: {
        file: {
          name: `${captureIdentity}.bin.gz`,
          mimeType: "application/octet-stream",
          buffer: makeLmuOpponentCapture({ identity: captureIdentity }),
        },
        ownership: "mine",
      },
    });
    expect(importResponse.ok(), `controlled LMU import: ${await importResponse.text()}`).toBe(true);
    const imported = await importResponse.json() as { laps?: { lapId: number; sessionId: number }[] };
    const importedLaps = imported.laps ?? [];
    expect(importedLaps.length, "controlled capture provides comparison laps").toBeGreaterThanOrEqual(2);
    const sessionIds = [...new Set(importedLaps.map((lap) => lap.sessionId))];
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0]!;
    const lapId = importedLaps[0]!.lapId;
    const comparisonLapId = importedLaps[1]!.lapId;
    const analysisPath = `/lmu/sessions/${sessionId}/analyse`;
    const replayPath = `/lmu/sessions/${sessionId}/replay/${lapId}`;
    const comparisonPath = `/lmu/compare?lapA=${lapId}&lapB=${comparisonLapId}`;

    const getSessions = async () => {
      const response = await request.get(`${baseURL}/api/sessions?gameId=lmu`);
      expect(response.ok(), "LMU session metadata").toBe(true);
      return await response.json() as SessionMeta[];
    };
    const getLaps = async () => {
      const response = await request.get(`${baseURL}/api/laps?gameId=lmu`);
      expect(response.ok(), "LMU lap metadata").toBe(true);
      return await response.json() as LapMeta[];
    };
    await server.waitForBarrier("source-discovery-complete");
    await expect.poll(async () => (await getSessions()).find((session) => session.id === sessionId)?.processing.state, {
      timeout: 30_000,
      interval: 250,
    }).toBe("queued");
    await expect.poll(async () => (await getLaps()).find((lap) => lap.id === lapId)?.processing.state, {
      timeout: 30_000,
      interval: 250,
    }).toBe("queued");
    expect((await getSessions()).find((session) => session.id === seededIdentity.ready.sessionId)?.processing.state)
      .toBe("ready");

    listPage = await page.context().newPage();
    const listBrowserErrors = collectBrowserErrors(listPage);
    listPage.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      if (browserRequest.method() === "GET" && isMetadataList(url)) listPageRequests.push(url.pathname);
      if (isHeavyLapRead(url)) heavyReads.push(url.pathname);
    });
    await listPage.goto(`${baseURL}/lmu/sessions`, { waitUntil: "domcontentloaded" });
    const queuedRows = sessionRows(listPage).filter({ has: listPage.getByText("Queued for processing…", { exact: true }) });
    await expect(queuedRows).toHaveCount(1);
    await expect(queuedRows.first()).toBeVisible();
    const queuedSessionRow = queuedRows.first();
    await expect(queuedSessionRow).toHaveAttribute("aria-disabled", "true");
    await expect(queuedSessionRow.getByRole("button", { name: "Analyse Session", exact: true })).toBeDisabled();
    await queuedSessionRow.dispatchEvent("click");
    await expect(queuedSessionRow).not.toHaveAttribute("data-state", "selected");


    let mainFrameNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations += 1;
    });
    const heavyReadsBefore = heavyReads.length;
    await page.goto(`${baseURL}${analysisPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Queued for processing…", { exact: true })).toBeVisible();
    await page.goto(`${baseURL}${replayPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Queued for processing…", { exact: true })).toBeVisible();
    await page.goto(`${baseURL}${comparisonPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Queued for processing…", { exact: true })).toBeVisible();
    expect(heavyReads.slice(heavyReadsBefore), "blocked routes do not start heavy lap reads").toEqual([]);
    await page.goto(`${baseURL}${analysisPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Queued for processing…", { exact: true })).toBeVisible();

    await listPage.bringToFront();
    const visibleListRequestCount = listPageRequests.length;
    await expect.poll(() => listPageRequests.length, { timeout: 4_000, interval: 100 })
      .toBeGreaterThan(visibleListRequestCount);
    await page.bringToFront();
    await expect.poll(() => listPage.evaluate(() => document.visibilityState)).toBe("hidden");
    const hiddenListRequestCount = listPageRequests.length;
    await listPage.waitForTimeout(2_300);
    expect(listPageRequests).toHaveLength(hiddenListRequestCount);
    await listPage.bringToFront();
    await expect.poll(() => listPageRequests.length, { timeout: 4_000, interval: 100 })
      .toBeGreaterThan(hiddenListRequestCount);
    await page.bringToFront();

    const routePollBaseline = routeListRequests.length;
    await expect.poll(() => routeListRequests.length, { timeout: 4_000, interval: 100 })
      .toBeGreaterThan(routePollBaseline);
    await page.goto(`${baseURL}/lmu/cars`, { waitUntil: "domcontentloaded" });
    const exitedRouteRequestCount = routeListRequests.length;
    await page.waitForTimeout(2_300);
    expect(routeListRequests).toHaveLength(exitedRouteRequestCount);
    await page.goto(`${baseURL}${analysisPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Queued for processing…", { exact: true })).toBeVisible();
    const transitionNavigationCount = mainFrameNavigations;

    await server.releaseBarrier("source-discovery-complete");
    await server.waitForBarrier("admission-granted");
    await expect.poll(async () => (await getSessions()).find((session) => session.id === sessionId)?.processing.state, {
      timeout: 30_000,
      interval: 250,
    }).toBe("processing");
    await expect(page.getByText("Processing…", { exact: true })).toBeVisible();
    expect(mainFrameNavigations).toBe(transitionNavigationCount);
    await server.releaseBarrier("admission-granted");
    await server.waitForBarrier("before-publication-fence");
    await server.failBarrier("before-publication-fence");
    await expect.poll(async () => (await getSessions()).find((session) => session.id === sessionId)?.processing.state, {
      timeout: 30_000,
      interval: 250,
    }).toBe("failed");
    const failedMetadata = (await getSessions()).find((session) => session.id === sessionId);
    expect(failedMetadata?.processing.state).toBe("failed");
    const failedError = failedMetadata?.processing.state === "failed" ? failedMetadata.processing.error : "Failed processing error unavailable";
    await expect(page.getByText(failedError, { exact: true })).toBeVisible();
    await expect(page.getByText("Processing…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Refresh/ })).toBeVisible();

    await listPage.bringToFront();
    const failedRows = sessionRows(listPage).filter({ has: listPage.getByText(failedError, { exact: true }) });
    await expect(failedRows).toHaveCount(1);
    const terminalListRequestCount = listPageRequests.length;
    await listPage.waitForTimeout(2_300);
    expect(listPageRequests).toHaveLength(terminalListRequestCount);
    await page.bringToFront();

    const recovery = server.reconcile();
    const discoveryBarrier = await server.waitForBarrier("source-discovery-complete");
    await server.releaseBarrier(discoveryBarrier.id);
    const admissionBarrier = await server.waitForBarrier("admission-granted");
    await server.releaseBarrier(admissionBarrier.id);
    const publicationBarrier = await server.waitForBarrier("before-publication-fence");
    await expect.poll(async () => (await getSessions()).find((session) => session.id === sessionId)?.processing.state, {
      timeout: 30_000,
      interval: 250,
    }).toBe("processing");
    await expect(page.getByText("Processing…", { exact: true })).toBeVisible();
    await server.releaseBarrier(publicationBarrier.id);
    await recovery;
    await expect.poll(async () => (await getSessions()).find((session) => session.id === sessionId)?.processing.state, {
      timeout: 60_000,
      interval: 500,
    }).toBe("ready");
    await expect(page.getByText("Processing…", { exact: true })).toHaveCount(0);
    await expect.poll(() => heavyReads.filter((path) => path === "/api/laps/aligned-telemetry").length, {
      timeout: 30_000,
      interval: 250,
    }).toBeGreaterThan(0);
    expect(mainFrameNavigations).toBe(transitionNavigationCount);

    await page.goto(`${baseURL}${replayPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => heavyReads.some((path) => path.endsWith("/semantic-telemetry")), {
      timeout: 30_000,
      interval: 250,
    }).toBe(true);
    expect(browserErrors.errors).toEqual([]);
    expect(listBrowserErrors.errors).toEqual([]);
  } finally {
    try {
      await listPage?.close();
    } finally {
      try {
        await stopServer?.();
      } finally {
        if (dataDir) await rm(dataDir, { recursive: true, force: true });
      }
    }
  }
});
