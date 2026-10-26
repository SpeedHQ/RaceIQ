import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { Effect, Fiber } from "effect";
import { and, eq, inArray, or } from "drizzle-orm";
import type { GameId } from "@raceiq/shared/games/ids";
import type { OpponentIndexState, ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";
import type { WorkerMessage, WorkerRequest } from "./lmu-opponent-index-worker";
import { readDb } from "../db/index";
import { liveCaptures, sessions, laps } from "../db/schema";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import type { SessionCaptureSource } from "./source-loader";
import { isSessionActive } from "./session-activity";
import {
  admitMaintenance,
  getRecordingMaintenanceController,
  releaseMaintenance,
  trackMaintenanceFiber,
  type RecordingMaintenanceController,
} from "./maintenance-runtime";
import {
  getActiveLmuOpponentSourceKind,
  getActiveLmuOpponentSourcePaths,
  getRecordingStorageActivity,
  isActiveLmuOpponentSource,
  reserveRecordingStorageOperationWhenIdle,
} from "./storage-activity";
import { isLmuOpponentIndexInstrumentationEnabled, recordLmuOpponentIndexMetrics } from "./test-instrumentation";
import { isUnmanifestedLegacyNativeSource, readLmuOpponentRetentionMetadata, type LmuOpponentRetention } from "./lmu-companion";
import {
  cleanupLmuOpponentIndexStaging,
  describeLmuOpponentSource,
  invalidateLmuOpponentIndex,
  readLmuOpponentIndex,
} from "../lap-analysis/lmu-opponent-index";
import type {
  LmuOpponentIndexBuildResult,
  LmuOpponentIndexSourceDependency,
  LmuOpponentIndexStagedPublication,
} from "../lap-analysis/lmu-opponent-index";
import { IS_COMPILED } from "../runtime/config/paths";
import { wsManager } from "../runtime/websocket-manager";
function logTestDiagnostic(location: string, error: unknown, sourcePath?: string): void {
  if (process.env.RACEIQ_TEST_MODE !== "1" && !process.env.RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE) return;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[LMUOpponentIndexTest] ${location}${sourcePath ? ` (${sourcePath})` : ""}: ${detail}`);
}


const SAFE_PREPARATION_ERROR = "Opponent index preparation failed.";
const DISCOVERY_INTERVAL_MS = 30_000;
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
type IndexState = OpponentIndexState;
type DurableIndexState = "queued" | "building" | "ready" | "failed";
type JobOutcome = "ready" | "pending" | "failed";
type BarrierName =
  | "source-discovery-complete"
  | "admission-granted"
  | "bounded-block-boundary"
  | "before-publication-fence"
  | "before-publication-reference-swap"
  | "after-publication-reference-swap"
  | "before-publication-state-write"
  | "reconciliation-deferred";
type BarrierReply = "release" | "fail";

interface DurableState {
  version: 1;
  indexState: DurableIndexState;
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  publicationPath: string | null;
  error: string | null;
}

interface SourceRow {
  id: number;
  gameId: string;
  source: string | null;
  carId: string;
  trackId: string;
  rawFile: string | null;
  captureManifestFile: string | null;
  captureArchiveFile: string | null;
  captureLayoutVersion: number | null;
  captureFormatVersion: number | null;
}

interface LapWindowRow {
  id: number;
  sessionId: number;
  rawByteOffset: number | null;
  rawFrameCount: number | null;
  sourceFrameStart: number | null;
  sourceFrameCount: number | null;
  captureChunkId: string | null;
}

interface PlayerLapWindow {
  playerLapId: number;
  startFrameIndex: number | null;
  startByteOffset: number | null;
  frameCount: number;
}

interface SourceCandidate {
  sourcePath: string;
  indexRoot: string;
  source: SessionCaptureSource;
  sessionRows: readonly SourceRow[];
  lapRows: readonly LapWindowRow[];
  playerLapWindows: readonly PlayerLapWindow[];
  liveStatuses: readonly string[];
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
}

interface SourceAssessment {
  indexState: IndexState;
  sourcePath: string;
  candidate: SourceCandidate | null;
  retention: LmuOpponentRetention;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  publicationPath: string | null;
  error: string | null;
  requiresPreparation: boolean;
}

interface PlayerLapWorkerInput {
  playerLapId: number;
  startFrameIndex: number | null;
  startByteOffset: number | null;
  frameCount: number;
}

interface WorkerInput {
  source: SessionCaptureSource;
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  playerLapWindows: readonly PlayerLapWorkerInput[];
  indexRoot: string;
}

interface WorkerMetrics {
  buildDurationMs: number;
  workerCpuUserMicros: number;
  workerCpuSystemMicros: number;
  rssBytes: number;
  sourceFramesScanned: number;
  nativeFramesDecoded: number;
}


const activeWorkerRoots = new Set<string>();
const runningCandidateRoots = new Set<string>();
const queuedCandidates = new Map<string, SourceCandidate>();
const completionWaiters = new Map<string, { promise: Promise<JobOutcome>; resolve: (outcome: JobOutcome) => void; settled: boolean }>();
const memoryFailures = new Map<string, DurableState>();
const requestedSourcePaths = new Set<string>();
const invalidatedRoots = new Set<string>();

const pendingBarriers = new Map<string, (reply: BarrierReply) => void>();
let controller: RecordingMaintenanceController | null = null;
let schedulerFiber: Fiber.Fiber<unknown, unknown> | null = null;
let schedulerWake: (() => void) | null = null;
let workerActive = false;
let runtimeStarted = false;
let runtimeStopping = false;
let stopPromise: Promise<void> | null = null;
let testPort: MessagePort | null = null;
let testPortListener: ((message: { type?: string; id?: string }) => void) | null = null;
let workerPeakRssBytes = 0;

function indexRootFor(sourcePath: string): string {
  return `${sourcePath}.opponent-index`;
}

function statePathFor(indexRoot: string): string {
  return join(indexRoot, "state.json");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function canonicalSourcePath(sourcePath: string): Promise<string> {
  return realpath(sourcePath).catch((error: unknown) => {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return resolve(sourcePath);
    throw error;
  });
}
export async function canonicalLmuOpponentSourcePath(sourcePath: string): Promise<string> {
  return canonicalSourcePath(sourcePath);
}

function validDependencies(value: unknown): value is readonly LmuOpponentIndexSourceDependency[] {
  return Array.isArray(value) && value.length <= 100_000 && value.every((dependency) =>
    typeof dependency === "object" && dependency !== null &&
    typeof dependency.role === "string" && typeof dependency.path === "string" &&
    typeof dependency.dev === "string" && typeof dependency.ino === "string" &&
    Number.isFinite(dependency.size) && Number.isFinite(dependency.mtimeMs) && Number.isFinite(dependency.ctimeMs));
}

function parseDurableState(value: unknown): DurableState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<DurableState>;
  if (state.version !== STATE_VERSION || !["queued", "building", "ready", "failed"].includes(state.indexState ?? "") ||
      typeof state.sourceRevision !== "string" || !validDependencies(state.sourceDependencies) ||
      !(state.publicationPath === null || typeof state.publicationPath === "string") ||
      !(state.error === null || typeof state.error === "string")) return null;
  return state as DurableState;
}

async function readDurableState(indexRoot: string): Promise<DurableState | null> {
  try {
    const info = await stat(statePathFor(indexRoot));
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return null;
    return parseDurableState(JSON.parse(await readFile(statePathFor(indexRoot), "utf8")));
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
    return null;
  }
}

async function writeDurableState(indexRoot: string, state: DurableState): Promise<void> {
  await mkdir(indexRoot, { recursive: true });
  const target = statePathFor(indexRoot);
  const temporary = join(indexRoot, `state.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await file.close();
  await rename(temporary, target);
  const directory = await open(indexRoot, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function dependenciesEqual(
  left: readonly LmuOpponentIndexSourceDependency[],
  right: readonly LmuOpponentIndexSourceDependency[],
): boolean {
  const key = (dependency: LmuOpponentIndexSourceDependency) =>
    `${dependency.role}\0${dependency.path}\0${dependency.dev}\0${dependency.ino}\0${dependency.size}\0${dependency.mtimeMs}\0${dependency.ctimeMs}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function publicationPathIsContained(indexRoot: string, publicationPath: string): boolean {
  if (!isAbsolute(publicationPath) || !publicationPath.endsWith(`${sep}index.json`)) return false;
  const contained = relative(indexRoot, resolve(publicationPath));
  return contained !== ".." && !contained.startsWith(`..${sep}`) && !isAbsolute(contained);
}

function isSourceLive(sourcePath: string, liveStatuses: readonly string[]): boolean {
  return isActiveLmuOpponentSource(sourcePath) ||
    liveStatuses.some((status) => ["recording", "finalizing", "recovering"].includes(status));
}

function recordingOrDraining(): boolean {
  return isSessionActive() || getRecordingStorageActivity().imports > 0;
}

function sourceFromRow(row: SourceRow, sourcePath: string): SessionCaptureSource {
  return {
    rawFile: sourcePath,
    source: row.source,
    gameId: row.gameId as GameId,
    carId: row.carId,
    trackId: row.trackId,
    captureFormatVersion: row.captureFormatVersion,
  };
}

function sourceRowSignature(row: SourceRow): string {
  return JSON.stringify([
    row.id, row.gameId, row.source, row.carId, row.trackId, row.rawFile,
    row.captureManifestFile, row.captureArchiveFile, row.captureLayoutVersion, row.captureFormatVersion,
  ]);
}

function lapRowSignature(row: LapWindowRow): string {
  return JSON.stringify([
    row.id, row.sessionId, row.rawByteOffset, row.rawFrameCount,
    row.sourceFrameStart, row.sourceFrameCount, row.captureChunkId,
  ]);
}

function playerWindow(row: LapWindowRow): PlayerLapWindow | null {
  const frameCount = row.sourceFrameCount ?? row.rawFrameCount;
  const startFrameIndex = row.sourceFrameStart;
  const startByteOffset = row.rawByteOffset;
  if (!Number.isSafeInteger(frameCount) || frameCount! < 1 ||
      (startFrameIndex == null && startByteOffset == null) ||
      (startFrameIndex != null && (!Number.isSafeInteger(startFrameIndex) || startFrameIndex < 0)) ||
      (startByteOffset != null && (!Number.isSafeInteger(startByteOffset) || startByteOffset < 0))) return null;
  return {
    playerLapId: row.id,
    startFrameIndex: startFrameIndex ?? null,
    startByteOffset: startByteOffset ?? null,
    frameCount: frameCount!,
  };
}

function wakeScheduler(): void {
  schedulerWake?.();
}


function receiveTestPortMessage(message: { type?: string; id?: string }): void {
  if ((message.type !== "release" && message.type !== "fail") || typeof message.id !== "string") return;
  const resolveBarrier = pendingBarriers.get(message.id);
  if (!resolveBarrier) return;
  pendingBarriers.delete(message.id);
  resolveBarrier(message.type);
}

export function setLmuOpponentIndexTestPortForTest(port: MessagePort | null): () => void {
  if (testPort && testPortListener) testPort.off("message", testPortListener);
  for (const resolveBarrier of pendingBarriers.values()) resolveBarrier("release");
  pendingBarriers.clear();
  testPort = port;
  testPortListener = port ? receiveTestPortMessage : null;
  port?.on("message", receiveTestPortMessage);
  port?.start();
  return () => {
    if (testPort !== port) return;
    if (testPort && testPortListener) testPort.off("message", testPortListener);
    testPort = null;
    testPortListener = null;
    for (const resolveBarrier of pendingBarriers.values()) resolveBarrier("release");
    pendingBarriers.clear();
  };
}

async function waitAtTestBarrier(
  name: BarrierName,
  sourcePath: string,
  blockIndex?: number,
  allowFailure = false,
): Promise<void> {
  const port = testPort;
  if (!port) return;
  const id = randomUUID();
  const { promise, resolve } = Promise.withResolvers<BarrierReply>();
  pendingBarriers.set(id, resolve);
  port.postMessage({ type: "barrier", id, name, sourcePath, ...(blockIndex === undefined ? {} : { blockIndex }) });
  const reply = await promise;
  if (reply === "fail" && allowFailure) throw new Error(SAFE_PREPARATION_ERROR);
}

function notifyTestPort(message: Record<string, unknown>): void {
  testPort?.postMessage(message);
}

async function readRetention(sourcePath: string, indexRoot: string): Promise<LmuOpponentRetention> {
  try {
    return await readLmuOpponentRetentionMetadata(sourcePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) throw error;
    const previous = await readDurableState(indexRoot);
    const failure = memoryFailures.get(indexRoot);
    return {
      opponentRetention: "retained",
      opponentAvailability: "missing",
      sourceRevision: previous?.sourceRevision ?? failure?.sourceRevision ?? "missing",
    };
  }
}

async function liveStatusBySession(sessionIds: readonly number[]): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const rows = await readDb.select({ status: liveCaptures.status }).from(liveCaptures)
    .where(inArray(liveCaptures.sessionId, [...sessionIds])).all();
  return rows.map((row) => row.status);
}


async function assessSource(
  sourcePath: string,
  source: SessionCaptureSource,
  sessionRows: readonly SourceRow[],
  lapRows: readonly LapWindowRow[],
  liveStatuses: readonly string[],
): Promise<SourceAssessment> {
  const indexRoot = indexRootFor(sourcePath);
  const active = isSourceLive(sourcePath, liveStatuses);
  const retention = await readRetention(sourcePath, indexRoot);
  if (active) {
    return {
      indexState: "waiting-finalization", sourcePath, candidate: null, retention,
      sourceDependencies: [], publicationPath: null, error: null, requiresPreparation: false,
    };
  }
  if (retention.opponentRetention !== "retained" ||
      (retention.opponentAvailability !== "complete" &&
        !(retention.opponentAvailability === "incomplete" && await isUnmanifestedLegacyNativeSource(sourcePath)))) {
    return {
      indexState: "not-required", sourcePath, candidate: null, retention,
      sourceDependencies: [], publicationPath: null, error: null, requiresPreparation: false,
    };
  }

  let description: { sourceRevision: string; sourceDependencies: readonly LmuOpponentIndexSourceDependency[] };
  try {
    description = await describeLmuOpponentSource(source);
  } catch (error) {
    const availability = isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") ? "missing" : "corrupt";
    return {
      indexState: "not-required", sourcePath, candidate: null,
      retention: { ...retention, opponentAvailability: availability },
      sourceDependencies: [], publicationPath: null, error: null, requiresPreparation: false,
    };
  }
  const state = await readDurableState(indexRoot);
  const localFailure = memoryFailures.get(indexRoot);
  const matchingFailure = (state?.indexState === "failed" && state.sourceRevision === description.sourceRevision &&
    dependenciesEqual(state.sourceDependencies, description.sourceDependencies)) ||
    (localFailure?.sourceRevision === description.sourceRevision && dependenciesEqual(localFailure.sourceDependencies, description.sourceDependencies));
  if (activeWorkerRoots.has(indexRoot) || runningCandidateRoots.has(indexRoot)) {
    return {
      indexState: "building", sourcePath, candidate: null, retention,
      sourceDependencies: description.sourceDependencies,
      publicationPath: state?.sourceRevision === description.sourceRevision &&
        dependenciesEqual(state.sourceDependencies, description.sourceDependencies) &&
        state.publicationPath && publicationPathIsContained(indexRoot, state.publicationPath)
        ? state.publicationPath : null,
      error: null, requiresPreparation: true,
    };
  }
  if (state?.indexState === "ready" && state.sourceRevision === description.sourceRevision &&
      dependenciesEqual(state.sourceDependencies, description.sourceDependencies) && state.publicationPath &&
      publicationPathIsContained(indexRoot, state.publicationPath)) {
    try {
      await readLmuOpponentIndex(state.publicationPath, {
        sourceRevision: description.sourceRevision,
        sourceDependencies: description.sourceDependencies,
      });
      memoryFailures.delete(indexRoot);
      return {
        indexState: "ready", sourcePath, candidate: null, retention,
        sourceDependencies: description.sourceDependencies, publicationPath: state.publicationPath,
        error: null, requiresPreparation: false,
      };
    } catch {
      // Invalid publication remains non-authoritative until background repair.
      if (state.publicationPath) await reportLmuOpponentIndexReadFailure(source, state.publicationPath);
    }
  }
  const windows = lapRows.map(playerWindow).filter((value): value is PlayerLapWindow => value !== null);
  const candidate: SourceCandidate = {
    sourcePath,
    indexRoot,
    source,
    sessionRows,
    lapRows,
    playerLapWindows: windows,
    liveStatuses,
    sourceRevision: description.sourceRevision,
    sourceDependencies: description.sourceDependencies,
  };
  if (matchingFailure) {
    return {
      indexState: "failed", sourcePath, candidate, retention,
      sourceDependencies: description.sourceDependencies, publicationPath: null,
      error: SAFE_PREPARATION_ERROR, requiresPreparation: true,
    };
  }
  return {
    indexState: "queued", sourcePath, candidate, retention,
    sourceDependencies: description.sourceDependencies, publicationPath: null, error: null, requiresPreparation: true,
  };
}

async function discoverSourceGroups(): Promise<SourceAssessment[]> {
  const rows = await readDb.select({
    id: sessions.id, gameId: sessions.gameId, source: sessions.source,
    carId: sessions.carId, trackId: sessions.trackId,
    rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile,
    captureArchiveFile: sessions.captureArchiveFile,
    captureLayoutVersion: sessions.captureLayoutVersion,
    captureFormatVersion: sessions.captureFormatVersion,
  }).from(sessions).where(eq(sessions.gameId, "lmu")).all() as SourceRow[];
  const liveRows = await readDb.select({ sessionId: liveCaptures.sessionId, status: liveCaptures.status }).from(liveCaptures).all();
  const liveBySession = new Map(liveRows.map((row) => [row.sessionId, row.status]));
  const pathGroups = new Map<string, { sourcePath: string; rows: SourceRow[]; statuses: string[] }>();
  const canonicalByPath = new Map<string, Promise<string>>();
  for (const row of rows) {
    const referencedPath = row.captureManifestFile ?? row.rawFile;
    if (!referencedPath) continue;
    let canonicalPromise = canonicalByPath.get(referencedPath);
    if (!canonicalPromise) {
      canonicalPromise = canonicalSourcePath(referencedPath);
      canonicalByPath.set(referencedPath, canonicalPromise);
    }
    const sourcePath = await canonicalPromise;
    const group = pathGroups.get(sourcePath) ?? { sourcePath, rows: [], statuses: [] };
    group.rows.push(row);
    const liveStatus = liveBySession.get(row.id);
    if (liveStatus) group.statuses.push(liveStatus);
    pathGroups.set(sourcePath, group);
  }
  const sessionIds = rows.map((row) => row.id);
  const allLapRows = sessionIds.length === 0 ? [] : await readDb.select({
    id: laps.id, sessionId: laps.sessionId, rawByteOffset: laps.rawByteOffset,
    rawFrameCount: laps.rawFrameCount, sourceFrameStart: laps.sourceFrameStart,
    sourceFrameCount: laps.sourceFrameCount, captureChunkId: laps.captureChunkId,
  }).from(laps).where(inArray(laps.sessionId, sessionIds)).all() as LapWindowRow[];
  const lapsBySession = new Map<number, LapWindowRow[]>();
  for (const row of allLapRows) {
    const grouped = lapsBySession.get(row.sessionId) ?? [];
    grouped.push(row);
    lapsBySession.set(row.sessionId, grouped);
  }
  const assessments: SourceAssessment[] = [];
  for (const group of pathGroups.values()) {
    await waitAtTestBarrier("source-discovery-complete", group.sourcePath);
    group.rows.sort((a, b) => a.id - b.id);
    const representative = group.rows[0]!;
    const sessionLaps = group.rows.flatMap((row) => lapsBySession.get(row.id) ?? []).sort((a, b) => a.id - b.id);
    const source = sourceFromRow(representative, group.sourcePath);
    assessments.push(await assessSource(group.sourcePath, source, group.rows, sessionLaps, group.statuses));
  }
  return assessments;
}

function stateForCandidate(candidate: SourceCandidate, indexState: DurableIndexState, publicationPath: string | null, error: string | null): DurableState {
  return {
    version: STATE_VERSION,
    indexState,
    sourceRevision: candidate.sourceRevision,
    sourceDependencies: candidate.sourceDependencies,
    publicationPath,
    error,
  };
}

function getOrCreateWaiter(indexRoot: string): Promise<JobOutcome> {
  let waiter = completionWaiters.get(indexRoot);
  if (!waiter) {
    const deferred = Promise.withResolvers<JobOutcome>();
    waiter = { promise: deferred.promise, resolve: deferred.resolve, settled: false };
    completionWaiters.set(indexRoot, waiter);
  }
  return waiter.promise;
}

function prepareCandidateWaiter(indexRoot: string): Promise<JobOutcome> {
  const waiter = completionWaiters.get(indexRoot);
  if (waiter?.settled) completionWaiters.delete(indexRoot);
  return getOrCreateWaiter(indexRoot);
}

function settleCandidate(indexRoot: string, outcome: JobOutcome): void {
  const waiter = completionWaiters.get(indexRoot);
  if (!waiter || waiter.settled) return;
  waiter.settled = true;
  waiter.resolve(outcome);
}

function queueCandidate(candidate: SourceCandidate): Promise<JobOutcome> {
  const indexRoot = candidate.indexRoot;
  if (runningCandidateRoots.has(indexRoot)) return getOrCreateWaiter(indexRoot);
  queuedCandidates.set(indexRoot, candidate);
  const waiter = prepareCandidateWaiter(indexRoot);
  wakeScheduler();
  return waiter;
}

async function deferReconciliation(sourcePath: string): Promise<"pending"> {
  await waitAtTestBarrier("reconciliation-deferred", sourcePath);
  notifyTestPort({ type: "reconciliation-deferred", sourcePath });
  return "pending";
}

export async function reconcileLmuOpponentIndexes(
  options: { awaitPreparation?: boolean } = {},
): Promise<"ready" | "pending"> {
  if (runtimeStopping) return "pending";
  startLmuOpponentIndexRuntime();
  const assessments = await discoverSourceGroups();
  const discoveredPaths = new Set(assessments.map((assessment) => assessment.sourcePath));
  const unreferencedActiveSource = getActiveLmuOpponentSourcePaths()
    .find((sourcePath) => !discoveredPaths.has(sourcePath));
  if (unreferencedActiveSource) {
    if (options.awaitPreparation) return await deferReconciliation(unreferencedActiveSource);
    return "pending";
  }
  let pending = false;
  for (const assessment of assessments) {
    if (assessment.indexState === "waiting-finalization") {
      pending = true;
      if (options.awaitPreparation && recordingOrDraining()) return await deferReconciliation(assessment.sourcePath);
      continue;
    }
    if (assessment.indexState === "building") {
      if (options.awaitPreparation && recordingOrDraining()) return await deferReconciliation(assessment.sourcePath);
      if (!options.awaitPreparation) {
        pending = true;
        continue;
      }
      const outcome = await getOrCreateWaiter(indexRootFor(assessment.sourcePath));
      if (outcome === "failed") throw new Error(SAFE_PREPARATION_ERROR);
      if (outcome === "pending") return await deferReconciliation(assessment.sourcePath);
      continue;
    }
    if (!assessment.requiresPreparation || !assessment.candidate) continue;
    if (assessment.indexState === "failed" && options.awaitPreparation !== true) {
      pending = true;
      continue;
    }
    if (!options.awaitPreparation) {
      queueCandidate(assessment.candidate);
      pending = true;
      continue;
    }
    const waitForJob = queueCandidate(assessment.candidate);
    if (recordingOrDraining()) return await deferReconciliation(assessment.sourcePath);
    const outcome = await waitForJob;
    if (outcome === "failed") throw new Error(SAFE_PREPARATION_ERROR);
    if (outcome === "pending") return await deferReconciliation(assessment.sourcePath);
  }
  return pending ? "pending" : "ready";
}

export async function getLmuOpponentIndexStatus(source: SessionCaptureSource): Promise<{
  indexState: IndexState;
  retention: LmuOpponentRetention;
  publicationPath: string | null;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  error: string | null;
}> {
  const sourcePath = await canonicalSourcePath(source.rawFile);
  const indexRoot = indexRootFor(sourcePath);
  const retained = await readRetention(sourcePath, indexRoot);
  const rows = await readDb.select({
    id: sessions.id, rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile,
  }).from(sessions).where(or(
    eq(sessions.captureManifestFile, source.rawFile),
    eq(sessions.rawFile, source.rawFile),
    eq(sessions.captureArchiveFile, source.rawFile),
  )).all();
  const sessionIds = rows.map((row) => row.id);
  const statuses = await liveStatusBySession(sessionIds);
  const activeByInputPath = isActiveLmuOpponentSource(source.rawFile);
  const activeByCanonicalPath = isActiveLmuOpponentSource(sourcePath);
  notifyTestPort({
    type: "source-status",
    inputPath: source.rawFile,
    canonicalPath: sourcePath,
    sessions: rows.map((row, index) => ({
      id: row.id, rawFile: row.rawFile, captureManifestFile: row.captureManifestFile,
      liveStatus: statuses[index] ?? null,
    })),
    activeByInputPath,
    activeByCanonicalPath,
  });
  if (activeByInputPath || activeByCanonicalPath ||
      statuses.some((status) => ["recording", "finalizing", "recovering"].includes(status))) {
    return { indexState: "waiting-finalization", retention: retained, publicationPath: null, sourceDependencies: [], error: null };
  }
  if (retained.opponentRetention !== "retained" ||
      (retained.opponentAvailability !== "complete" &&
        !(retained.opponentAvailability === "incomplete" && await isUnmanifestedLegacyNativeSource(sourcePath)))) {
    return { indexState: "not-required", retention: retained, publicationPath: null, sourceDependencies: [], error: null };
  }
  let description: { sourceRevision: string; sourceDependencies: readonly LmuOpponentIndexSourceDependency[] };
  try {
    description = await describeLmuOpponentSource({ ...source, rawFile: sourcePath });
  } catch (error) {
    const availability = isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") ? "missing" : "corrupt";
    return {
      indexState: "not-required",
      retention: { ...retained, opponentAvailability: availability },
      publicationPath: null, sourceDependencies: [], error: null,
    };
  }
  const localFailure = memoryFailures.get(indexRoot);
  const state = await readDurableState(indexRoot);
  const failureMatches = (localFailure?.sourceRevision === description.sourceRevision &&
      dependenciesEqual(localFailure.sourceDependencies, description.sourceDependencies)) ||
    (state?.indexState === "failed" && state.sourceRevision === description.sourceRevision &&
      dependenciesEqual(state.sourceDependencies, description.sourceDependencies));
  if (activeWorkerRoots.has(indexRoot) || runningCandidateRoots.has(indexRoot)) {
    return {
      indexState: "building", retention: retained,
      publicationPath: state?.sourceRevision === description.sourceRevision &&
        dependenciesEqual(state.sourceDependencies, description.sourceDependencies) &&
        state.publicationPath && publicationPathIsContained(indexRoot, state.publicationPath)
        ? state.publicationPath : null,
      sourceDependencies: description.sourceDependencies, error: null,
    };
  }
  if (failureMatches) {
    return { indexState: "failed", retention: retained, publicationPath: null, sourceDependencies: description.sourceDependencies, error: SAFE_PREPARATION_ERROR };
  }
  if (state?.indexState === "ready" && state.sourceRevision === description.sourceRevision &&
      dependenciesEqual(state.sourceDependencies, description.sourceDependencies) && state.publicationPath &&
      publicationPathIsContained(indexRoot, state.publicationPath)) {
    try {
      await readLmuOpponentIndex(state.publicationPath, {
        sourceRevision: description.sourceRevision,
        sourceDependencies: description.sourceDependencies,
      });
      memoryFailures.delete(indexRoot);
      return { indexState: "ready", retention: retained, publicationPath: state.publicationPath, sourceDependencies: description.sourceDependencies, error: null };
    } catch {
      // A stale or incompatible publication remains invisible until background reconciliation repairs it.
    }
  }
  return { indexState: "queued", retention: retained, publicationPath: null, sourceDependencies: description.sourceDependencies, error: null };
}

async function findSessionRowsForSource(sourcePath: string): Promise<SourceRow[]> {
  const exact = await readDb.select({
    id: sessions.id, gameId: sessions.gameId, source: sessions.source,
    carId: sessions.carId, trackId: sessions.trackId, rawFile: sessions.rawFile,
    captureManifestFile: sessions.captureManifestFile, captureArchiveFile: sessions.captureArchiveFile,
    captureLayoutVersion: sessions.captureLayoutVersion, captureFormatVersion: sessions.captureFormatVersion,
  }).from(sessions).where(and(eq(sessions.gameId, "lmu"), or(
    eq(sessions.captureManifestFile, sourcePath), eq(sessions.rawFile, sourcePath), eq(sessions.captureArchiveFile, sourcePath),
  ))).all() as SourceRow[];
  if (exact.length > 0) return exact;
  const all = await readDb.select({
    id: sessions.id, gameId: sessions.gameId, source: sessions.source,
    carId: sessions.carId, trackId: sessions.trackId, rawFile: sessions.rawFile,
    captureManifestFile: sessions.captureManifestFile, captureArchiveFile: sessions.captureArchiveFile,
    captureLayoutVersion: sessions.captureLayoutVersion, captureFormatVersion: sessions.captureFormatVersion,
  }).from(sessions).where(eq(sessions.gameId, "lmu")).all() as SourceRow[];
  const canonical = await canonicalSourcePath(sourcePath);
  const matched: SourceRow[] = [];
  for (const row of all) {
    const path = row.captureManifestFile ?? row.rawFile;
    if (path && await canonicalSourcePath(path) === canonical) matched.push(row);
  }
  return matched;
}

export async function getLmuOpponentProcessing(sourcePath: string): Promise<ProcessingMetadata> {
  const canonical = await canonicalSourcePath(sourcePath);
  const activeKind = getActiveLmuOpponentSourceKind(canonical) ?? getActiveLmuOpponentSourceKind(sourcePath);
  if (activeKind === "import") return { state: "processing", stage: "capture", error: null };
  const rows = await findSessionRowsForSource(canonical);
  const row = rows[0];
  if (!row) return { state: "ready", stage: null, error: null };
  const actualPath = row.captureManifestFile ?? row.rawFile;
  if (!actualPath) return { state: "ready", stage: null, error: null };
  const source = sourceFromRow(row, await canonicalSourcePath(actualPath));
  const status = await getLmuOpponentIndexStatus(source);
  switch (status.indexState) {
    case "queued": return { state: "queued", stage: "opponent-index", error: null };
    case "building": return { state: "processing", stage: "opponent-index", error: null };
    case "failed": return { state: "failed", stage: "opponent-index", error: status.error ?? SAFE_PREPARATION_ERROR };
    case "waiting-finalization":
    case "ready":
    case "not-required":
      return { state: "ready", stage: null, error: null };
    default:
      return assertNever(status.indexState);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected opponent index state: ${String(value)}`);
}
function currentCandidateState(candidate: SourceCandidate): DurableState {
  return stateForCandidate(candidate, "building", null, null);
}

async function sessionAdmissionStillCurrent(candidate: SourceCandidate): Promise<boolean> {
  const sourceIds = candidate.sessionRows.map((row) => row.id).sort((a, b) => a - b);
  const currentRows = await readDb.select({
    id: sessions.id, gameId: sessions.gameId, source: sessions.source,
    carId: sessions.carId, trackId: sessions.trackId, rawFile: sessions.rawFile,
    captureManifestFile: sessions.captureManifestFile, captureArchiveFile: sessions.captureArchiveFile,
    captureLayoutVersion: sessions.captureLayoutVersion, captureFormatVersion: sessions.captureFormatVersion,
  }).from(sessions).where(inArray(sessions.id, sourceIds)).all() as SourceRow[];
  if (currentRows.length !== candidate.sessionRows.length ||
      currentRows.map(sourceRowSignature).sort().some((value, index) => value !== candidate.sessionRows.map(sourceRowSignature).sort()[index])) return false;
  const currentLaps = await readDb.select({
    id: laps.id, sessionId: laps.sessionId, rawByteOffset: laps.rawByteOffset,
    rawFrameCount: laps.rawFrameCount, sourceFrameStart: laps.sourceFrameStart,
    sourceFrameCount: laps.sourceFrameCount, captureChunkId: laps.captureChunkId,
  }).from(laps).where(inArray(laps.sessionId, sourceIds)).all() as LapWindowRow[];
  const expectedLaps = candidate.lapRows.map(lapRowSignature).sort();
  if (currentLaps.map(lapRowSignature).sort().some((value, index) => value !== expectedLaps[index]) || currentLaps.length !== candidate.lapRows.length) return false;
  const liveStatuses = await liveStatusBySession(sourceIds);
  return !liveStatuses.some((status) => ["recording", "finalizing", "recovering"].includes(status));
}

async function admitCandidate(candidate: SourceCandidate): Promise<boolean> {
  if (runtimeStopping || recordingOrDraining() || invalidatedRoots.has(candidate.indexRoot) ||
      isActiveLmuOpponentSource(candidate.sourcePath)) return false;
  if (!await sessionAdmissionStillCurrent(candidate)) return false;
  const previous = await readDurableState(candidate.indexRoot);
  const publicationPath = previous?.sourceRevision === candidate.sourceRevision &&
    dependenciesEqual(previous.sourceDependencies, candidate.sourceDependencies) &&
    previous.publicationPath && publicationPathIsContained(candidate.indexRoot, previous.publicationPath)
    ? previous.publicationPath : null;
  await writeDurableState(candidate.indexRoot, {
    ...currentCandidateState(candidate),
    publicationPath,
  });
  memoryFailures.delete(candidate.indexRoot);
  return true;
}


function workerPath(): string | URL {
  return IS_COMPILED
    ? "./server/session-capture/lmu-opponent-index-worker.ts"
    : new URL("./lmu-opponent-index-worker.ts", import.meta.url);
}

function runWorker(candidate: SourceCandidate): Promise<{
  result: LmuOpponentIndexBuildResult | null;
  metrics: WorkerMetrics | null;
  failed: boolean;
}> {
  return new Promise((resolveWorker) => {
    const input: WorkerInput = {
      source: candidate.source,
      sourceRevision: candidate.sourceRevision,
      sourceDependencies: candidate.sourceDependencies,
      playerLapWindows: candidate.playerLapWindows,
      indexRoot: candidate.indexRoot,
    };
    let current: Worker;
    try {
      current = new Worker(workerPath(), { workerData: input });
    } catch (error) {
      logTestDiagnostic("runWorker startup", error, candidate.sourcePath);
      if (testPort) notifyTestPort({ type: "worker-error", sourcePath: candidate.sourcePath, reason: "startup", error: error instanceof Error ? error.message : String(error) });
      resolveWorker({ result: null, metrics: null, failed: true });
      return;
    }
    let response: { result: LmuOpponentIndexBuildResult | null; metrics: WorkerMetrics | null; failed: boolean } | null = null;
    let injectedPublicationFailure = false;
    const callbacks = new Set<Promise<void>>();
    const peakSampling = isLmuOpponentIndexInstrumentationEnabled()
      ? setInterval(() => { workerPeakRssBytes = Math.max(workerPeakRssBytes, process.memoryUsage().rss); }, 25)
      : null;
    const onExit = (code: number) => {
      clearInterval(peakSampling ?? undefined);
      void Promise.allSettled([...callbacks]).then(() => {
        if (!response || code !== 0) {
          const reason = response ? `failure response missing metrics/result (exit code ${code})` : `no response received (exit code ${code})`;
          logTestDiagnostic("worker exited without success", reason, candidate.sourcePath);
          if (testPort) notifyTestPort({ type: "worker-error", sourcePath: candidate.sourcePath, reason: "exit", error: reason });
          response = { result: null, metrics: null, failed: true };
        } else if (injectedPublicationFailure) response.failed = true;
        resolveWorker(response);
      });
    };
    const publish = async (requestId: number, staged: LmuOpponentIndexStagedPublication): Promise<void> => {
      let published = false;
      try {
        await waitAtTestBarrier("before-publication-fence", candidate.sourcePath);
        const allowed = !runtimeStopping && !recordingOrDraining() &&
          !invalidatedRoots.has(candidate.indexRoot) && !isActiveLmuOpponentSource(candidate.sourcePath);
        if (!allowed || resolve(candidate.indexRoot) !== resolve(staged.publicationDirectory, "..") ||
            resolve(candidate.indexRoot) !== resolve(staged.stagingDirectory, "..") ||
            !publicationPathIsContained(candidate.indexRoot, staged.publicationPath) ||
            resolve(staged.publicationPath) !== resolve(staged.publicationDirectory, "index.json") ||
            resolve(staged.manifestPath) !== resolve(staged.stagingDirectory, "index.json") ||
            staged.manifest.sourceRevision !== candidate.sourceRevision ||
            !dependenciesEqual(staged.manifest.sourceDependencies, candidate.sourceDependencies)) {
          current.postMessage({ type: "publish-result", requestId, published } satisfies WorkerRequest);
          return;
        }
        const source = await describeLmuOpponentSource(candidate.source);
        if (source.sourceRevision !== candidate.sourceRevision ||
            !dependenciesEqual(source.sourceDependencies, candidate.sourceDependencies)) {
          current.postMessage({ type: "publish-result", requestId, published } satisfies WorkerRequest);
          return;
        }
        await waitAtTestBarrier("before-publication-reference-swap", candidate.sourcePath, undefined, true);
        const currentSource = await describeLmuOpponentSource(candidate.source);
        if (runtimeStopping || recordingOrDraining() || invalidatedRoots.has(candidate.indexRoot) ||
            isActiveLmuOpponentSource(candidate.sourcePath) ||
            currentSource.sourceRevision !== candidate.sourceRevision ||
            !dependenciesEqual(currentSource.sourceDependencies, candidate.sourceDependencies)) {
          current.postMessage({ type: "publish-result", requestId, published } satisfies WorkerRequest);
          return;
        }
        await rename(staged.stagingDirectory, staged.publicationDirectory);
        await waitAtTestBarrier("after-publication-reference-swap", candidate.sourcePath, undefined, true);
        await readLmuOpponentIndex(staged.publicationPath, {
          sourceRevision: candidate.sourceRevision,
          sourceDependencies: candidate.sourceDependencies,
        });
        await waitAtTestBarrier("before-publication-state-write", candidate.sourcePath, undefined, true);
        await writeDurableState(candidate.indexRoot, stateForCandidate(candidate, "ready", staged.publicationPath, null));
        memoryFailures.delete(candidate.indexRoot);
        published = true;
      } catch (error) {
        logTestDiagnostic("worker publication", error, candidate.sourcePath);
        if (testPort) notifyTestPort({ type: "worker-error", sourcePath: candidate.sourcePath, reason: "publication", error: error instanceof Error ? error.message : String(error) });
      }
      current.postMessage({ type: "publish-result", requestId, published } satisfies WorkerRequest);
    };
    const track = (callback: Promise<void>) => {
      callbacks.add(callback);
      void callback.then(() => callbacks.delete(callback), () => callbacks.delete(callback));
    };
    current.on("message", (message: WorkerMessage) => {
      if (message.type === "admission") {
        track((async () => {
          await waitAtTestBarrier("bounded-block-boundary", candidate.sourcePath, message.blockIndex);
          const allowed = !runtimeStopping && !recordingOrDraining() &&
            !invalidatedRoots.has(candidate.indexRoot) && !isActiveLmuOpponentSource(candidate.sourcePath);
          current.postMessage({ type: "admission-result", requestId: message.requestId, allowed } satisfies WorkerRequest);
        })().catch(() => {
          current.postMessage({ type: "admission-result", requestId: message.requestId, allowed: false } satisfies WorkerRequest);
        }));
      } else if (message.type === "publish") {
        track(publish(message.requestId, message.staged));
      } else if (message.type === "complete") {
        response = { result: message.result, metrics: message.metrics, failed: false };
      } else if (message.type === "yielded") {
        response = { result: null, metrics: message.metrics, failed: false };
      } else if (message.type === "failure") {
        logTestDiagnostic("worker failure message", message.error, candidate.sourcePath);
        if (testPort) notifyTestPort({ type: "worker-error", sourcePath: candidate.sourcePath, reason: "failure", error: message.error });
        response = { result: null, metrics: null, failed: true };
      } else {
        const type = "unknown";
        logTestDiagnostic(`unexpected worker message type ${String(type)}`, "worker response rejected", candidate.sourcePath);
        if (testPort) notifyTestPort({ type: "worker-error", sourcePath: candidate.sourcePath, reason: "unexpected-message", error: String(type) });
        response = { result: null, metrics: null, failed: true };
      }
    });
    current.on("error", (error) => {
      logTestDiagnostic("worker error event", error, candidate.sourcePath);
      if (testPort) notifyTestPort({ type: "worker-error", sourcePath: candidate.sourcePath, reason: "error-event", error: error instanceof Error ? error.message : String(error) });
      response = { result: null, metrics: null, failed: true };
    });
    current.on("exit", onExit);
  });
}

function recordBuildMetrics(
  metrics: WorkerMetrics | null,
  result: LmuOpponentIndexBuildResult | null,
): void {
  if (!metrics) return;
  recordLmuOpponentIndexMetrics({
    sourceFramesScanned: metrics.sourceFramesScanned,
    framesDecoded: metrics.nativeFramesDecoded,
    blocksWritten: result?.stats.blocksWritten ?? 0,
    bytesWritten: result?.stats.bytesWritten ?? 0,
    buildDurationMs: metrics.buildDurationMs,
    workerCpuUserMicros: metrics.workerCpuUserMicros,
    workerCpuSystemMicros: metrics.workerCpuSystemMicros,
    peakRssBytes: Math.max(workerPeakRssBytes, metrics.rssBytes),
  });
  workerPeakRssBytes = 0;
}

async function failCandidate(candidate: SourceCandidate): Promise<void> {
  const failure = stateForCandidate(candidate, "failed", null, SAFE_PREPARATION_ERROR);
  memoryFailures.set(candidate.indexRoot, failure);
  try {
    await writeDurableState(candidate.indexRoot, failure);
  } catch (error) {
    logTestDiagnostic("durable failure state write", error, candidate.sourcePath);
    // Interrupted or unwritable state remains discoverable as queued on restart.
  }
}

async function runCandidate(candidate: SourceCandidate): Promise<JobOutcome> {
  const runtime = controller ?? getRecordingMaintenanceController();
  controller = runtime;
  if (runtimeStopping || recordingOrDraining()) return "pending";
  let releaseStorage: (() => void) | null = null;
  try {
    releaseStorage = await reserveRecordingStorageOperationWhenIdle("opponent-index");
  } catch (error) {
    logTestDiagnostic("storage reservation", error, candidate.sourcePath);
    if (testPort) notifyTestPort({ type: "candidate-error", sourcePath: candidate.sourcePath, phase: "storage-reservation", location: "reserveRecordingStorageOperationWhenIdle", errorName: error instanceof Error ? error.name : typeof error, error: error instanceof Error ? error.message : String(error) });
    return "pending";
  }
  let maintenanceAdmitted = false;
  try {
    return await withSessionCaptureMaintenanceLock(async () => {
      if (runtimeStopping || recordingOrDraining() || isActiveLmuOpponentSource(candidate.sourcePath)) return "pending";
      maintenanceAdmitted = await runtime.managed.runPromise(admitMaintenance(runtime, "maintenance"));
      if (!maintenanceAdmitted) return "pending";
      try {
        await cleanupLmuOpponentIndexStaging(candidate.indexRoot);
        if (!await admitCandidate(candidate)) return "pending";
        activeWorkerRoots.add(candidate.indexRoot);
        workerActive = true;
        await waitAtTestBarrier("admission-granted", candidate.sourcePath);
        if (runtimeStopping || recordingOrDraining()) return "pending";
        const result = await runWorker(candidate);

        recordBuildMetrics(result.metrics, result.result);
        if (result.failed) {
          if (runtimeStopping || recordingOrDraining()) return "pending";
          await failCandidate(candidate);
          return "failed";
        }
        if (result.result?.published) return "ready";
        if (recordingOrDraining()) {
          notifyTestPort({ type: "worker-yielded", sourcePath: candidate.sourcePath, metrics: result.metrics });
          return "pending";
        }
        await cleanupLmuOpponentIndexStaging(candidate.indexRoot);
        return "pending";
      } catch (error) {
        logTestDiagnostic("candidate work", error, candidate.sourcePath);
        if (testPort) notifyTestPort({ type: "candidate-error", sourcePath: candidate.sourcePath, phase: "candidate-work", location: "withSessionCaptureMaintenanceLock callback", errorName: error instanceof Error ? error.name : typeof error, error: error instanceof Error ? error.message : String(error) });
        if (runtimeStopping || recordingOrDraining()) return "pending";
        await failCandidate(candidate);
        return "failed";
      } finally {
        activeWorkerRoots.delete(candidate.indexRoot);
        workerActive = false;
        if (maintenanceAdmitted) {
          await runtime.managed.runPromise(releaseMaintenance(runtime));
          maintenanceAdmitted = false;
        }
      }
    });
  } catch (error) {
    logTestDiagnostic("maintenance lock", error, candidate.sourcePath);
    if (testPort) notifyTestPort({ type: "candidate-error", sourcePath: candidate.sourcePath, phase: "maintenance-lock", location: "withSessionCaptureMaintenanceLock", errorName: error instanceof Error ? error.name : typeof error, error: error instanceof Error ? error.message : String(error) });
    if (runtimeStopping || recordingOrDraining()) return "pending";
    await failCandidate(candidate);
    return "failed";
  } finally {
    releaseStorage?.();
  }
}

async function schedulerLoop(): Promise<void> {
  let nextDiscoveryAt = 0;
  const reportedRequestedStates = new Map<string, string>();
  while (!runtimeStopping) {
    if (Date.now() >= nextDiscoveryAt || requestedSourcePaths.size > 0) {
      const requested = new Set<string>();
      try {
        for (const sourcePath of requestedSourcePaths) requested.add(await canonicalSourcePath(sourcePath));
        requestedSourcePaths.clear();
        const assessments = await discoverSourceGroups();
        const found = new Set<string>();
        for (const assessment of assessments) {
          if (assessment.candidate && assessment.indexState !== "failed") queuedCandidates.set(assessment.candidate.indexRoot, assessment.candidate);
          if (requested.has(assessment.sourcePath)) {
            found.add(assessment.sourcePath);
            const previousState = reportedRequestedStates.get(assessment.sourcePath);
            const state = `${assessment.indexState}:${assessment.retention}:${Boolean(assessment.candidate)}:${recordingOrDraining()}`;
            if (previousState !== state) {
              notifyTestPort({
                type: "scheduler-request",
                sourcePath: assessment.sourcePath,
                indexState: assessment.indexState,
                retention: assessment.retention,
                candidate: Boolean(assessment.candidate),
                recordingOrDraining: recordingOrDraining(),
              });
              if ((previousState === undefined || previousState.startsWith("waiting-finalization:"))
                && ["queued", "ready", "not-required"].includes(assessment.indexState)) {
                wsManager.broadcastNotification({ type: "lmu-opponent-catalog-updated" });
              }
            }
            if (assessment.indexState === "waiting-finalization") requestedSourcePaths.add(assessment.sourcePath);
          }
        }
        for (const sourcePath of requested) {
          if (found.has(sourcePath)) continue;
          if (reportedRequestedStates.get(sourcePath) === "missing") continue;
          reportedRequestedStates.set(sourcePath, "missing");
          notifyTestPort({ type: "scheduler-request", sourcePath, indexState: "missing" });
        }
      } catch {
        for (const sourcePath of requested) requestedSourcePaths.add(sourcePath);
      }
      nextDiscoveryAt = Date.now() + DISCOVERY_INTERVAL_MS;
    }
    if (runtimeStopping) break;
    if (!workerActive && !recordingOrDraining() && queuedCandidates.size > 0) {
      const [indexRoot, candidate] = queuedCandidates.entries().next().value as [string, SourceCandidate];
      queuedCandidates.delete(indexRoot);
      prepareCandidateWaiter(indexRoot);
      runningCandidateRoots.add(indexRoot);
      try {
        const outcome = await runCandidate(candidate);
        settleCandidate(indexRoot, outcome);
        if (outcome === "ready") queuedCandidates.delete(indexRoot);
        if (outcome === "ready" || outcome === "failed") continue;
        if (!runtimeStopping) queuedCandidates.set(indexRoot, candidate);
      } finally {
        runningCandidateRoots.delete(indexRoot);
      }
      if (runtimeStopping) continue;
    }
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (schedulerWake === finish) schedulerWake = null;
        resolveWait();
      };
      const timer = setTimeout(finish, queuedCandidates.size > 0 || requestedSourcePaths.size > 0 ? 1_000 : DISCOVERY_INTERVAL_MS);
      schedulerWake = finish;
    });
  }
}

