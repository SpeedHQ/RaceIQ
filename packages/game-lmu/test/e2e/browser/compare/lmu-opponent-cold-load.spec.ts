import { expect, test, type Browser, type Page, type Request, type Response } from "@playwright/test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { performance } from "node:perf_hooks";
import { LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS } from "@raceiq/tooling-data/data/seed-db-options";
import {
  readLmuOpponentColdLoadIdentity,
  seedLmuOpponentColdLoadData,
  startOpponentColdLoadServer,
  type ColdLoadMetrics,
  type OpponentColdLoadServer,
  type SeededLmuOpponentIdentity,
} from "../../../support/opponent-cold-load-server";

const REPO_ROOT = resolve(process.cwd());
const CATALOG_LIMIT_MS = 200;
const COMPARISON_LIMIT_MS = 2_000;

type TimedResponse = {
  response: Response;
  requestStartedAt: number;
  responseReceivedAt: number;
};
type ResponseWatch = {
  response: Promise<TimedResponse>;
  dispose(): void;
};
type CdpMetric = { name: string; value: number };
type CdpSession = {
  send(method: "Performance.getMetrics"): Promise<{ metrics: CdpMetric[] }>;
  send(method: "Performance.enable"): Promise<unknown>;
  detach(): Promise<void>;
};
type CdpSnapshot = { startedAt: number; metrics: CdpMetric[] };
type PhaseEvidence = {
  requestToResponseMs: number;
  requestToPlayableUiMs: number;
  responseBytes: number;
  status: number;
  backend: ColdLoadMetrics;
  browser: { taskDurationMs: number | null; scriptDurationMs: number | null; measurementWindowMs: number };
};

