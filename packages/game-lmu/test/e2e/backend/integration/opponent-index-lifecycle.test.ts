import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const E5_CHILD = String.raw`
import { createHash } from "node:crypto";
const { initDb, closeDb } = await import("@raceiq/backend-core/db/index");
await initDb();
let runtime;
let channel;
let intentionalPause = false;
try {
  const { initGameAdapters } = await import("@raceiq/game-catalogs/games/init");
  const { registerServerGame } = await import("@raceiq/backend-core/games/registry");
  const { lmuServerAdapter } = await import("@raceiq/game-lmu");
  // Load the feature after database initialization in this isolated child.
  const { registerRaceStrategyFeature } = await import("@raceiq/race-strategy/server");
  initGameAdapters();
  registerRaceStrategyFeature();
  registerServerGame(lmuServerAdapter);
  runtime = await import("@raceiq/backend-core/session-capture/lmu-opponent-index-runtime");
  const instrumentation = await import("@raceiq/backend-core/session-capture/test-instrumentation");
  instrumentation.enableLmuOpponentIndexInstrumentation(true);
  instrumentation.resetLmuOpponentIndexInstrumentation();
  const { getLapReplaySource } = await import("@raceiq/backend-core/db/telemetry-replay-storage");
  const { replayRoutes } = await import("@raceiq/lap-replay/server");
let lapId;

  const phase = process.env.E5_PHASE;
  let stagingBarrierPromise;
  let resolveStagingBarrier;
  if (phase === "interrupt-staging") {
    ({ promise: stagingBarrierPromise, resolve: resolveStagingBarrier } = Promise.withResolvers());
  }


  if (phase === "interrupt-staging") {
    const { MessageChannel } = await import("node:worker_threads");
    channel = new MessageChannel();
    runtime.setLmuOpponentIndexTestPortForTest(channel.port1);
    const targetName = "before-publication-fence";
    channel.port2.on("message", (event) => {
      if (event.type === "worker-error" || event.type === "candidate-error") {
        process.stdout.write("__E5_" + (event.type === "worker-error" ? "WORKER" : "CANDIDATE") + "_ERROR__" + JSON.stringify(event) + "\n");
        return;
      }
      if (event.type !== "barrier") return;
      if (event.name === targetName) resolveStagingBarrier(event);
      else channel.port2.postMessage({ type: "release", id: event.id });
    });
    channel.port2.start();
    const { makeLmuOpponentCapture } = await import("@raceiq/game-lmu/test-support/opponents");
    const { importSessionBin } = await import("@raceiq/backend-core/session-capture/import-capture");
    const capture = makeLmuOpponentCapture({ identity: "e5-staging-restart" });
    process.stdout.write("__E5_IMPORT_STARTED__" + JSON.stringify({ bytes: capture.byteLength }) + "\n");
    const imported = await importSessionBin(capture, "lmu", {
      notifyDriverProfile: false,
      opponentRetention: "retained",
    });
    process.stdout.write("__E5_IMPORT_COMPLETED__" + JSON.stringify({ laps: imported.laps.length }) + "\n");
    lapId = imported.laps[0]?.lapId;
    if (!lapId) throw new Error("Import did not persist a player lap");
    instrumentation.resetLmuOpponentIndexInstrumentation();
  } else {
    lapId = Number(process.env.E5_LAP_ID);
    if (!Number.isSafeInteger(lapId) || lapId <= 0) throw new Error("Restart phase requires E5_LAP_ID");
  }

  const replaySource = await getLapReplaySource(lapId);
  if (!replaySource) throw new Error("Missing imported player lap " + lapId);
  const source = { ...replaySource, rawFile: replaySource.captureManifestFile ?? replaySource.rawFile };
  if (!source.rawFile) throw new Error("Imported source has no finalized native path");
  const sourcePath = source.rawFile;

  if (phase === "interrupt-staging") {
    const preBuildResponse = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    const preBuildCatalog = await preBuildResponse.json();
    const beforeHttpMetrics = instrumentation.getLmuOpponentIndexInstrumentation();
    process.stdout.write("__E5_HTTP_PENDING__" + JSON.stringify({
      lapId, sourcePath, status: preBuildResponse.status, catalog: preBuildCatalog,
      metrics: beforeHttpMetrics,
    }) + "\n");

    const targetName = "before-publication-fence";
    const preparation = runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });

    const barrier = await Promise.race([stagingBarrierPromise, preparation.then(
      () => {
        const error = new Error("Preparation completed before target barrier " + targetName);
        process.stdout.write("__E5_PREPARATION_COMPLETED_EARLY__" + JSON.stringify({
          phase, targetName, error: error.message,
          metrics: instrumentation.getLmuOpponentIndexInstrumentation(),
        }) + "\n");
        throw error;
      },
      (error) => {
        process.stdout.write("__E5_PREPARATION_FAILED__" + JSON.stringify({
          phase, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          metrics: instrumentation.getLmuOpponentIndexInstrumentation(),
        }) + "\n");
        throw error;
      },
    )]);
    const status = await runtime.getLmuOpponentIndexStatus(source);
    const blockedResponse = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    const blockedCatalog = await blockedResponse.json();
    process.stdout.write("__E5_INTERRUPTED__" + JSON.stringify({
      lapId, sourcePath, barrierName: barrier.name, status: status.indexState,
      publicationPath: status.publicationPath,
      catalog: { status: blockedResponse.status, body: blockedCatalog },
      metrics: instrumentation.getLmuOpponentIndexInstrumentation(),
    }) + "\n");
    intentionalPause = true;
    await new Promise(() => {});
    await preparation;
  }


  if (phase === "interrupt-publication") {
    const { MessageChannel } = await import("node:worker_threads");
    const { promise, resolve } = Promise.withResolvers();
    channel = new MessageChannel();
    runtime.setLmuOpponentIndexTestPortForTest(channel.port1);
    const targetName = "before-publication-reference-swap";
    channel.port2.on("message", (event) => {
      if (event.type !== "barrier") return;
      if (event.name === targetName) resolve(event);
      else channel.port2.postMessage({ type: "release", id: event.id });
    });
    channel.port2.start();
    const preparation = runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
    const barrier = await Promise.race([promise, preparation.then(
      () => new Promise(() => {}),
      (error) => {
        process.stdout.write("__E5_PREPARATION_FAILED__" + JSON.stringify({
          phase, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          metrics: instrumentation.getLmuOpponentIndexInstrumentation(),
        }) + "\n");
        throw error;
      },
    )]);
    const status = await runtime.getLmuOpponentIndexStatus(source);
    const response = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    process.stdout.write("__E5_PUBLICATION_BARRIER__" + JSON.stringify({
      lapId, sourcePath, barrierName: barrier.name, status: status.indexState,
      publicationPath: status.publicationPath,
      catalog: { status: response.status, body: await response.json() },
    }) + "\n");
    intentionalPause = true;
    await new Promise(() => {});
    await preparation;
  }

  if (phase === "inspect-identity") {
    const status = await runtime.getLmuOpponentIndexStatus(source);
    const response = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    process.stdout.write("__E5_IDENTITY__" + JSON.stringify({
      indexState: status.indexState, publicationPath: status.publicationPath,
      catalog: { status: response.status, body: await response.json() },
      metrics: instrumentation.getLmuOpponentIndexInstrumentation(),
    }) + "\n");
  }

  if (phase === "recover") {
    const nativeBytesBefore = await Bun.file(sourcePath).arrayBuffer();
    const nativeHashBefore = createHash("sha256").update(Buffer.from(nativeBytesBefore)).digest("hex");
    const firstReconcile = await runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
    const firstStatus = await runtime.getLmuOpponentIndexStatus(source);
    const firstResponse = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    const firstCatalog = await firstResponse.json();
    const firstMetrics = instrumentation.getLmuOpponentIndexInstrumentation();
    const secondReconcile = await runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
    const secondStatus = await runtime.getLmuOpponentIndexStatus(source);
    const secondMetrics = instrumentation.getLmuOpponentIndexInstrumentation();
    const selectedLap = firstCatalog.laps?.[0];
    if (!selectedLap) throw new Error("Rebuilt opponent catalog has no selectable interval");
    const selectedReplayResponse = await replayRoutes.request(
      "/api/laps/" + lapId + "/opponent-laps/" + encodeURIComponent(selectedLap.opponentLapId) +
        "/semantic-telemetry?sourceRevision=" + encodeURIComponent(firstCatalog.sourceRevision),
      { headers: { "X-Game-Id": "lmu" } },
    );
    const selectedReplay = await selectedReplayResponse.json();
    const comparisonResponse = await replayRoutes.request("/api/laps/" + lapId + "/opponent-comparison", {
      method: "POST",
      headers: { "X-Game-Id": "lmu", "Content-Type": "application/json" },
      body: JSON.stringify({ opponentLapId: selectedLap.opponentLapId, sourceRevision: firstCatalog.sourceRevision, step: 1 }),
    });
    const comparison = await comparisonResponse.json();
    const nativeHashAfter = createHash("sha256").update(Buffer.from(await Bun.file(sourcePath).arrayBuffer())).digest("hex");
    process.stdout.write("__E5_RECOVERED__" + JSON.stringify({
      lapId, sourcePath, firstReconcile, secondReconcile,
      firstState: firstStatus.indexState, secondState: secondStatus.indexState,
      firstPublicationPath: firstStatus.publicationPath,
      secondPublicationPath: secondStatus.publicationPath,
      catalog: { status: firstResponse.status, body: firstCatalog },
      firstMetrics, secondMetrics, selectedReplay: { status: selectedReplayResponse.status, body: selectedReplay },
      comparison: { status: comparisonResponse.status, body: comparison },
      nativeHashBefore, nativeHashAfter, postRequestMetrics: instrumentation.getLmuOpponentIndexInstrumentation(),
    }) + "\n");
  }

  if (phase === "failed-write") {
    let reconcileError = null;
    try { await runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true }); }
    catch (error) { reconcileError = error instanceof Error ? error.message : String(error); }
    const status = await runtime.getLmuOpponentIndexStatus(source);
    const catalogResponse = await replayRoutes.request("/api/laps/" + lapId + "/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    const catalog = await catalogResponse.json();
    const comparisonResponse = await replayRoutes.request("/api/laps/" + lapId + "/opponent-comparison", {
      method: "POST",
      headers: { "X-Game-Id": "lmu", "Content-Type": "application/json" },
      body: JSON.stringify({ opponentLapId: "e5-failure-probe", sourceRevision: catalog.sourceRevision, step: 1 }),
    });
    process.stdout.write("__E5_FAILED_WRITE__" + JSON.stringify({
      indexState: status.indexState, publicationPath: status.publicationPath, error: status.error,
      reconcileError,
      catalog: { status: catalogResponse.status, body: catalog },
      comparison: { status: comparisonResponse.status, body: await comparisonResponse.json() },
    }) + "\n");
  }
} finally {
  if (!intentionalPause) {
    if (channel) channel.port2.close();
    if (runtime) await runtime.stopLmuOpponentIndexRuntime();
    await closeDb();
  }
  }
`;