export function startLmuOpponentIndexRuntime(): void {
  if (runtimeStarted || stopPromise) return;
  runtimeStopping = false;
  const runtime = getRecordingMaintenanceController();
  controller = runtime;
  runtimeStarted = true;
  schedulerFiber = trackMaintenanceFiber(runtime, runtime.managed.runFork(Effect.promise(() => schedulerLoop())));
  const fiber = schedulerFiber;
  fiber.addObserver(() => {
    if (schedulerFiber?.id === fiber.id) {
      schedulerFiber = null;
      runtimeStarted = false;
    }
  });
  wakeScheduler();
}

export function enqueueLmuOpponentIndex(sourcePath: string): void {
  const lexicalPath = resolve(sourcePath);
  const enqueue = (requestedPath: string) => {
    if (runtimeStopping) {
      notifyTestPort({ type: "scheduler-enqueue-ignored", sourcePath: requestedPath, reason: "runtime-stopping" });
      return;
    }
    requestedSourcePaths.add(requestedPath);
    notifyTestPort({ type: "scheduler-enqueue", sourcePath: requestedPath });
    wsManager.broadcastNotification({ type: "lmu-opponent-catalog-updated" });
  };
  void canonicalSourcePath(sourcePath).then(enqueue, () => enqueue(lexicalPath));
}