function watchResponse(page: Page, matches: (request: Request) => boolean): ResponseWatch {
  const result = Promise.withResolvers<TimedResponse>();
  let requestStartedAt: number | undefined;
  let settled = false;
  const onRequest = (request: Request) => {
    if (requestStartedAt === undefined && matches(request)) requestStartedAt = performance.now();
  };
  const onResponse = (response: Response) => {
    if (settled || !matches(response.request()) || requestStartedAt === undefined) return;
    settled = true;
    result.resolve({ response, requestStartedAt, responseReceivedAt: performance.now() });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    response: result.promise,
    dispose() {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

async function newCdpSession(page: Page): Promise<CdpSession> {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  return session;
}

async function browserCpu(session: CdpSession, before: { startedAt: number; metrics: CdpMetric[] }, endedAt: number) {
  const after = await session.send("Performance.getMetrics");
  const value = (metrics: CdpMetric[], name: string) => metrics.find((metric) => metric.name === name)?.value;
  const delta = (name: string): number | null => {
    const from = value(before.metrics, name);
    const to = value(after.metrics, name);
    return from === undefined || to === undefined ? null : (to - from) * 1000;
  };
  return {
    taskDurationMs: delta("TaskDuration"),
    scriptDurationMs: delta("ScriptDuration"),
    measurementWindowMs: endedAt - before.startedAt,
  };
}

async function cdpSnapshot(session: CdpSession): Promise<CdpSnapshot> {
  return { startedAt: performance.now(), metrics: (await session.send("Performance.getMetrics")).metrics };
}

function routePath(request: Request): string {
  return new URL(request.url()).pathname;
}

async function finishEvidence(
  watch: ResponseWatch,
  uiCompleteAt: number,
  backend: ColdLoadMetrics,
  cdp: CdpSession,
  browserBefore: CdpSnapshot,
): Promise<PhaseEvidence & { response: Response }> {
  const timed = await watch.response;
  const body = await timed.response.body();
  const browser = await browserCpu(cdp, browserBefore, uiCompleteAt);
  return {
    response: timed.response,
    requestToResponseMs: timed.responseReceivedAt - timed.requestStartedAt,
    requestToPlayableUiMs: uiCompleteAt - timed.requestStartedAt,
    responseBytes: body.byteLength,
    status: timed.response.status(),
    backend,
    browser,
  };
}

async function openContext(browser: Browser) {
  return browser.newContext({ viewport: { width: 1440, height: 900 } });
}

function compareUrl(identity: SeededLmuOpponentIdentity, opponentLapId?: string, sourceRevision?: string): string {
  const params = new URLSearchParams({ track: identity.trackId, carA: identity.carId, lapA: String(identity.lapId) });
  if (opponentLapId && sourceRevision) {
    params.set("reference", "opponent");
    params.set("opponentLap", opponentLapId);
    params.set("opponentRevision", sourceRevision);
  }
  return `/lmu/compare?${params}`;
}

async function capturePageErrors(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message));
}

async function measuredCatalog(browser: Browser, dataDir: string, identity: SeededLmuOpponentIdentity, evidence: Record<string, unknown>) {
  const server = await startOpponentColdLoadServer({ dataDir });
  const context = await openContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  await capturePageErrors(page, errors);
  const startupMetrics = await server.snapshotMetrics();
  const cdp = await newCdpSession(page);
  const watch = watchResponse(page, (request) => request.method() === "GET" && routePath(request) === `/api/laps/${identity.lapId}/opponent-laps`);
  let responseEvidence: Awaited<ReturnType<typeof finishEvidence>> | undefined;
  try {
    await page.goto(`${server.baseURL}${compareUrl(identity)}`, { waitUntil: "domcontentloaded" });
    const opponents = page.getByRole("button", { name: "Opponents", exact: true });
    await expect(opponents).toBeVisible();
    const browserBefore = await cdpSnapshot(cdp);
    await server.resetMetrics();
    await opponents.click();
    const catalogSelect = page.getByRole("combobox", { name: "Recorded opponent lap" });
    await expect(catalogSelect).toBeEnabled({ timeout: 60_000 });
    const readyAt = performance.now();
    const backend = await server.snapshotMetrics();
    responseEvidence = await finishEvidence(watch, readyAt, backend, cdp, browserBefore);
    expect(responseEvidence.response.ok(), "real production catalog response").toBe(true);
    const catalog = await responseEvidence.response.json() as {
      sourceRevision: string;
      opponentRetention: string;
      indexState?: string;
      laps: { opponentLapId: string; mode: string; coverage: string; validity: string }[];
    };
    expect(catalog.opponentRetention).toBe("retained");
    const candidate = catalog.laps.find((lap) =>
      lap.opponentLapId === identity.opponentLapId && lap.mode === "telemetry" && lap.coverage === "complete",
    );
    expect(candidate, "seed-selected complete opponent interval must be usable through production catalog").toBeDefined();
    expect(responseEvidence.requestToPlayableUiMs).toBeLessThanOrEqual(CATALOG_LIMIT_MS);
    expect(responseEvidence.backend.index.sourceFramesScanned, "catalog must not scan native source frames").toBe(0);
    expect(responseEvidence.backend.index.playerPacketsDecoded, "catalog must not decode player telemetry packets").toBe(0);
    expect(responseEvidence.backend.index.fullPacketsMaterialized).toBe(0);
    expect(responseEvidence.backend.index.blocksRead, "catalog reads summary metadata, not interval blocks").toBe(0);
    expect(errors).toEqual([]);
    evidence.catalog = {
      thresholdMs: CATALOG_LIMIT_MS,
      startupMetrics,
      ...responseEvidence,
      response: undefined,
      indexState: catalog.indexState ?? null,
      candidate: {
        opponentLapId: candidate!.opponentLapId,
        coverage: candidate!.coverage,
        validity: candidate!.validity,
        mode: candidate!.mode,
      },
      browserErrors: errors,
    };
    return { candidate: candidate!, sourceRevision: catalog.sourceRevision, evidence: evidence.catalog };
  } finally {
    watch.dispose();
    await cdp.detach();
    await context.close();
    await server.stop();
  }
}

async function measuredComparison(
  browser: Browser,
  dataDir: string,
  identity: SeededLmuOpponentIdentity,
  opponentLapId: string,
  sourceRevision: string,
  seedMetrics: { blocksWritten: number; observations: number },
  evidence: Record<string, unknown>,
) {
  const server = await startOpponentColdLoadServer({ dataDir });
  const context = await openContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  await capturePageErrors(page, errors);
  const startupMetrics = await server.snapshotMetrics();
  const cdp = await newCdpSession(page);
  const watch = watchResponse(page, (request) => request.method() === "POST" && routePath(request) === `/api/laps/${identity.lapId}/opponent-comparison`);
  try {
    await server.resetMetrics();
    const browserBefore = await cdpSnapshot(cdp);
    await page.goto(`${server.baseURL}${compareUrl(identity, opponentLapId, sourceRevision)}`, { waitUntil: "domcontentloaded" });
    const workspace = page.getByTestId("lap-compare-workspace");
    const comparisonPanel = page.getByTestId("opponent-comparison");
    await expect(workspace).toBeVisible();
    await expect(comparisonPanel).toBeVisible({ timeout: 60_000 });
    const scene = page.locator("[data-spectate-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const canvas = scene.locator("canvas").first();
    for (const side of ["a", "b"] as const) {
      await expect.poll(async () => Number(await canvas.getAttribute(`data-${side}-racing-line-segments`))).toBeGreaterThan(0);
    }
    await expect(page.getByRole("region", { name: "Driver input comparison" })).toBeVisible();
    const readyAt = performance.now();
    const backend = await server.snapshotMetrics();
    const result = await finishEvidence(watch, readyAt, backend, cdp, browserBefore);
    expect(result.response.ok(), "real production comparison response").toBe(true);
    const body = await result.response.json() as { traces: { semanticId: string; player: unknown[]; opponent: unknown[] }[] };
    expect(body.traces.length).toBeGreaterThan(0);
    expect(body.traces.map((trace) => trace.semanticId)).toContain("motion.position-x");
    expect(result.requestToPlayableUiMs).toBeLessThanOrEqual(COMPARISON_LIMIT_MS);
    expect(result.backend.index.sourceFramesScanned, "comparison uses prepared index, not native full scan").toBe(0);
    expect(result.backend.index.blocksRead).toBeGreaterThan(0);
    expect(result.backend.index.blocksRead).toBeLessThan(seedMetrics.blocksWritten);
    expect(result.backend.index.bytesRead).toBeGreaterThan(0);
    expect(result.backend.index.framesDecoded).toBeGreaterThan(0);
    expect(result.backend.index.framesDecoded).toBeLessThan(seedMetrics.observations);
    expect(errors).toEqual([]);
    evidence.comparison = {
      thresholdMs: COMPARISON_LIMIT_MS,
      startupMetrics,
      ...result,
      response: undefined,
      selectedBlocksOnly: true,
      browserErrors: errors,
    };
    return evidence.comparison;
  } finally {
    watch.dispose();
    await cdp.detach();
    await context.close();
    await server.stop();
  }
}

async function measuredOpponentReplay(
  browser: Browser,
  dataDir: string,
  identity: SeededLmuOpponentIdentity,
  opponentLapId: string,
  sourceRevision: string,
  seedMetrics: { blocksWritten: number; observations: number },
  evidence: Record<string, unknown>,
) {
  const server = await startOpponentColdLoadServer({ dataDir });
  const context = await openContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  await capturePageErrors(page, errors);
  const startupMetrics = await server.snapshotMetrics();
  const cdp = await newCdpSession(page);
  const ownWatch = watchResponse(page, (request) => request.method() === "GET" && routePath(request) === `/api/laps/${identity.lapId}/semantic-telemetry`);
  const opponentWatch = watchResponse(page, (request) => request.method() === "GET" && routePath(request) === `/api/laps/${identity.lapId}/opponent-laps/${opponentLapId}/semantic-telemetry`);
  try {
    await server.resetMetrics();
    const browserBefore = await cdpSnapshot(cdp);
    await page.goto(`${server.baseURL}${compareUrl(identity, opponentLapId, sourceRevision)}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("opponent-comparison")).toBeVisible({ timeout: 60_000 });
    const scene = page.locator("[data-spectate-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const canvas = scene.locator("canvas").first();
    for (const side of ["a", "b"] as const) {
      await expect.poll(async () => Number(await canvas.getAttribute(`data-${side}-racing-line-segments`))).toBeGreaterThan(0);
    }
    await expect(page.getByRole("region", { name: "Driver input comparison" })).toBeVisible();
    await expect(page.locator('[data-spectate-workspace] [data-pedal="inputs.brake"]').first()).toBeVisible();
    const clock = page.locator("[data-spectate-playback]");
    await expect(clock).toBeVisible();
    const play = page.getByRole("button", { name: "Play replay", exact: true });
    await play.click();
    await expect(clock).toHaveAttribute("data-playing", "true");
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause replay", exact: true }).click();
    const readyAt = performance.now();
    const [ownResult, opponentResult] = await Promise.all([ownWatch.response, opponentWatch.response]);
    const backend = await server.snapshotMetrics();
    const [ownBytes, opponentBytes] = await Promise.all([ownResult.response.body(), opponentResult.response.body()]);
    const browser = await browserCpu(cdp, browserBefore, readyAt);
    const ownEvidence = {
      requestToResponseMs: ownResult.responseReceivedAt - ownResult.requestStartedAt,
      requestToPlayableUiMs: readyAt - ownResult.requestStartedAt,
      responseBytes: ownBytes.byteLength,
      status: ownResult.response.status(),
    };
    const opponentEvidence = {
      requestToResponseMs: opponentResult.responseReceivedAt - opponentResult.requestStartedAt,
      requestToPlayableUiMs: readyAt - opponentResult.requestStartedAt,
      responseBytes: opponentBytes.byteLength,
      status: opponentResult.response.status(),
    };
    expect(ownResult.response.ok(), "real player semantic telemetry response").toBe(true);
    expect(opponentResult.response.ok(), "real selected opponent semantic telemetry response").toBe(true);
    expect(opponentEvidence.requestToPlayableUiMs).toBeLessThanOrEqual(COMPARISON_LIMIT_MS);
    expect(backend.index.sourceFramesScanned).toBe(0);
    expect(backend.index.blocksRead).toBeGreaterThan(0);
    expect(backend.index.blocksRead).toBeLessThan(seedMetrics.blocksWritten);
    expect(backend.index.bytesRead).toBeGreaterThan(0);
    expect(backend.index.framesDecoded).toBeGreaterThan(0);
    expect(backend.index.framesDecoded).toBeLessThan(seedMetrics.observations);
    expect(errors).toEqual([]);
    evidence.opponentReplay = {
      thresholdMs: COMPARISON_LIMIT_MS,
      startupMetrics,
      ownLap: ownEvidence,
      opponentLap: opponentEvidence,
      backend,
      browser,
      sceneReady: await scene.getAttribute("data-scene-ready"),
      racingLineSegments: {
        a: await canvas.getAttribute("data-a-racing-line-segments"),
        b: await canvas.getAttribute("data-b-racing-line-segments"),
      },
      instruments: { driverInputRegion: true, brakePedal: true },
      browserErrors: errors,
    };
    return { evidence: evidence.opponentReplay, ownLap: ownEvidence };
  } finally {
    ownWatch.dispose();
    opponentWatch.dispose();
    await cdp.detach();
    await context.close();
    await server.stop();
  }
}

async function measuredOwnLapReplay(browser: Browser, dataDir: string, identity: SeededLmuOpponentIdentity, evidence: Record<string, unknown>) {
  const server = await startOpponentColdLoadServer({ dataDir });
  const context = await openContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  await capturePageErrors(page, errors);
  const startupMetrics = await server.snapshotMetrics();
  const cdp = await newCdpSession(page);
  const watch = watchResponse(page, (request) => request.method() === "GET" && routePath(request) === `/api/laps/${identity.lapId}/semantic-telemetry`);
  try {
    await server.resetMetrics();
    const browserBefore = await cdpSnapshot(cdp);
    await page.goto(`${server.baseURL}/lmu/sessions/${identity.sessionId}/replay/${identity.lapId}`, { waitUntil: "domcontentloaded" });
    const scene = page.locator("[data-spectate-scene]");
    await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
    const clock = page.locator("[data-spectate-playback]");
    await expect(clock).toBeVisible();
    await expect(page.getByRole("region", { name: "Inputs", exact: true })).toBeVisible();
    await expect(page.locator('[data-spectate-workspace] [data-pedal="inputs.brake"]').first()).toBeVisible();
    const canvas = scene.locator("canvas").first();
    await expect.poll(async () => Number(await canvas.getAttribute("data-a-racing-line-segments"))).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Play replay", exact: true }).click();
    await expect(clock).toHaveAttribute("data-playing", "true");
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause replay", exact: true }).click();
    const readyAt = performance.now();
    const backend = await server.snapshotMetrics();
    const result = await finishEvidence(watch, readyAt, backend, cdp, browserBefore);
    expect(result.response.ok(), "real player semantic telemetry response").toBe(true);
    expect(errors).toEqual([]);
    evidence.ownLapReplay = {
      startupMetrics,
      ...result,
      response: undefined,
      instruments: { inputRegion: true, brakePedal: true },
      browserErrors: errors,
    };
    return evidence.ownLapReplay;
  } finally {
    watch.dispose();
    await cdp.detach();
    await context.close();
    await server.stop();
  }
}

test("[E2] cold-load real LMU opponent catalog, comparison, and playable replay", async ({ browser }) => {
  test.skip(process.env.RACEIQ_RUN_LMU_OPPONENT_COLD_LOAD !== "1", "opt-in: set RACEIQ_RUN_LMU_OPPONENT_COLD_LOAD=1");
  test.setTimeout(20 * 60 * 1000);
  const dataDir = await mkdtemp(join(tmpdir(), "raceiq-test-data-lmu-opponent-cold-load-"));
  const evidencePath = test.info().outputPath("lmu-opponent-cold-load-evidence.json");
  const evidence: Record<string, unknown> = {
    acceptance: { catalogMs: CATALOG_LIMIT_MS, comparisonAndReplayMs: COMPARISON_LIMIT_MS },
    executionMode: "source-runtime+dist-public-static-proxy",
    assetMode: "already-built dist/public; no build executed by benchmark",
    cacheScope: "fresh backend process and browser context per scenario; OS page cache not flushed or claimed cold",
    sourceFixture: LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS[0],
    fixtureParts: [],
    fixtureBytes: 0,
  };
  try {
    const fixtureParts = await Promise.all(LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS.map(async (path) => ({ path, bytes: (await stat(resolve(REPO_ROOT, path))).size })));
    evidence.fixtureParts = fixtureParts;
    evidence.fixtureBytes = fixtureParts.reduce((total, part) => total + part.bytes, 0);
    const seed = await seedLmuOpponentColdLoadData(dataDir);
    const identity = await readLmuOpponentColdLoadIdentity(dataDir);
    evidence.seed = {
      ...seed,
      identity,
      importMode: "real fixture through seed-db.ts; awaited index reconciliation",
      sourceFramesScannedScope: "seed-import parser + player-lap-fact collection + index build; request metrics use restarted backend counters",
    };

    const catalog = await measuredCatalog(browser, dataDir, identity.target, evidence);
    const seedMetrics = { blocksWritten: seed.instrumentation.blocksWritten, observations: seed.instrumentation.indexSamplesMaterialized };
    await measuredComparison(browser, dataDir, identity.target, catalog.candidate.opponentLapId, catalog.sourceRevision, seedMetrics, evidence);
    const replay = await measuredOpponentReplay(browser, dataDir, identity.target, catalog.candidate.opponentLapId, catalog.sourceRevision, seedMetrics, evidence);
    const ownLap = await measuredOwnLapReplay(browser, dataDir, identity.target, evidence) as PhaseEvidence & { response?: unknown };
    const opponentTiming = (replay.evidence as { opponentLap: { requestToPlayableUiMs: number } }).opponentLap.requestToPlayableUiMs;
    const ownTiming = (ownLap as unknown as { requestToPlayableUiMs: number }).requestToPlayableUiMs;
    evidence.matchedOwnLapComparison = {
      samePlayerLapId: identity.target.lapId,
      opponentReplayUiMs: opponentTiming,
      ownLapReplayUiMs: ownTiming,
      deltaMs: opponentTiming - ownTiming,
      ratio: ownTiming > 0 ? opponentTiming / ownTiming : null,
      cacheScope: "separate process; same dataDir and app/runtime mode; OS cache uncontrolled",
    };
    evidence.completedAt = new Date().toISOString();
  } finally {
    try {
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      await test.info().attach("lmu-opponent-cold-load-evidence", { path: evidencePath, contentType: "application/json" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
