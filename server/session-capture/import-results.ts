import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { KNOWN_GAME_IDS } from "@raceiq/shared/games/ids";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import { deleteSession, updateSessionSource } from "../db/session-queries";
import { getRecorderEngine, runRecordingJob, type RecorderEngine } from "../runtime/recorder-engine";
import { RealDbAdapter } from "../telemetry/pipeline-ports";
import { deriveRecordedLap, persistRecordedLapFollowups } from "../lap-analysis/recorded-lap";
import { notifyDriverProfileLap } from "../driver-profile/lap-notifier";
import { resolveDataDir } from "../runtime/config/data-dir";
import { reconcileSessionResult } from "../race-results/reconcile";
import { applyFrameTime } from "./frame-time";
import type { ImportedLap, ImportSessionResult } from "./import-pipeline";

export interface RustManifestLap {
  lapKey: string;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason?: string | null;
  rawByteOffset: string;
  rawFrameCount: number;
  provisional?: boolean;
  analysisRecipe?: unknown;
  sectors?: number[] | null;
}
export interface RustManifestSession {
  engineSessionId: string;
  gameId: GameId;
  carOrdinal: number;
  trackOrdinal: number;
  carPI?: number;
  sessionType?: string;
  identity?: { carId?: string; trackId?: string };
  rawFile: string;
  sparseCapture?: boolean;
  detectorVersion?: string;
  versionIdentity?: TelemetryVersionIdentity;
  laps: RustManifestLap[];
}
export interface RustImportManifest {
  version: 1;
  jobId: string;
  operation: "import" | "preview" | "reprocess";
  packetCount: number;
  sessions: RustManifestSession[];
  preview?: unknown;
  artifacts?: string[];
  [key: string]: unknown;
}
export interface StagedRecorderJob {
  path: string;
  originalName: string;
  outputRoot: string;
  jobId: string;
  operation: "preview" | "import" | "reprocess";
  gameId?: GameId;
  format?: string;
  options?: Record<string, unknown>;
  sidecarPath?: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Rust ${label}`);
  return value as Record<string, unknown>;
}
function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`Invalid Rust ${label}`);
  return value;
}
function safeOffset(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid Rust ${label}`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Rust ${label} exceeds safe integer range`);
  return Number(parsed);
}
function containedPath(root: string, path: unknown, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Invalid Rust ${label} path`);
  const base = realpathSync(root);
  const full = realpathSync(path);
  const rel = relative(base, full);
  if (rel === "" || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || rel === ".." || isAbsolute(rel)) throw new Error(`Rust ${label} path escapes job root`);
  return full;
}
export function validateRustImportManifest(value: unknown, expected: { jobId: string; outputRoot: string; authorizedSourcePaths?: readonly string[] }): RustImportManifest {
  const manifest = object(value, "result manifest");
  if (manifest.version !== 1 || manifest.jobId !== expected.jobId || !["import", "preview", "reprocess"].includes(String(manifest.operation))) throw new Error("Rust import manifest identity mismatch");
  safeCount(manifest.packetCount, "packet count");
  if (!Array.isArray(manifest.sessions)) throw new Error("Invalid Rust sessions manifest");
  for (const rawSession of manifest.sessions) {
    const session = object(rawSession, "session");
    if (typeof session.engineSessionId !== "string" || typeof session.gameId !== "string" || !KNOWN_GAME_IDS.includes(session.gameId as GameId) || !Number.isSafeInteger(session.carOrdinal) || !Number.isSafeInteger(session.trackOrdinal) || !Array.isArray(session.laps)) throw new Error("Invalid Rust session descriptor");
    try {
      containedPath(expected.outputRoot, session.rawFile, "capture");
    } catch (error) {
      if (manifest.operation !== "reprocess" || typeof session.rawFile !== "string" || !isAbsolute(session.rawFile) || !expected.authorizedSourcePaths?.some((source) => realpathSync(source) === realpathSync(session.rawFile as string))) throw error;
    }
    for (const rawLap of session.laps) {
      const lap = object(rawLap, "lap");
      if (typeof lap.lapKey !== "string" || !Number.isSafeInteger(lap.lapNumber) || typeof lap.lapTime !== "number" || !Number.isFinite(lap.lapTime) || typeof lap.isValid !== "boolean") throw new Error("Invalid Rust lap descriptor");
      safeOffset(lap.rawByteOffset, "lap offset");
      safeCount(lap.rawFrameCount, "lap frame count");
    }
  }
  if (manifest.artifacts !== undefined) {
    if (!Array.isArray(manifest.artifacts)) throw new Error("Invalid Rust artifact list");
    for (const file of manifest.artifacts) containedPath(expected.outputRoot, file, "artifact");
  }
  return manifest as unknown as RustImportManifest;
}
async function readResultFile(response: unknown, expectedJobId: string, outputRoot: string): Promise<Record<string, unknown>> {
  const result = object(response, "job response");
  if (result.jobId !== expectedJobId) throw new Error("Rust job response ID mismatch");
  const resultPath = containedPath(outputRoot, result.resultPath, "manifest");
  if (!(await Bun.file(resultPath).exists())) throw new Error("Rust result manifest is missing");
  return object(await Bun.file(resultPath).json(), "result manifest");
}
async function materializeRecipe(engine: RecorderEngine, rawFile: string, outputRoot: string, jobId: string, gameId: GameId, recipeValue: unknown, options: { carOrdinal: number; trackOrdinal: number }, finalizationRead = false): Promise<TelemetryPacket[]> {
  const recipe = object(recipeValue, "analysis recipe");
  if (!Array.isArray(recipe.ranges)) throw new Error("Rust analysis recipe has no ranges");
  const ranges = recipe.ranges.map((entry) => {
    const range = object(entry, "analysis range");
    return { offset: safeOffset(range.offset, "analysis range offset").toString(), count: safeCount(range.count, "analysis range count") };
  });
  const engineJob = `${jobId}-lap-${randomUUID()}`;
  const input = {
    jobId: engineJob,
    mode: "read-lap-window",
    input: { path: rawFile },
    ranges,
    contextOffset: recipe.contextOffset === null || recipe.contextOffset === undefined ? null : safeOffset(recipe.contextOffset, "analysis context offset").toString(),
    options: { gameId, ...options },
    outputRoot,
  };
  const response = finalizationRead
    ? await engine.requestFinalizationRead("read-lap-window", input)
    : await engine.request("read-lap-window", input);
  const replay = await readResultFile(response, engineJob, outputRoot);
  if (replay.version !== 1 || replay.jobId !== engineJob || replay.operation !== "read-lap-window" || replay.gameId !== gameId || !Array.isArray(replay.packets)) throw new Error("Rust replay manifest identity mismatch");
  const offsetPackets = replay.packets.map((item) => {
    const frame = object(item, "replay packet");
    const offset = safeOffset(frame.offset, "replay packet offset");
    const packet = object(frame.packet, "telemetry packet") as unknown as TelemetryPacket;
    if (packet.gameId !== gameId) throw new Error("Rust replay packet game identity mismatch");
    const frameTimeMs = frame.frameTimeMs === null || frame.frameTimeMs === undefined ? undefined : safeOffset(frame.frameTimeMs, "replay frame time");
    applyFrameTime(packet, frameTimeMs);
    return { offset, packet };
  });
  const packets = offsetPackets.map(({ packet }) => packet);
  if (Array.isArray(recipe.appendPackets)) packets.push(...recipe.appendPackets as TelemetryPacket[]);
  if (Array.isArray(recipe.overrides)) {
    for (const value of recipe.overrides) {
      const override = object(value, "analysis override");
      const offset = safeOffset(override.offset, "analysis override offset");
      const target = offsetPackets.find((entry) => entry.offset === offset);
      if (target && override.fields && typeof override.fields === "object") Object.assign(target.packet, override.fields);
    }
  }
  return packets;
}
export async function readRustLapWindow(rawFile: string, gameId: GameId, carOrdinal: number, trackOrdinal: number, rawByteOffset: number, rawFrameCount: number): Promise<TelemetryPacket[]> {
  const engine = getRecorderEngine();
  if (!engine) throw new Error("Rust recorder is not registered");
  const root = resolve(resolveDataDir(), "recorder-jobs");
  const jobId = `replay-lap-${randomUUID()}`;
  return runRecordingJob(() => materializeRecipe(engine, rawFile, root, jobId, gameId, {
    ranges: [{ offset: String(rawByteOffset), count: rawFrameCount }],
    contextOffset: null,
  }, { carOrdinal, trackOrdinal }, false));
}