export async function stopLmuOpponentIndexRuntime(): Promise<void> {
  if (stopPromise) return stopPromise;
  runtimeStopping = true;
  wakeScheduler();
  const runtime = controller;
  const fiber = schedulerFiber;
  if (!runtime || !fiber) {
    runtimeStarted = false;
    queuedCandidates.clear();
    return;
  }
  stopPromise = (async () => {
    try {
      await runtime.managed.runPromise(Effect.ignore(Fiber.join(fiber)));
    } finally {
      schedulerFiber = null;
      runtimeStarted = false;
      workerActive = false;
      activeWorkerRoots.clear();
      queuedCandidates.clear();
      requestedSourcePaths.clear();
    }
  })();
  try { await stopPromise; } finally { stopPromise = null; }
}


export async function reportLmuOpponentIndexReadFailure(
  source: SessionCaptureSource,
  publicationPath: string,
): Promise<void> {
  const canonical = await canonicalSourcePath(source.rawFile);
  const indexRoot = indexRootFor(canonical);
  if (!publicationPathIsContained(indexRoot, publicationPath)) return;
  const release = await reserveRecordingStorageOperationWhenIdle("opponent-index");
  try {
    await withSessionCaptureMaintenanceLock(async () => {
      const current = await readDurableState(indexRoot);
      if (current?.indexState !== "ready" || current.publicationPath !== publicationPath) return;
      await writeDurableState(indexRoot, { ...current, indexState: "queued", publicationPath: null, error: null });
      invalidatedRoots.add(indexRoot);
      await invalidateLmuOpponentIndex(publicationPath);
      memoryFailures.delete(indexRoot);
      queuedCandidates.delete(indexRoot);
      requestedSourcePaths.add(canonical);
    });
  } finally {
    invalidatedRoots.delete(indexRoot);
    release();
  }
  wakeScheduler();
}

