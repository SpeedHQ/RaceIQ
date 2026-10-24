import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import Database from "libsql";
import { killAndWait } from "@raceiq/backend/test-support/process";
import { LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS } from "@raceiq/tooling-data/data/seed-db-options";
import { parseLmuOpponentIndexManifest } from "../../../../server/lap-analysis/lmu-opponent-index-schema";
import { summarizeLmuOpponentSummaryFacts } from "../../../../server/lap-analysis/lmu-opponent-summary";
import type { LmuOpponentIndexManifest } from "../../../../server/lap-analysis/lmu-opponent-index-schema";
import type { LmuOpponentIndexInstrumentation } from "@raceiq/backend-core/session-capture/test-instrumentation";
import type { WSData } from "@raceiq/backend-core/runtime/websocket-manager";
import type { SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import type { GameId } from "@raceiq/shared/games/ids";



const REPO_ROOT = resolve(process.cwd());
const SERVER_MODULE_PATH = resolve(REPO_ROOT, "packages/game-lmu/test/support/opponent-cold-load-server.ts");
const CHILD_MARKER = "@@LMU_OPPONENT_COLD_LOAD@@";
const execFileAsync = promisify(execFile);

export interface SeededLmuOpponentIdentity {
  gameId: "lmu";
  sessionId: number;
  lapId: number;
  sourcePath: string;
  trackId: string;
  carId: string;
  lapNumber: number;
}

export interface LmuOpponentColdLoadIdentity {
  target: SeededLmuOpponentIdentity;
  ready: { sessionId: number; lapId: number };
  opponentLapId: string;
}

export interface ColdLoadMetrics {
  index: LmuOpponentIndexInstrumentation;
  processCpuUserMicros: number;
  processCpuSystemMicros: number;
  rssBaselineBytes: number;
  rssPeakBytes: number;
  rssPeakDeltaBytes: number;
  intervalMs: number;
}

export interface OpponentColdLoadBarrier {
  id: string;
  name: string;
  sourcePath?: string;
  blockIndex?: number;
}

export interface OpponentColdLoadRuntimeEvent {
  type: string;
  sourcePath?: string;
  metrics?: unknown;
}

type RuntimeEventWaiter = {
  sourcePath?: string;
  resolve(event: OpponentColdLoadRuntimeEvent): void;
  reject(error: Error): void;
};


export interface OpponentColdLoadControls {
  holdAt(name: string): Promise<void>;
  waitForBarrier(name: string, options?: { sourcePath?: string; timeoutMs?: number }): Promise<OpponentColdLoadBarrier>;
  releaseBarrier(idOrName: string): Promise<void>;
  failBarrier(idOrName: string): Promise<void>;
  indexStatus(sourcePath: string): Promise<unknown>;
  indexStatusForSession(sessionId: number): Promise<unknown>;
  startLmuOpponentCapture(identity: string, options?: { opponents?: boolean }): Promise<void>;
  feedLmuOpponentFrames(count?: number): Promise<number>;
  getLmuOpponentCaptureState(): Promise<{ sessionId: number | null; lapIds: number[] }>;
  getLmuOpponentSessionSourcePath(sessionId: number): Promise<string | null>;
  isSessionActive(): Promise<boolean>;
  finalizeLmuOpponentCapture(): Promise<void>;
  waitForRuntimeEvent(type: string, options?: { sourcePath?: string; timeoutMs?: number }): Promise<OpponentColdLoadRuntimeEvent>;
}

export interface StartOpponentColdLoadServerOptions {
  dataDir: string;
  holdAt?: readonly string[];
  publicDir?: string;
}

export interface OpponentColdLoadServer extends OpponentColdLoadControls {
  baseURL: string;
  apiURL: string;
  executionMode: "source-runtime+dist-public-static-proxy";
  reconcile(): Promise<void>;
  resetMetrics(): Promise<ColdLoadMetrics>;
  snapshotMetrics(): Promise<ColdLoadMetrics>;
  stop(): Promise<void>;
}

export interface OpponentColdLoadSeedProcess extends OpponentColdLoadControls {
  stdout: Promise<string>;
  stderr: Promise<string>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

export interface StartOpponentColdLoadSeedProcessOptions {
  dataDir: string;
  fixturePaths?: readonly string[];
  holdAt?: readonly string[];
}

/*
 * Keep control methods shared by backend and seed children. Both use production
 * runtime test-port barriers and real database-backed capture ingress.
 */
function barrierWaiter(
  name: string,
  queues: Map<string, OpponentColdLoadBarrier[]>,
  waiters: Map<string, { sourcePath?: string; resolve(barrier: OpponentColdLoadBarrier): void; reject(error: Error): void }[]>,
  options: { sourcePath?: string; timeoutMs?: number } = {},
): Promise<OpponentColdLoadBarrier> {
  const queued = queues.get(name);
  const queuedIndex = queued?.findIndex((barrier) => options.sourcePath === undefined || barrier.sourcePath === options.sourcePath) ?? -1;
  if (queuedIndex >= 0) {
    const barrier = queued!.splice(queuedIndex, 1)[0]!;
    if (!queued!.length) queues.delete(name);
    return Promise.resolve(barrier);
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise<OpponentColdLoadBarrier>((resolveBarrier, rejectBarrier) => {
    const waiter = {
      ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
      resolve: resolveBarrier,
      reject: rejectBarrier,
    };
    const queue = waiters.get(name) ?? [];
    queue.push(waiter);
    waiters.set(name, queue);
    const timer = setTimeout(() => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) waiters.delete(name);
      rejectBarrier(new Error(`timed out waiting for ${name}`));
    }, timeoutMs);
    const resolve = waiter.resolve;
    waiter.resolve = (barrier) => {
      clearTimeout(timer);
      resolve(barrier);
    };
  });
}

function runtimeEventWaiter(
  type: string,
  queues: Map<string, OpponentColdLoadRuntimeEvent[]>,
  waiters: Map<string, RuntimeEventWaiter[]>,
  options: { sourcePath?: string; timeoutMs?: number } = {},
): Promise<OpponentColdLoadRuntimeEvent> {
  const queued = queues.get(type);
  const queuedIndex = queued?.findIndex((event) => options.sourcePath === undefined || event.sourcePath === options.sourcePath) ?? -1;
  if (queuedIndex >= 0) {
    const event = queued!.splice(queuedIndex, 1)[0]!;
    if (!queued!.length) queues.delete(type);
    return Promise.resolve(event);
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise<OpponentColdLoadRuntimeEvent>((resolveEvent, rejectEvent) => {
    const waiter: RuntimeEventWaiter = {
      ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
      resolve: resolveEvent,
      reject: rejectEvent,
    };
    const queue = waiters.get(type) ?? [];
    queue.push(waiter);
    waiters.set(type, queue);
    const timer = setTimeout(() => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) waiters.delete(type);
      rejectEvent(new Error(`timed out waiting for runtime event ${type}`));
    }, timeoutMs);
    waiter.resolve = (event) => {
      clearTimeout(timer);
      resolveEvent(event);
    };
  });
}