export interface RustCaptureRead {
  offsetEncoding: "byte" | "packet-index" | "legacy-bin-byte-offset";
  packets: Array<{ offset: number; frameTimeMs?: number; packet: TelemetryPacket }>;
  markers: unknown[];
}
export async function readCapturePacketsWithRust(input: {
  rawFile: string;
  gameId: GameId;
  carOrdinal: number;
  trackOrdinal: number;
}): Promise<RustCaptureRead> {
  return runRecordingJob(async () => {
    const engine = getRecorderEngine();
    if (!engine) throw new Error("Rust recorder is not registered");
    const outputRoot = resolve(resolveDataDir(), "recorder-jobs");
    const jobId = `read-capture-${randomUUID()}`;
    const response = await engine.request("read-capture", {
      jobId,
      mode: "read-capture",
      input: { path: input.rawFile },
      options: { gameId: input.gameId, carOrdinal: input.carOrdinal, trackOrdinal: input.trackOrdinal },
      outputRoot,
    });
    const manifest = await readResultFile(response, jobId, outputRoot);
    if (manifest.version !== 1 || manifest.jobId !== jobId || manifest.operation !== "read-capture" || manifest.gameId !== input.gameId || !Array.isArray(manifest.packets) || !Array.isArray(manifest.markers)) throw new Error("Rust capture read manifest identity mismatch");
    if (!["byte", "packet-index", "legacy-bin-byte-offset"].includes(String(manifest.offsetEncoding))) throw new Error("Invalid Rust capture offset encoding");
    const packets = manifest.packets.map((item) => {
      const frame = object(item, "capture packet");
      const offset = safeOffset(frame.offset, "capture packet offset");
      const packet = object(frame.packet, "telemetry packet") as unknown as TelemetryPacket;
      if (packet.gameId !== input.gameId) throw new Error("Rust capture packet game identity mismatch");
      const frameTimeMs = frame.frameTimeMs === null || frame.frameTimeMs === undefined ? undefined : safeOffset(frame.frameTimeMs, "capture frame time");
      applyFrameTime(packet, frameTimeMs);
      return { offset, frameTimeMs, packet };
    });
    return { offsetEncoding: manifest.offsetEncoding as RustCaptureRead["offsetEncoding"], packets, markers: manifest.markers };
  });
}
export async function materializeRecordedLapRecipe(captureId: string, gameId: GameId, rawFile: string, recipe: unknown, options: { carOrdinal: number; trackOrdinal: number }, finalizationRead = false): Promise<TelemetryPacket[]> {
  const engine = getRecorderEngine();
  if (!engine) throw new Error("Rust recorder is not registered");
  return materializeRecipe(engine, rawFile, resolve(resolveDataDir(), "recorder-jobs"), `live-${captureId}`, gameId, recipe, options, finalizationRead);
}
async function runStagedRecorderJob(engine: RecorderEngine, input: StagedRecorderJob): Promise<RustImportManifest> {
  const outputRoot = resolve(input.outputRoot);
  const configuredJobRoot = resolve(resolveDataDir(), "recorder-jobs");
  containedPath(configuredJobRoot, outputRoot, "job output");
  containedPath(configuredJobRoot, input.path, "staged input");
  if (input.sidecarPath) containedPath(configuredJobRoot, input.sidecarPath, "sidecar");
  const response = await engine.request(input.operation, {
    jobId: input.jobId,
    mode: input.operation,
    input: { path: input.path, originalName: input.originalName, format: input.format, sidecarPath: input.sidecarPath },
    options: { ...input.options, gameId: input.gameId },
    outputRoot: input.outputRoot,
  });
  const manifest = validateRustImportManifest(await readResultFile(response, input.jobId, input.outputRoot), { jobId: input.jobId, outputRoot: input.outputRoot });
  if (manifest.operation !== input.operation) throw new Error(`Rust returned ${manifest.operation} manifest for ${input.operation} job`);
  return manifest;
}
export async function requestRustReprocess(input: { rawFile: string; gameId: GameId; sessionId: number; carOrdinal: number; trackOrdinal: number }): Promise<RustImportManifest> {
  const engine = getRecorderEngine();
  if (!engine) throw new Error("Rust recorder is not registered");
  const dataRoot = resolve(resolveDataDir());
  const rawFile = containedPath(dataRoot, input.rawFile, "source capture");
  const outputRoot = resolve(dataRoot, "recorder-jobs", `reprocess-${randomUUID()}`);
  const jobId = `reprocess-${randomUUID()}`;
  const response = await engine.request("reprocess", {
    jobId,
    mode: "reprocess",
    input: { path: rawFile, originalName: basename(rawFile) },
    options: { sessionId: input.sessionId, gameId: input.gameId, carOrdinal: input.carOrdinal, trackOrdinal: input.trackOrdinal },
    outputRoot,
  });
  const manifest = validateRustImportManifest(
    await readResultFile(response, jobId, outputRoot),
    { jobId, outputRoot, authorizedSourcePaths: [rawFile] },
  );
  if (manifest.operation !== "reprocess") throw new Error("Rust returned non-reprocess manifest for reprocess job");
  return manifest;
}
export function previewStagedWithRust(input: StagedRecorderJob): Promise<RustImportManifest> {
  if (input.operation !== "preview") throw new Error("Preview job must use preview operation");
  return runRecordingJob(async () => {
    const engine = getRecorderEngine();
    if (!engine) throw new Error("Rust recorder is not registered");
    return runStagedRecorderJob(engine, input);
  });
}