interface ChildHandle {
  process: ChildProcess;
  output(): string;
  waitForLine(prefix: string): Promise<string>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startChild(dataDir: string, phase: string, lapId?: number): ChildHandle {
  const child = spawn(process.execPath, ["-e", E5_CHILD], {
    cwd: join(process.cwd(), "apps/backend"),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      RACEIQ_TEST_MODE: "1",
      E5_PHASE: phase,
      ...(lapId === undefined ? {} : { E5_LAP_ID: String(lapId) }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiters = new Map<string, Array<{ resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>>();
  let allOutput = "";
  const stdout = createInterface({ input: child.stdout! });
  stdout.on("line", (line) => {
    lines.push(line);
    allOutput += `${line}\n`;
    for (const [prefix, pending] of waiters) {
      if (!line.startsWith(prefix)) continue;
      const waiter = pending.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
      if (!pending.length) waiters.delete(prefix);
      break;
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { allOutput += String(chunk); });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const failWaiters = () => {
    for (const pending of waiters.values()) for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Child exited before expected output; output:\n${allOutput}`));
    }
    waiters.clear();
  };
  child.once("exit", failWaiters);
  return {
    process: child,
    output: () => allOutput,
    waitForLine(prefix) {
      const existing = lines.find((line) => line.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = waiters.get(prefix);
          const index = pending?.findIndex((waiter) => waiter.timer === timer) ?? -1;
          if (index >= 0) pending!.splice(index, 1);
          if (pending && !pending.length) waiters.delete(prefix);
          reject(new Error(`Timed out waiting for ${prefix}; output:\n${allOutput}`));
        }, 120_000);
        const pending = waiters.get(prefix) ?? [];
        pending.push({ resolve, reject, timer });
        waiters.set(prefix, pending);
      });
    },
    waitForExit: () => exitPromise,
  };
}

function parseLine<T>(line: string, prefix: string): T {
  return JSON.parse(line.slice(prefix.length)) as T;
}

async function stopChild(handle: ChildHandle, signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (handle.process.exitCode === null && handle.process.signalCode === null) handle.process.kill(signal);
  return handle.waitForExit();
}

test("LMU opponent restart repairs interrupted staging/publication and exposes failure without HTTP preparation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "raceiq-opponent-index-e5-"));
  let child: ChildHandle | null = null;
  try {
    child = startChild(dataDir, "interrupt-staging");
    const pending = parseLine<{
      lapId: number; sourcePath: string; status: number; catalog: { indexState: string; sessions: unknown[]; laps: unknown[] };
      metrics: { sourceFramesScanned: number; blocksWritten: number };
    }>(await child.waitForLine("__E5_HTTP_PENDING__"), "__E5_HTTP_PENDING__");
    expect(pending.lapId).toBeGreaterThan(0);
    expect(pending.status).toBe(200);
    expect(pending.catalog).toMatchObject({ indexState: "queued", sessions: [], laps: [] });
    expect(pending.metrics).toMatchObject({ sourceFramesScanned: 0, blocksWritten: 0 });

    const staging = parseLine<{
      lapId: number; sourcePath: string; barrierName: string; status: string; publicationPath: string | null;
      catalog: { status: number; body: { indexState: string; sessions: unknown[]; laps: unknown[] } };
    }>(await child.waitForLine("__E5_INTERRUPTED__"), "__E5_INTERRUPTED__");
    expect(staging.barrierName).toBe("before-publication-fence");
    expect(staging.status).toBe("building");
    expect(staging.publicationPath).toBeNull();
    expect(staging.catalog).toMatchObject({
      status: 200,
      body: { indexState: "building", sessions: [], laps: [] },
    });
    const indexRoot = `${staging.sourcePath}.opponent-index`;
    const interruptedState = JSON.parse(readFileSync(join(indexRoot, "state.json"), "utf8")) as {
      indexState: string; publicationPath: string | null;
    };
    expect(interruptedState).toMatchObject({ indexState: "building", publicationPath: null });
    expect(readdirSync(indexRoot).some((entry) => entry.startsWith(".staging-"))).toBe(true);
    expect(await stopChild(child, "SIGKILL")).toMatchObject({ code: null, signal: "SIGKILL" });
    child = null;

    child = startChild(dataDir, "recover", staging.lapId);
    const recovered = parseLine<{
      firstPublicationPath: string | null; secondPublicationPath: string | null;
      catalog: { status: number; body: { indexState: string; sourceRevision: string; sessions: unknown[]; laps: { opponentLapId: string }[] } };
      firstMetrics: { sourceFramesScanned: number; parserStatePrimes: number; indexSamplesMaterialized: number; blocksWritten: number };
      secondMetrics: { sourceFramesScanned: number; parserStatePrimes: number; indexSamplesMaterialized: number; blocksWritten: number };
      selectedReplay: { status: number; body: { envelopes: { sequence: number; values: { semanticId: string; value: unknown }[] }[] } };
      comparison: { status: number; body: { opponent: { opponentLapId: string }; traces: { semanticId: string; opponent: unknown[] }[] } };
      nativeHashBefore: string; nativeHashAfter: string;
      postRequestMetrics: {
        sourceFramesScanned: number; parserStatePrimes: number; indexSamplesMaterialized: number;
        fullPacketsMaterialized: number; blocksWritten: number;
      };
    }>(await child.waitForLine("__E5_RECOVERED__"), "__E5_RECOVERED__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(recovered).toMatchObject({
      firstReconcile: "ready", secondReconcile: "ready", firstState: "ready", secondState: "ready",
      catalog: { status: 200, body: { indexState: "ready" } },
    });
    expect(recovered.firstPublicationPath).toBeTruthy();
    expect(recovered.secondPublicationPath).toBe(recovered.firstPublicationPath);
    expect(recovered.catalog.body.sessions.length).toBeGreaterThan(0);
    expect(recovered.catalog.body.laps.length).toBeGreaterThan(0);
    expect(recovered.firstMetrics.sourceFramesScanned).toBeGreaterThan(0);
    expect(recovered.firstMetrics.blocksWritten).toBeGreaterThan(0);
    expect(recovered.secondMetrics.sourceFramesScanned).toBe(recovered.firstMetrics.sourceFramesScanned);
    expect(recovered.secondMetrics.blocksWritten).toBe(recovered.firstMetrics.blocksWritten);
    expect(recovered.selectedReplay.status).toBe(200);
    expect(recovered.selectedReplay.body.envelopes.length).toBeGreaterThan(0);
    expect(recovered.selectedReplay.body.envelopes.some((envelope) =>
      envelope.sequence >= 0 && envelope.values.some((value) => value.semanticId.length > 0 && value.value !== undefined),
    )).toBe(true);
    expect(recovered.comparison.status).toBe(200);
    expect(recovered.comparison.body.opponent.opponentLapId).toBe(recovered.catalog.body.laps[0]!.opponentLapId);
    expect(recovered.comparison.body.traces.length).toBeGreaterThan(0);
    expect(recovered.comparison.body.traces.some((trace) => trace.opponent.length > 0)).toBe(true);
    expect(recovered.nativeHashAfter).toBe(recovered.nativeHashBefore);
    expect(recovered.postRequestMetrics.sourceFramesScanned).toBe(recovered.secondMetrics.sourceFramesScanned);
    expect(recovered.postRequestMetrics).toMatchObject({
      parserStatePrimes: recovered.secondMetrics.parserStatePrimes,
      indexSamplesMaterialized: recovered.secondMetrics.indexSamplesMaterialized,
      blocksWritten: recovered.secondMetrics.blocksWritten,
    });
    expect(recovered.postRequestMetrics.fullPacketsMaterialized).toBeGreaterThan(0);
    const originalPublicationPath = recovered.firstPublicationPath!;
    child = startChild(dataDir, "recover", staging.lapId);
    const reusedPublication = parseLine<{
      firstState: string; firstPublicationPath: string | null;
      firstMetrics: { sourceFramesScanned: number; blocksWritten: number };
    }>(await child.waitForLine("__E5_RECOVERED__"), "__E5_RECOVERED__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(reusedPublication.firstState).toBe("ready");
    expect(reusedPublication.firstPublicationPath).toBe(originalPublicationPath);
    expect(reusedPublication.firstMetrics).toMatchObject({ sourceFramesScanned: 0, blocksWritten: 0 });
    const statePath = join(`${staging.sourcePath}.opponent-index`, "state.json");
    const matchingStateBytes = readFileSync(statePath);
    const mismatchedState = JSON.parse(matchingStateBytes.toString("utf8")) as Record<string, unknown>;
    mismatchedState.sourceRevision = "e5-nonmatching-source-revision";
    try {
      writeFileSync(statePath, JSON.stringify(mismatchedState));
      child = startChild(dataDir, "inspect-identity", staging.lapId);
      const hiddenPublication = parseLine<{
        indexState: string; publicationPath: string | null;
        catalog: { status: number; body: { indexState: string; sessions: unknown[]; laps: unknown[] } };
        metrics: { sourceFramesScanned: number; blocksWritten: number };
      }>(await child.waitForLine("__E5_IDENTITY__"), "__E5_IDENTITY__");
      expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
      child = null;
      expect(hiddenPublication).toMatchObject({
        indexState: "queued", publicationPath: null,
        catalog: { status: 200, body: { indexState: "queued", sessions: [], laps: [] } },
        metrics: { sourceFramesScanned: 0, blocksWritten: 0 },
      });
    } finally {
      if (child) {
        await stopChild(child, "SIGKILL");
        child = null;
      }
      writeFileSync(statePath, matchingStateBytes);
    }
    child = startChild(dataDir, "inspect-identity", staging.lapId);
    const matchingPublication = parseLine<{
      indexState: string; publicationPath: string | null; catalog: { body: { indexState: string } };
    }>(await child.waitForLine("__E5_IDENTITY__"), "__E5_IDENTITY__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(matchingPublication).toMatchObject({
      indexState: "ready", publicationPath: originalPublicationPath, catalog: { body: { indexState: "ready" } },
    });

    const incompatible = JSON.parse(readFileSync(originalPublicationPath, "utf8")) as Record<string, unknown>;
    incompatible.algorithmVersion = 1;
    writeFileSync(originalPublicationPath, JSON.stringify(incompatible));
    child = startChild(dataDir, "inspect-identity", staging.lapId);
    const obsoletePublication = parseLine<{
      indexState: string; publicationPath: string | null;
      catalog: { status: number; body: { indexState: string; sessions: unknown[]; laps: unknown[] } };
      metrics: { sourceFramesScanned: number; blocksWritten: number };
    }>(await child.waitForLine("__E5_IDENTITY__"), "__E5_IDENTITY__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(obsoletePublication).toMatchObject({
      indexState: "queued", publicationPath: null,
      catalog: { status: 200, body: { indexState: "queued", sessions: [], laps: [] } },
      metrics: { sourceFramesScanned: 0, blocksWritten: 0 },
    });


    child = startChild(dataDir, "interrupt-publication", staging.lapId);
    const publication = parseLine<{
      lapId: number; sourcePath: string; barrierName: string; status: string; publicationPath: string | null;
      catalog: { status: number; body: { indexState: string; sessions: unknown[]; laps: unknown[] } };
    }>(await child.waitForLine("__E5_PUBLICATION_BARRIER__"), "__E5_PUBLICATION_BARRIER__");
    expect(publication.barrierName).toBe("before-publication-reference-swap");
    expect(publication.status).toBe("building");
    expect(publication.publicationPath).toBeNull();
    expect(publication.catalog).toMatchObject({ status: 200, body: { indexState: "building", sessions: [], laps: [] } });
    const publicationRoot = `${publication.sourcePath}.opponent-index`;
    const inFlightPublicationState = JSON.parse(readFileSync(join(publicationRoot, "state.json"), "utf8")) as {
      indexState: string; publicationPath: string | null;
    };
    expect(inFlightPublicationState).toMatchObject({ indexState: "building", publicationPath: null });
    expect(readdirSync(publicationRoot).some((entry) => entry.startsWith(".staging-"))).toBe(true);
    expect(await stopChild(child, "SIGKILL")).toMatchObject({ code: null, signal: "SIGKILL" });
    child = null;

    child = startChild(dataDir, "recover", staging.lapId);
    const repairedVersion = parseLine<{
      firstState: string; firstPublicationPath: string | null; catalog: { status: number; body: { indexState: string } };
      firstMetrics: { sourceFramesScanned: number };
    }>(await child.waitForLine("__E5_RECOVERED__"), "__E5_RECOVERED__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(repairedVersion.firstState).toBe("ready");
    expect(repairedVersion.catalog).toMatchObject({ status: 200, body: { indexState: "ready" } });
    expect(repairedVersion.firstPublicationPath).toBeTruthy();
    expect(repairedVersion.firstPublicationPath).not.toBe(originalPublicationPath);
    expect((JSON.parse(readFileSync(repairedVersion.firstPublicationPath!, "utf8")) as { algorithmVersion: number }).algorithmVersion).toBe(3);
    expect(repairedVersion.firstMetrics.sourceFramesScanned).toBeGreaterThan(0);

    rmSync(indexRoot, { recursive: true, force: true });
    writeFileSync(indexRoot, "unwritable opponent index root");
    child = startChild(dataDir, "failed-write", staging.lapId);
    const failed = parseLine<{
      indexState: string; publicationPath: string | null; error: string | null; reconcileError: string | null;
      catalog: { status: number; body: { indexState: string; sessions: unknown[]; laps: unknown[] } };
      comparison: { status: number; body: { code?: string; error?: string } };
    }>(await child.waitForLine("__E5_FAILED_WRITE__"), "__E5_FAILED_WRITE__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(failed).toMatchObject({
      indexState: "failed", publicationPath: null, error: "Opponent index preparation failed.",
      reconcileError: "Opponent index preparation failed.",
      catalog: { status: 200, body: { indexState: "failed", sessions: [], laps: [] } },
      comparison: { status: 422, body: { code: "OPPONENT_INDEX_FAILED", error: "Opponent index preparation failed." } },
    });

    rmSync(indexRoot, { force: true });
    child = startChild(dataDir, "recover", staging.lapId);
    const restored = parseLine<{
      firstState: string; firstPublicationPath: string | null;
      catalog: { status: number; body: { indexState: string; sessions: unknown[]; laps: unknown[] } };
    }>(await child.waitForLine("__E5_RECOVERED__"), "__E5_RECOVERED__");
    expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    child = null;
    expect(restored).toMatchObject({ firstState: "ready", catalog: { status: 200, body: { indexState: "ready" } } });
    expect(restored.firstPublicationPath).toBeTruthy();
    expect(restored.firstPublicationPath).not.toBe(repairedVersion.firstPublicationPath);
  } finally {
    if (child) await stopChild(child, "SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 600_000);