export interface SeedLmuOpponentColdLoadResult {
  elapsedMs: number;
  accessInitializationMs: number;
  seedDurationMs: number;
  importDurationMs: number;
  indexReconciliationMs: number;
  instrumentation: LmuOpponentIndexInstrumentation;
}

async function initializeColdLoadAccess(dataDir: string, env: NodeJS.ProcessEnv): Promise<number> {
  const database = new Database(join(dataDir, "app.db"));
  let accessMode: string | undefined;
  try {
    const accessTable = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_access'",
    ).get() as { name: string } | undefined;
    if (accessTable) {
      const row = database.prepare("SELECT mode FROM dashboard_access WHERE id = 1").get() as { mode: string } | undefined;
      accessMode = row?.mode;
    }
  } finally {
    database.close();
  }
  if (accessMode !== undefined && accessMode !== "pending") return 0;
  const startedAt = performance.now();
  await execFileAsync("bun", ["run", "playwright/support/server/initialize-access.ts"], {
    cwd: REPO_ROOT,
    env: { ...env, SERVER_PASSWORD: "", PW_ACCESS_MODE: "disabled" },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return performance.now() - startedAt;
}

export async function seedLmuOpponentColdLoadData(
  dataDir: string,
  metricsFile = join(dataDir, "lmu-opponent-seed-metrics.json"),
): Promise<SeedLmuOpponentColdLoadResult> {
  await mkdir(dataDir, { recursive: true });
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    DB_IN_MEMORY: "0",
    RACEIQ_TEST_MODE: "0",
    SERVER_PASSWORD: "",
    RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE: metricsFile,
  };
  const startedAt = performance.now();
  const seed = await execFileAsync("bun", [
    "run",
    "apps/backend/scripts/data/seed-db.ts",
    "--games=lmu",
    `--fixtures=${LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS.join(",")}`,
  ], { cwd: REPO_ROOT, env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const seedDuration = /\[DB Seed\] Durations: seed=([0-9.]+)ms, import=([0-9.]+)ms, index=([0-9.]+)ms\./.exec(seed.stdout);
  if (!seedDuration) throw new Error("LMU seed runner did not report seed/import/index durations");

  const accessInitializationMs = await initializeColdLoadAccess(dataDir, env);
  const instrumentation = JSON.parse(await readFile(metricsFile, "utf8")) as LmuOpponentIndexInstrumentation;
  return {
    elapsedMs: performance.now() - startedAt,
    accessInitializationMs,
    seedDurationMs: Number(seedDuration[1]),
    importDurationMs: Number(seedDuration[2]),
    indexReconciliationMs: Number(seedDuration[3]),
    instrumentation,
  };
}

export async function readLmuOpponentColdLoadIdentity(dataDir: string): Promise<LmuOpponentColdLoadIdentity> {
  const database = new Database(join(dataDir, "app.db"), { readonly: true });
  try {
    const rows = database.prepare(`
      SELECT
        s.id AS sessionId,
        l.id AS lapId,
        COALESCE(s.capture_manifest_file, s.raw_file) AS sourcePath,
        s.track_id AS trackId,
        s.car_id AS carId,
        l.lap_number AS lapNumber
      FROM sessions AS s
      INNER JOIN laps AS l ON l.session_id = s.id
      WHERE s.game_id = 'lmu'
        AND s.notes LIKE '%raceiq-demo-seed-v1%'
        AND l.is_valid = 1
        AND l.lap_time > 0
        AND COALESCE(l.source_frame_count, l.raw_frame_count) > 0
        AND (l.source_frame_start IS NOT NULL OR l.raw_byte_offset IS NOT NULL)
        AND COALESCE(s.capture_manifest_file, s.raw_file) IS NOT NULL
        AND COALESCE(s.capture_manifest_file, s.raw_file) != ''
        AND s.track_id != ''
        AND s.car_id != ''
      ORDER BY s.id, l.lap_number, l.id
    `).all() as {
      sessionId: number;
      lapId: number;
      sourcePath: string | null;
      trackId: string;
      carId: string;
      lapNumber: number;
    }[];
    if (!rows.length) throw new Error("Real LMU seed did not produce a valid source-backed player lap");

    const indexes = new Map<string, LmuOpponentIndexManifest>();
    for (const row of rows) {
      if (!row.sourcePath) continue;
      const sourcePath = resolve(row.sourcePath);
      let index = indexes.get(sourcePath);
      if (!index) {
        const state = JSON.parse(await readFile(join(`${sourcePath}.opponent-index`, "state.json"), "utf8")) as {
          indexState?: unknown;
          publicationPath?: unknown;
          sourceRevision?: unknown;
          sourceDependencies?: unknown;
        };
        if (state.indexState !== "ready" || typeof state.publicationPath !== "string" ||
            typeof state.sourceRevision !== "string" || !Array.isArray(state.sourceDependencies)) {
          throw new Error(`LMU opponent index is not ready for source ${sourcePath}`);
        }
        const manifest = parseLmuOpponentIndexManifest(JSON.parse(await readFile(state.publicationPath, "utf8")));
        if (manifest.sourceRevision !== state.sourceRevision ||
            JSON.stringify(manifest.sourceDependencies) !== JSON.stringify(state.sourceDependencies)) {
          throw new Error(`LMU opponent index source identity does not match ready state for ${sourcePath}`);
        }
        index = manifest;
        indexes.set(sourcePath, index);
      }
      const playerFacts = index.playerLapFacts.find((facts) => facts.playerLapId === row.lapId);
      if (!playerFacts) continue;
      const candidate = index.summaries.map((facts) =>
        summarizeLmuOpponentSummaryFacts(facts, playerFacts.comparableChannelIds),
      ).find((lap) => lap.mode === "telemetry" && lap.coverage === "complete");
      if (!candidate) continue;
      return {
        target: {
          gameId: "lmu",
          sessionId: row.sessionId,
          lapId: row.lapId,
          sourcePath: row.sourcePath,
          trackId: row.trackId,
          carId: row.carId,
          lapNumber: row.lapNumber,
        },
        ready: { sessionId: row.sessionId, lapId: row.lapId },
        opponentLapId: candidate.opponentLapId,
      };
    }
    throw new Error("Real LMU seed has no valid player lap with a complete telemetry opponent interval");
  } finally {
    database.close();
  }
}

function readLmuOpponentSessionSource(dataDir: string, sessionId: number): SessionCaptureSource | null {
  const database = new Database(join(dataDir, "app.db"), { readonly: true });
  try {
    const row = database.prepare(`
      SELECT s.game_id AS gameId, s.car_id AS carId, s.track_id AS trackId, s.source,
        s.capture_format_version AS captureFormatVersion, s.raw_file AS rawFile,
        s.capture_manifest_file AS captureManifestFile, lc.source_path AS liveSourcePath
      FROM sessions s
      LEFT JOIN live_captures lc ON lc.session_id = s.id
      WHERE s.id = ?
    `).get(sessionId) as {
      gameId: string; carId: string | null; trackId: string | null; source: string | null;
      captureFormatVersion: number | null; rawFile: string | null; captureManifestFile: string | null;
      liveSourcePath: string | null;
    } | undefined;
    const rawFile = row?.captureManifestFile ?? row?.rawFile ?? row?.liveSourcePath;
    if (!row || !rawFile) return null;
    if (row.gameId !== "lmu") throw new Error(`Opponent index status requires LMU session, received ${row.gameId}`);
    return {
      rawFile,
      source: row.source,
      gameId: row.gameId as GameId,
      carId: row.carId ?? "",
      trackId: row.trackId ?? "",
      captureFormatVersion: row.captureFormatVersion,
    };
  } finally {
    database.close();
  }
}

function readLmuOpponentSessionSourceByPath(dataDir: string, sourcePath: string): SessionCaptureSource | null {
  const database = new Database(join(dataDir, "app.db"), { readonly: true });
  try {
    const row = database.prepare(`
      SELECT id FROM sessions
      WHERE capture_manifest_file = ? OR raw_file = ?
      UNION ALL
      SELECT session_id AS id FROM live_captures WHERE source_path = ?
      ORDER BY id
      LIMIT 1
    `).get(sourcePath, sourcePath, sourcePath) as { id: number } | undefined;
    return row ? readLmuOpponentSessionSource(dataDir, row.id) : null;
  } finally {
    database.close();
  }
}

function readLmuOpponentSessionSourcePath(dataDir: string, sessionId: number): string | null {
  const source = readLmuOpponentSessionSource(dataDir, sessionId)?.rawFile ?? null;
  if (source) return source;
  const database = new Database(join(dataDir, "app.db"), { readonly: true });
  try {
    const row = database.prepare(`
      SELECT s.id, s.game_id AS gameId, s.raw_file AS rawFile,
        s.capture_manifest_file AS captureManifestFile,
        lc.session_id AS liveSessionId, lc.source_path AS liveSourcePath, lc.status AS liveStatus
      FROM sessions s LEFT JOIN live_captures lc ON lc.session_id = s.id
      WHERE s.id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    throw new Error(`No active LMU source for session ${sessionId}: ${JSON.stringify(row ?? null)}`);
  } finally {
    database.close();
  }
}

export async function startOpponentColdLoadServer(
  options: StartOpponentColdLoadServerOptions,
): Promise<OpponentColdLoadServer> {
  const dataDir = resolve(options.dataDir);
  const metricsFile = join(dataDir, `lmu-opponent-runtime-metrics-${crypto.randomUUID()}.json`);
  const accessEnv = { ...process.env, DATA_DIR: dataDir, DB_IN_MEMORY: "0", PW_ACCESS_MODE: "disabled" };
  await initializeColdLoadAccess(dataDir, accessEnv);
  const publicDir = resolve(options.publicDir ?? join(REPO_ROOT, "dist", "public"));
  if (!existsSync(join(publicDir, "index.html"))) {
    throw new Error(`Missing already-built frontend assets at ${publicDir}; build assets before E2, never during benchmark`);
  }

  const proc = spawn("bun", ["run", SERVER_MODULE_PATH, "--opponent-cold-load-child"], {
    cwd: REPO_ROOT,
    env: {
      ...accessEnv,
      NODE_ENV: "production",
      RACEIQ_TEST_MODE: "0",
      RACEIQ_E2E: "1",
      RACEIQ_DISABLE_TRAY: "1",
      SERVER_HOST: "127.0.0.1",
      SERVER_PASSWORD: "",
      SERVER_PORT: "0",
      UDP_PORT: "0",
      RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE: metricsFile,
      RACEIQ_COLD_LOAD_PUBLIC_DIR: publicDir,
      RACEIQ_COLD_LOAD_INITIAL_HOLDS: JSON.stringify(options.holdAt ?? []),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const barrierQueues = new Map<string, OpponentColdLoadBarrier[]>();
  const barrierWaiters = new Map<string, { sourcePath?: string; resolve(barrier: OpponentColdLoadBarrier): void; reject(error: Error): void }[]>();
  const runtimeEventQueues = new Map<string, OpponentColdLoadRuntimeEvent[]>();
  const runtimeEventWaiters = new Map<string, RuntimeEventWaiter[]>();
  const pendingCommands = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const recentOutput: string[] = [];
  const startupReconciled = Promise.withResolvers<void>();
  let startupReconciliationComplete = false;
  const childOutput = (line: string) => {
    if (!startupReconciliationComplete && line.includes("[SessionRepair] Historical session reconciliation complete:")) {
      startupReconciliationComplete = true;
      startupReconciled.resolve();
    }
    recentOutput.push(line.slice(0, 1000));
    if (recentOutput.length > 24) recentOutput.shift();
  };
  const stdout = createInterface({ input: proc.stdout! });
  stdout.on("line", (line) => {
    if (!line.startsWith(CHILD_MARKER)) { childOutput(line); return; }
    let message: Record<string, unknown>;
    try { message = JSON.parse(line.slice(CHILD_MARKER.length)) as Record<string, unknown>; }
    catch { childOutput("Malformed cold-load child message"); return; }
    if (message.event === "barrier") {
      const barrier = message.barrier as OpponentColdLoadBarrier;
      const waiters = barrierWaiters.get(barrier.name);
      const waiterIndex = waiters?.findIndex((waiter) => waiter.sourcePath === undefined || waiter.sourcePath === barrier.sourcePath) ?? -1;
      if (waiterIndex >= 0) {
        const [waiter] = waiters!.splice(waiterIndex, 1);
        waiter!.resolve(barrier);
        if (!waiters!.length) barrierWaiters.delete(barrier.name);
      } else {
        const queue = barrierQueues.get(barrier.name) ?? [];
        queue.push(barrier);
        barrierQueues.set(barrier.name, queue);
      }
      return;
    }
    if (message.event === "runtime") {
      const runtimeEvent = message.runtimeEvent as OpponentColdLoadRuntimeEvent;
      const waiters = runtimeEventWaiters.get(runtimeEvent.type);
      const waiterIndex = waiters?.findIndex((waiter) => waiter.sourcePath === undefined || waiter.sourcePath === runtimeEvent.sourcePath) ?? -1;
      if (waiterIndex >= 0) {
        const [waiter] = waiters!.splice(waiterIndex, 1);
        waiter!.resolve(runtimeEvent);
        if (!waiters!.length) runtimeEventWaiters.delete(runtimeEvent.type);
      } else {
        const queue = runtimeEventQueues.get(runtimeEvent.type) ?? [];
        queue.push(runtimeEvent);
        runtimeEventQueues.set(runtimeEvent.type, queue);
      }
      return;
    }
    if (message.event === "ready") {
      readyResolve(message as unknown as ChildReady);
      return;
    }
    if (message.event === "fatal") {
      readyReject(new Error(String(message.error ?? "cold-load child failed")));
      return;
    }
    if (typeof message.id === "string") {
      const pending = pendingCommands.get(message.id);
      if (pending) {
        pendingCommands.delete(message.id);
        if (message.ok === false) pending.reject(new Error(String(message.error ?? "cold-load child command failed")));
        else pending.resolve(message.value);
      }
    }
  });
  const stderr = createInterface({ input: proc.stderr! });
  stderr.on("line", childOutput);

  const readyResult = Promise.withResolvers<ChildReady>();
  const readyResolve = readyResult.resolve;
  const readyReject = readyResult.reject;
  proc.once("error", (error) => readyReject(error));
  proc.once("exit", (code, signal) => {
    const error = new Error(`cold-load backend exited (${signal ?? code}); output=${recentOutput.slice(-12).join(" | ")}`);
    readyReject(error);
    for (const pending of pendingCommands.values()) pending.reject(error);
    pendingCommands.clear();
    for (const waiters of barrierWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    barrierWaiters.clear();
    for (const waiters of runtimeEventWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    runtimeEventWaiters.clear();
  });

  let commandSequence = 0;
  const command = <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.reject(new Error("cold-load backend is not running"));
    const id = `cold-${++commandSequence}`;
    return new Promise<T>((resolveCommand, rejectCommand) => {
      pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand });
      proc.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`, (error) => {
        if (error) {
          pendingCommands.delete(id);
          rejectCommand(error);
        }
      });
    });
  };

  let ready: ChildReady;
  try {
    ready = await withTimeout(readyResult.promise, 60_000, "backend/static adapter did not become ready");
  } catch (error) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    throw error;
  }

  return {
    baseURL: ready.baseURL,
    apiURL: ready.apiURL,
    executionMode: "source-runtime+dist-public-static-proxy",
    holdAt: async (name) => { await command("hold", { name }); },
    waitForBarrier: (name, options = {}) => barrierWaiter(name, barrierQueues, barrierWaiters, options),
    waitForRuntimeEvent: (type, eventOptions = {}) => runtimeEventWaiter(type, runtimeEventQueues, runtimeEventWaiters, eventOptions),
    releaseBarrier: async (idOrName) => { await command("release", { idOrName }); },
    failBarrier: async (idOrName) => { await command("fail", { idOrName }); },
    indexStatus: (sourcePath) => command("indexStatus", { sourcePath }),
    indexStatusForSession: (sessionId) => command("indexStatusForSession", { sessionId }),
    startLmuOpponentCapture: async (identity, options) => {
      await withTimeout(startupReconciled.promise, 120_000, "startup session reconciliation did not complete");
      await command("startLmuOpponentCapture", { identity, options });
    },
    feedLmuOpponentFrames: (count) => command("feedLmuOpponentFrames", { count }),
    getLmuOpponentCaptureState: () => command("getLmuOpponentCaptureState"),
    getLmuOpponentSessionSourcePath: (sessionId) => command("getLmuOpponentSessionSourcePath", { sessionId }),
    isSessionActive: () => command("isSessionActive"),
    finalizeLmuOpponentCapture: () => command("finalizeLmuOpponentCapture"),
    reconcile: () => command("reconcile"),
    resetMetrics: () => command("resetMetrics"),
    snapshotMetrics: () => command("snapshotMetrics"),
    stop: async () => {
      try {
        await command("releaseAllBarriers");
      } finally {
        proc.stdin?.end();
        await killAndWait(proc, "SIGTERM", 120_000);
        stdout.close();
        stderr.close();
      }
    },
  };
}