/** Consume staged original input; Rust owns parse/detection/write decisions. */
export function importStagedWithRust(input: {
  path: string;
  originalName: string;
  outputRoot: string;
  jobId: string;
  gameId?: GameId;
  format?: string;
  options?: Record<string, unknown>;
  sidecarPath?: string;
  ownership?: SessionOwnership;
  sessionSource?: string;
  requireLaps?: boolean;
  notifyDriverProfile?: boolean;
  captureStorage?: "sparse" | "raw";
  onImportedLaps?: (laps: readonly ImportedLap[]) => Promise<void>;
}): Promise<ImportSessionResult & { manifest: RustImportManifest }> {
  return runRecordingJob(async () => {
    const engine = getRecorderEngine();
    if (!engine) throw new Error("Rust recorder is not registered");
    const manifest = await runStagedRecorderJob(engine, {
      path: input.path,
      originalName: input.originalName,
      outputRoot: input.outputRoot,
      jobId: input.jobId,
      operation: "import",
      gameId: input.gameId,
      format: input.format,
      sidecarPath: input.sidecarPath,
      options: { ...input.options, captureStorage: input.captureStorage },
    });
    const db = new RealDbAdapter({ notifyDriverProfile: false, ownership: input.ownership });
    const createdSessions: number[] = [];
    const ownedFiles = new Set((manifest.artifacts ?? []).map((artifact) => containedPath(input.outputRoot, artifact, "artifact")));
    const laps: ImportedLap[] = [];
    try {
      for (const session of manifest.sessions) {
        const rawFile = containedPath(input.outputRoot, session.rawFile, "capture");
        if (!(await Bun.file(rawFile).exists())) throw new Error(`Rust capture artifact missing: ${rawFile}`);
        ownedFiles.add(rawFile);
        if (session.gameId !== (input.gameId ?? session.gameId)) throw new Error("Rust import game identity mismatch");
        const versionIdentity = session.versionIdentity;
        const sessionId = await db.insertSession(session.carOrdinal, session.trackOrdinal, session.gameId, session.sessionType, versionIdentity, input.ownership, session.identity?.carId && session.identity.trackId ? { carId: session.identity.carId, trackId: session.identity.trackId } : undefined);
        createdSessions.push(sessionId);
        if (input.sessionSource) await updateSessionSource(sessionId, input.sessionSource);
        await db.updateSessionRawFile(sessionId, rawFile, session.detectorVersion ?? "rust-recorder_v1", session.sparseCapture ?? true);
        for (const lap of session.laps) {
          if (lap.provisional) continue;
          const offset = safeOffset(lap.rawByteOffset, "lap offset");
          const packets = lap.analysisRecipe === undefined ? [] : await materializeRecipe(engine, rawFile, input.outputRoot, input.jobId, session.gameId, lap.analysisRecipe, { carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal });
          const derived = await deriveRecordedLap({ db, gameId: session.gameId, trackOrdinal: session.trackOrdinal, packets, lapTime: lap.lapTime, isValid: lap.isValid });
          const tune = await db.getTuneAssignment(session.gameId, session.carOrdinal, session.trackOrdinal);
          const sectors = lap.sectors ?? derived.sectors;
          const lapId = await db.insertLap(sessionId, lap.lapNumber, lap.lapTime, lap.isValid, offset, lap.rawFrameCount, null, tune?.tuneId ?? null, lap.invalidReason ?? null, sectors, versionIdentity);
          await persistRecordedLapFollowups(db, lapId, packets);
          laps.push({ lapId, sessionId, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, carId: session.identity?.carId ?? session.carOrdinal, trackId: session.identity?.trackId ?? session.trackOrdinal });
        }
      }
      if (input.requireLaps && laps.length === 0) throw new Error("No complete, importable laps were found");
      for (let index = 0; index < manifest.sessions.length; index++) {
        const sessionId = createdSessions[index];
        if (sessionId !== undefined) await reconcileSessionResult(sessionId, manifest.sessions[index]!.gameId);
      }
      await input.onImportedLaps?.(laps);
      if (input.notifyDriverProfile !== false) {
        for (const session of manifest.sessions) if (session.laps.some((lap) => !lap.provisional)) notifyDriverProfileLap(session.gameId);
      }
      return { packetCount: manifest.packetCount, laps, sessionIds: createdSessions, manifest };
    } catch (error) {
      for (const sessionId of createdSessions) await deleteSession(sessionId);
      for (const file of ownedFiles) if (existsSync(file)) unlinkSync(file);
      throw error;
    }
  });
}