export async function revokeLmuOpponentIndex(sourcePath: string): Promise<void> {
  const canonical = await canonicalSourcePath(sourcePath);
  const indexRoot = indexRootFor(canonical);
  const release = await reserveRecordingStorageOperationWhenIdle("opponent-index");
  try {
    await withSessionCaptureMaintenanceLock(async () => {
      const current = await readDurableState(indexRoot);
      await writeDurableState(indexRoot, {
        version: STATE_VERSION, indexState: "queued", sourceRevision: "revoked",
        sourceDependencies: [], publicationPath: null, error: null,
      });
      if (current?.publicationPath && publicationPathIsContained(indexRoot, current.publicationPath)) {
        await invalidateLmuOpponentIndex(current.publicationPath);
      }
      memoryFailures.delete(indexRoot);
      queuedCandidates.delete(indexRoot);
    });
  } finally { release(); }
}

export async function invalidateLmuOpponentIndexUnderFence(sourcePath: string): Promise<void> {
  const canonical = await canonicalSourcePath(sourcePath);
  const indexRoot = indexRootFor(canonical);
  const previous = await readDurableState(indexRoot);
  if (previous) {
    await writeDurableState(indexRoot, { ...previous, indexState: "queued", publicationPath: null, error: null });
  }
  memoryFailures.delete(indexRoot);
  queuedCandidates.delete(indexRoot);
}