export async function startOpponentColdLoadSeedProcess(
  options: StartOpponentColdLoadSeedProcessOptions,
): Promise<OpponentColdLoadSeedProcess> {
  const dataDir = resolve(options.dataDir);
  const fixturePaths = options.fixturePaths ?? LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS;
  await mkdir(dataDir, { recursive: true });
  const metricsFile = join(dataDir, `lmu-opponent-seed-metrics-${crypto.randomUUID()}.json`);
  const proc = spawn("bun", ["run", SERVER_MODULE_PATH, "--opponent-cold-load-seed-child"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_IN_MEMORY: "0",
      RACEIQ_TEST_MODE: "0",
      SERVER_PASSWORD: "",
      RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE: metricsFile,
      RACEIQ_COLD_LOAD_INITIAL_HOLDS: JSON.stringify(options.holdAt ?? []),
      RACEIQ_COLD_LOAD_SEED_FIXTURES: JSON.stringify(fixturePaths),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const barrierQueues = new Map<string, OpponentColdLoadBarrier[]>();
  const barrierWaiters = new Map<string, { sourcePath?: string; resolve(barrier: OpponentColdLoadBarrier): void; reject(error: Error): void }[]>();
  const runtimeEventQueues = new Map<string, OpponentColdLoadRuntimeEvent[]>();
  const runtimeEventWaiters = new Map<string, RuntimeEventWaiter[]>();
  const pendingCommands = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const readyResult = Promise.withResolvers<void>();
  const exitResult = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutResult = Promise.withResolvers<string>();
  const stderrResult = Promise.withResolvers<string>();
  const stdout = createInterface({ input: proc.stdout! });
  stdout.on("line", (line) => {
    if (!line.startsWith(CHILD_MARKER)) {
      stdoutLines.push(line);
      return;
    }
    let message: Record<string, unknown>;
    try { message = JSON.parse(line.slice(CHILD_MARKER.length)) as Record<string, unknown>; }
    catch { stdoutLines.push("Malformed cold-load child control message"); return; }
    if (message.event === "ready") {
      readyResult.resolve();
      return;
    }
    if (message.event === "barrier") {
      const barrier = message.barrier as OpponentColdLoadBarrier;
      const waiters = barrierWaiters.get(barrier.name);
      const waiterIndex = waiters?.findIndex((waiter) => waiter.sourcePath === undefined || waiter.sourcePath === barrier.sourcePath) ?? -1;
      if (waiterIndex >= 0) {
        const [waiter] = waiters!.splice(waiterIndex, 1);
        waiter!.resolve(barrier);
        if (!waiters!.length) barrierWaiters.delete(barrier.name);
      } else {
        const queue = barrierQueues.get(barrier.name) ?? [];
        queue.push(barrier);
        barrierQueues.set(barrier.name, queue);
      }
      return;
    }
    if (message.event === "runtime") {
      const runtimeEvent = message.runtimeEvent as OpponentColdLoadRuntimeEvent;
      const waiters = runtimeEventWaiters.get(runtimeEvent.type);
      const waiterIndex = waiters?.findIndex((waiter) => waiter.sourcePath === undefined || waiter.sourcePath === runtimeEvent.sourcePath) ?? -1;
      if (waiterIndex >= 0) {
        const [waiter] = waiters!.splice(waiterIndex, 1);
        waiter!.resolve(runtimeEvent);
        if (!waiters!.length) runtimeEventWaiters.delete(runtimeEvent.type);
      } else {
        const queue = runtimeEventQueues.get(runtimeEvent.type) ?? [];
        queue.push(runtimeEvent);
        runtimeEventQueues.set(runtimeEvent.type, queue);
      }
      return;
    }
    if (message.event === "fatal") {
      readyResult.reject(new Error(String(message.error ?? "seed child failed")));
      return;
    }
    if (typeof message.id === "string") {
      const pending = pendingCommands.get(message.id);
      if (!pending) return;
      pendingCommands.delete(message.id);
      if (message.ok === false) pending.reject(new Error(String(message.error ?? "seed child command failed")));
      else pending.resolve(message.value);
    }
  });
  stdout.on("close", () => stdoutResult.resolve(stdoutLines.join("\n")));
  const stderr = createInterface({ input: proc.stderr! });
  stderr.on("line", (line) => {
    stderrLines.push(line);
    if (line.startsWith("[E8 ingress]")) process.stderr.write(`${line}\n`);
  });
  stderr.on("close", () => stderrResult.resolve(stderrLines.join("\n")));
  proc.once("error", (error) => readyResult.reject(error));
  proc.once("exit", (code, signal) => {
    const error = new Error(`seed child exited (${signal ?? code})`);
    readyResult.reject(error);
    for (const pending of pendingCommands.values()) pending.reject(error);
    pendingCommands.clear();
    for (const waiters of barrierWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    barrierWaiters.clear();
    for (const waiters of runtimeEventWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    runtimeEventWaiters.clear();
    exitResult.resolve({ code, signal });
  });

  let commandSequence = 0;
  const command = <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.reject(new Error("seed child is not running"));
    const id = `seed-${++commandSequence}`;
    return new Promise<T>((resolveCommand, rejectCommand) => {
      pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand });
      proc.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`, (error) => {
        if (error) {
          pendingCommands.delete(id);
          rejectCommand(error);
        }
      });
    });
  };

  try {
    await withTimeout(readyResult.promise, 60_000, "seed child did not install controls");
  } catch (error) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    throw error;
  }

  return {
    stdout: stdoutResult.promise,
    stderr: stderrResult.promise,
    exit: exitResult.promise,
    holdAt: async (name) => { await command("hold", { name }); },
    waitForBarrier: (name, barrierOptions = {}) => barrierWaiter(name, barrierQueues, barrierWaiters, barrierOptions),
    waitForRuntimeEvent: (type, eventOptions = {}) => runtimeEventWaiter(type, runtimeEventQueues, runtimeEventWaiters, eventOptions),
    releaseBarrier: async (idOrName) => { await command("release", { idOrName }); },
    failBarrier: async (idOrName) => { await command("fail", { idOrName }); },
    indexStatus: (sourcePath) => command("indexStatus", { sourcePath }),
    indexStatusForSession: (sessionId) => command("indexStatusForSession", { sessionId }),
    startLmuOpponentCapture: (identity, captureOptions) => command("startLmuOpponentCapture", { identity, options: captureOptions }),
    feedLmuOpponentFrames: (count) => command("feedLmuOpponentFrames", { count }),
    getLmuOpponentCaptureState: () => command("getLmuOpponentCaptureState"),
    getLmuOpponentSessionSourcePath: (sessionId) => command("getLmuOpponentSessionSourcePath", { sessionId }),
    isSessionActive: () => command("isSessionActive"),
    finalizeLmuOpponentCapture: () => command("finalizeLmuOpponentCapture"),
    stop: async () => {
      proc.stdin?.end();
      await killAndWait(proc, "SIGTERM", 120_000);
      stdout.close();
      stderr.close();
    },
  };
}
function formatChildError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause === undefined ? "" : `\nCaused by: ${formatChildError(error.cause)}`;
  return `${error.stack ?? error.message}${cause}`;
}
function readLapForeignKeyDiagnostics(dataDir: string): string {
  const database = new Database(join(dataDir, "app.db"), { readonly: true });
  try {
    const sessions = database.prepare(`
      SELECT s.id, s.game_id AS gameId, s.raw_file AS rawFile,
        lc.session_id AS liveSessionId, lc.source_path AS liveSourcePath, lc.status AS liveStatus
      FROM sessions s LEFT JOIN live_captures lc ON lc.session_id = s.id
      ORDER BY s.id DESC LIMIT 3
    `).all();
    const laps = database.prepare(`
      SELECT l.id, l.session_id AS sessionId, l.profile_id AS profileId, p.id AS profileExists,
        l.tune_id AS tuneId, t.id AS tuneExists, l.experiment_id AS experimentId
      FROM laps l LEFT JOIN profiles p ON p.id = l.profile_id
      LEFT JOIN tunes t ON t.id = l.tune_id
      ORDER BY l.id DESC LIMIT 3
    `).all();
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check(laps)").all();
    return JSON.stringify({ sessions, laps, foreignKeyViolations });
  } finally {
    database.close();
  }
}



interface OpponentIngressDriver {
  startLmuOpponentCapture(identity: string, options?: { opponents?: boolean }): Promise<void>;
  feedLmuOpponentFrames(count?: number): Promise<number>;
  getLmuOpponentCaptureState(): Promise<{ sessionId: number | null; lapIds: number[] }>;
  finalizeLmuOpponentCapture(): Promise<void>;
}
interface ChildReady { event: "ready"; baseURL: string; apiURL: string }
interface ChildMetricsState { resetAt: number; cpuUser: number; cpuSystem: number; rssBase: number; rssPeak: number }

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); rejectPromise(error); });
  });
}

function emitChild(message: Record<string, unknown>): void {
  process.stdout.write(`${CHILD_MARKER}${JSON.stringify(message)}\n`);
}

async function runColdLoadChild(): Promise<void> {
  const dataDir = resolve(process.env.DATA_DIR!);
  const publicDir = resolve(process.env.RACEIQ_COLD_LOAD_PUBLIC_DIR!);
  const heldNames = new Set<string>(JSON.parse(process.env.RACEIQ_COLD_LOAD_INITIAL_HOLDS ?? "[]") as string[]);
  const heldBarriers = new Map<string, { name: string; release(fail: boolean): void }>();
  let currentMetrics: ChildMetricsState | null = null;
  let ingress: OpponentIngressDriver | null = null;
  let apiURL: string | null = null;
  let apiServer: { httpServer: { port?: number; stop(closeActiveConnections?: boolean): void }; httpPort: number } | null = null;
  let adapter: Bun.Server<WSData> | null = null;
  const emitHeldBarrier = (barrier: OpponentColdLoadBarrier, release: (fail: boolean) => void) => {
    if (!heldNames.has(barrier.name)) { release(false); return; }
    heldBarriers.set(barrier.id, { name: barrier.name, release });
    emitChild({ event: "barrier", barrier });
  };
  const { MessageChannel } = await import("node:worker_threads");
  const { port1, port2 } = new MessageChannel();
  const metrics = await import("@raceiq/backend-core/session-capture/test-instrumentation");
  metrics.enableParserInstrumentation();
  metrics.enableLmuOpponentIndexInstrumentation();
  metrics.resetLmuOpponentIndexInstrumentation();
  const runtime = await import("@raceiq/backend-core/session-capture/lmu-opponent-index-runtime");
  runtime.setLmuOpponentIndexTestPortForTest(port1);
  const directCapture = await import("@raceiq/backend-core/session-capture/direct-recorder");
  directCapture.setDirectCaptureStopTestBarrierForTest(async (point) => {
    const name = `direct-capture:${point}`;
    const id = crypto.randomUUID();
    await new Promise<void>((resolveBarrier, rejectBarrier) => {
      emitHeldBarrier({ id, name }, (fail) => fail ? rejectBarrier(new Error(`direct capture test barrier failed: ${point}`)) : resolveBarrier());
    });
  });
  port2.on("message", (message: { type?: string; id?: string; name?: string; sourcePath?: string; blockIndex?: number; metrics?: unknown }) => {
    if (message.type === "barrier" && message.id && message.name) {
      emitHeldBarrier({
        id: message.id,
        name: message.name,
        ...(message.sourcePath ? { sourcePath: message.sourcePath } : {}),
        ...(message.blockIndex === undefined ? {} : { blockIndex: message.blockIndex }),
      }, (fail) => port2.postMessage({ type: fail ? "fail" : "release", id: message.id }));
    } else if (message.type) {
      emitChild({ event: "runtime", runtimeEvent: message });
    }
  });
  port2.start();

  const { wsManager } = await import("@raceiq/backend-core/runtime/websocket-manager");
  const httpAccessModule = await import("../../../../apps/backend/src/runtime/http-access");
  const pathToMime = (path: string): string => {
    if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (path.endsWith(".css")) return "text/css; charset=utf-8";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".woff2")) return "font/woff2";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".html")) return "text/html; charset=utf-8";
    return "application/octet-stream";
  };
  const staticAssetHeaders = (path: string): Headers => {
    const headers = new Headers({ "X-RaceIQ": "1" });
    if (path.endsWith(".gz")) {
      headers.set("content-encoding", "gzip");
      headers.set("content-type", path.slice(0, -3).endsWith(".json") ? "application/json" : "application/octet-stream");
    } else {
      headers.set("content-type", pathToMime(path));
    }
    return headers;
  };
  const host = "127.0.0.1";
  adapter = Bun.serve<WSData>({
    hostname: host,
    port: 0,
    idleTimeout: 255,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        httpAccessModule.beginRequestAuthorization(request);
        const denied = await httpAccessModule.httpAccess.authorize(request);
        if (denied) return denied;
        const data = { createdAt: Date.now(), devTelemetrySubscribed: false } as WSData;
        if (server.upgrade(request, { data })) return undefined as unknown as Response;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (url.pathname.startsWith("/api") || url.pathname.startsWith("/studio-api")) {
        if (!apiURL) return new Response("Backend not ready", { status: 503 });
        const target = new URL(`${url.pathname}${url.search}`, apiURL);
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.set("x-forwarded-host", url.host);
        headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
        const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
        return fetch(target, { method: request.method, headers, body, redirect: "manual" });
      }
      const pathname = decodeURIComponent(url.pathname);
      const filePath = resolve(publicDir, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
      const safePath = filePath === publicDir || filePath.startsWith(`${publicDir}${sep}`);
      if (safePath) {
        const file = Bun.file(filePath);
        if (await file.exists()) return new Response(file, { headers: staticAssetHeaders(filePath) });
      }
      return new Response(Bun.file(join(publicDir, "index.html")), { headers: staticAssetHeaders(join(publicDir, "index.html")) });
    },
    websocket: {
      open(socket) { wsManager.addClient(socket); },
      close(socket) { wsManager.removeClient(socket); },
      message(socket, message) { wsManager.handleMessage(socket, typeof message === "string" ? message : Buffer.from(message)); },
    },
  });
  const baseURL = `http://${host}:${adapter.port}`;
  // Let backend validate the proxy's forwarded same-origin authority.
  delete process.env.SERVER_ALLOWED_ORIGINS;

  try {
    const { bootServer } = await import("../../../../apps/backend/src/runtime/boot");
    apiServer = await bootServer({ httpPort: 0, udpPort: 0, recordingGameId: null });
    apiURL = `http://${host}:${apiServer.httpPort}`;
    const usage = process.resourceUsage();
    const rss = process.memoryUsage().rss;
    currentMetrics = {
      resetAt: performance.now(),
      cpuUser: usage.userCPUTime,
      cpuSystem: usage.systemCPUTime,
      rssBase: rss,
      rssPeak: rss,
    };
    const sample = setInterval(() => {
      if (!currentMetrics) return;
      currentMetrics.rssPeak = Math.max(currentMetrics.rssPeak, process.memoryUsage().rss);
    }, 20);
    sample.unref();
    emitChild({ event: "ready", baseURL, apiURL, executionMode: "source-runtime+dist-public-static-proxy" });

    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      let message: { id?: string; op?: string; name?: string; idOrName?: string; sourcePath?: string; sessionId?: number; identity?: string; options?: { opponents?: boolean }; count?: number };
      try { message = JSON.parse(line) as typeof message; }
      catch { return; }
      const id = message.id;
      if (!id) return;
      void (async () => {
        switch (message.op) {
          case "hold": {
            if (!message.name) throw new Error("hold requires name");
            heldNames.add(message.name);
            return true;
          }
          case "releaseAllBarriers": {
            heldNames.clear();
            const held = [...heldBarriers.values()];
            heldBarriers.clear();
            for (const barrier of held) barrier.release(false);
            return held.length;
          }
          case "release":
          case "fail": {
            if (!message.idOrName) throw new Error(`${message.op} requires idOrName`);
            const matches = [...heldBarriers].filter(([barrierId, barrier]) => barrierId === message.idOrName || barrier.name === message.idOrName);
            if (!matches.length) throw new Error(`no held barrier matches ${message.idOrName}`);
            for (const [barrierId, barrier] of matches) {
              heldBarriers.delete(barrierId);
              barrier.release(message.op === "fail");
            }
            return matches.length;
          }
          case "indexStatus": {
            if (!message.sourcePath) throw new Error("indexStatus requires sourcePath");
            const source = readLmuOpponentSessionSourceByPath(dataDir, message.sourcePath);
            if (!source) throw new Error(`No LMU session references opponent source ${message.sourcePath}`);
            return await runtime.getLmuOpponentIndexStatus(source);
          }
          case "indexStatusForSession": {
            if (!Number.isSafeInteger(message.sessionId)) throw new Error("indexStatusForSession requires sessionId");
            const source = readLmuOpponentSessionSource(dataDir, message.sessionId!);
            if (!source) throw new Error(`No source path for LMU session ${message.sessionId}`);
            return await runtime.getLmuOpponentIndexStatus(source);
          }
          case "getLmuOpponentSessionSourcePath":
            if (!Number.isSafeInteger(message.sessionId)) throw new Error("getLmuOpponentSessionSourcePath requires sessionId");
            return readLmuOpponentSessionSourcePath(dataDir, message.sessionId!);
          case "reconcile":
            await runtime.reconcileLmuOpponentIndexes({ awaitPreparation: true });
            return true;
          case "startLmuOpponentCapture":
            if (typeof message.identity !== "string") throw new Error("startLmuOpponentCapture requires identity");
            ingress ??= await import("./opponent-ingress");
            await ingress.startLmuOpponentCapture(message.identity, message.options);
            return true;
          case "feedLmuOpponentFrames":
            ingress ??= await import("./opponent-ingress");
            return await ingress.feedLmuOpponentFrames(message.count);
          case "getLmuOpponentCaptureState":
            ingress ??= await import("./opponent-ingress");
            return await ingress.getLmuOpponentCaptureState();
          case "isSessionActive": {
            const livePipeline = await import("@raceiq/backend-core/telemetry/live-pipeline");
            return livePipeline.isSessionActive();
          }
          case "finalizeLmuOpponentCapture":
            ingress ??= await import("./opponent-ingress");
            try {
              await ingress.finalizeLmuOpponentCapture();
            } catch (error) {
              throw new Error(`Capture finalization DB state: ${readLapForeignKeyDiagnostics(dataDir)}`, { cause: error });
            }
            return true;
          case "resetMetrics": {
            metrics.resetLmuOpponentIndexInstrumentation();
            const usage = process.resourceUsage();
            const rss = process.memoryUsage().rss;
            currentMetrics = { resetAt: performance.now(), cpuUser: usage.userCPUTime, cpuSystem: usage.systemCPUTime, rssBase: rss, rssPeak: rss };
            return readMetrics();
          }
          case "snapshotMetrics": return readMetrics();
          default: throw new Error(`unsupported cold-load child command ${message.op ?? ""}`);
        }
      })().then((value) => emitChild({ id, ok: true, value }), (error: unknown) => emitChild({ id, ok: false, error: formatChildError(error) }));
    });
  } catch (error) {
    adapter.stop(true);
    throw error;
  }

  function readMetrics(): ColdLoadMetrics {
    const state = currentMetrics;
    if (!state) throw new Error("cold-load metrics are not initialized");
    const usage = process.resourceUsage();
    const rssPeak = Math.max(state.rssPeak, process.memoryUsage().rss);
    return {
      index: metrics.getLmuOpponentIndexInstrumentation(),
      processCpuUserMicros: usage.userCPUTime - state.cpuUser,
      processCpuSystemMicros: usage.systemCPUTime - state.cpuSystem,
      rssBaselineBytes: state.rssBase,
      rssPeakBytes: rssPeak,
      rssPeakDeltaBytes: Math.max(0, rssPeak - state.rssBase),
      intervalMs: performance.now() - state.resetAt,
    };
  }
}

async function runColdLoadSeedChild(): Promise<void> {
  const heldNames = new Set<string>(JSON.parse(process.env.RACEIQ_COLD_LOAD_INITIAL_HOLDS ?? "[]") as string[]);
  const heldBarriers = new Map<string, { name: string; release(fail: boolean): void }>();
  const metrics = await import("@raceiq/backend-core/session-capture/test-instrumentation");
  metrics.enableParserInstrumentation();
  metrics.enableLmuOpponentIndexInstrumentation();
  metrics.resetLmuOpponentIndexInstrumentation();
  const { MessageChannel } = await import("node:worker_threads");
  const { port1, port2 } = new MessageChannel();
  const runtime = await import("@raceiq/backend-core/session-capture/lmu-opponent-index-runtime");
  const directCapture = await import("@raceiq/backend-core/session-capture/direct-recorder");
  const restoreRuntimeTestPort = runtime.setLmuOpponentIndexTestPortForTest(port1);
  let restoreDirectCaptureBarrier: (() => void) | undefined;
  const emitHeldBarrier = (barrier: OpponentColdLoadBarrier, release: (fail: boolean) => void) => {
    if (!heldNames.has(barrier.name)) { release(false); return; }
    heldBarriers.set(barrier.id, { name: barrier.name, release });
    emitChild({ event: "barrier", barrier });
  };
  restoreDirectCaptureBarrier = directCapture.setDirectCaptureStopTestBarrierForTest(async (point) => {
    const name = `direct-capture:${point}`;
    const id = crypto.randomUUID();
    await new Promise<void>((resolveBarrier, rejectBarrier) => {
      emitHeldBarrier({ id, name }, (fail) => fail ? rejectBarrier(new Error(`direct capture test barrier failed: ${point}`)) : resolveBarrier());
    });
  });
  port2.on("message", (message: { type?: string; id?: string; name?: string; sourcePath?: string; blockIndex?: number; metrics?: unknown }) => {
    if (message.type === "barrier" && message.id && message.name) {
      emitHeldBarrier({
        id: message.id,
        name: message.name,
        ...(message.sourcePath ? { sourcePath: message.sourcePath } : {}),
        ...(message.blockIndex === undefined ? {} : { blockIndex: message.blockIndex }),
      }, (fail) => port2.postMessage({ type: fail ? "fail" : "release", id: message.id }));
    } else if (message.type) {
      emitChild({ event: "runtime", runtimeEvent: message });
    }
  });
  port2.start();

  let ingress: OpponentIngressDriver | null = null;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: { id?: string; op?: string; name?: string; idOrName?: string; sourcePath?: string; sessionId?: number; identity?: string; options?: { opponents?: boolean }; count?: number };
    try { message = JSON.parse(line) as typeof message; }
    catch { return; }
    const id = message.id;
    if (!id) return;
    void (async () => {
      switch (message.op) {
        case "hold": {
          if (!message.name) throw new Error("hold requires name");
          heldNames.add(message.name);
          return true;
        }
        case "release":
        case "fail": {
          if (!message.idOrName) throw new Error(`${message.op} requires idOrName`);
          const matches = [...heldBarriers].filter(([barrierId, barrier]) => barrierId === message.idOrName || barrier.name === message.idOrName);
          if (!matches.length) throw new Error(`no held barrier matches ${message.idOrName}`);
          for (const [barrierId, barrier] of matches) {
            heldBarriers.delete(barrierId);
            barrier.release(message.op === "fail");
          }
          return matches.length;
        }
        case "indexStatus": {
          if (!message.sourcePath) throw new Error("indexStatus requires sourcePath");
          const source = readLmuOpponentSessionSourceByPath(resolve(process.env.DATA_DIR!), message.sourcePath);
          if (!source) throw new Error(`No LMU session references opponent source ${message.sourcePath}`);
          return await runtime.getLmuOpponentIndexStatus(source);
        }
        case "indexStatusForSession": {
          if (!Number.isSafeInteger(message.sessionId)) throw new Error("indexStatusForSession requires sessionId");
          const source = readLmuOpponentSessionSource(resolve(process.env.DATA_DIR!), message.sessionId!);
          if (!source) throw new Error(`No source path for LMU session ${message.sessionId}`);
          return await runtime.getLmuOpponentIndexStatus(source);
        }
        case "getLmuOpponentSessionSourcePath":
          if (!Number.isSafeInteger(message.sessionId)) throw new Error("getLmuOpponentSessionSourcePath requires sessionId");
          return readLmuOpponentSessionSourcePath(resolve(process.env.DATA_DIR!), message.sessionId!);
        case "startLmuOpponentCapture":
          if (typeof message.identity !== "string") throw new Error("startLmuOpponentCapture requires identity");
          ingress ??= await import("./opponent-ingress");
          await ingress.startLmuOpponentCapture(message.identity, message.options);
          return true;
        case "feedLmuOpponentFrames":
          ingress ??= await import("./opponent-ingress");
          return await ingress.feedLmuOpponentFrames(message.count);
        case "getLmuOpponentCaptureState":
          ingress ??= await import("./opponent-ingress");
          return await ingress.getLmuOpponentCaptureState();
        case "isSessionActive": {
          const livePipeline = await import("@raceiq/backend-core/telemetry/live-pipeline");
          return livePipeline.isSessionActive();
        }
        case "finalizeLmuOpponentCapture":
          ingress ??= await import("./opponent-ingress");
          await ingress.finalizeLmuOpponentCapture();
          return true;
        default:
          throw new Error(`unsupported seed child command ${message.op ?? ""}`);
      }
    })().then((value) => emitChild({ id, ok: true, value }), (error: unknown) => emitChild({ id, ok: false, error: formatChildError(error) }));
  });

  const fixturePaths = JSON.parse(process.env.RACEIQ_COLD_LOAD_SEED_FIXTURES ?? "[]") as string[];
  if (fixturePaths.length === 0) throw new Error("seed child requires fixturePaths");
  const seedEntry = join(REPO_ROOT, "apps", "backend", "scripts", "data", "seed-db.ts");
  process.argv = [process.argv[0]!, seedEntry, "--games=lmu", `--fixtures=${fixturePaths.join(",")}`];
  emitChild({ event: "ready" });
  try {
    await import("../../../../apps/backend/scripts/data/seed-db");
    emitChild({ event: "seed-complete" });
  } finally {
    for (const { release } of heldBarriers.values()) release(false);
    heldBarriers.clear();
    lines.close();
    process.stdin.pause();
    port1.close();
    port2.close();
    restoreDirectCaptureBarrier?.();
    restoreRuntimeTestPort();
  }
}

if (process.argv.includes("--opponent-cold-load-seed-child")) {
  void runColdLoadSeedChild().catch((error: unknown) => {
    emitChild({ event: "fatal", error: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.exit(1);
  });
} else if (process.argv.includes("--opponent-cold-load-child")) {
  void runColdLoadChild().catch((error: unknown) => {
    emitChild({ event: "fatal", error: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.exit(1);
  });
}
