import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { open as openFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, join, resolve } from "path";
import { resolveDataDir } from "./data-dir";
import { IRacingIbtReader } from "./games/iracing/ibt-reader";
import { parseIRacingSessionInfo } from "./games/iracing/session-info";
import {
  encodeIRacingSourceFrame,
  type IRacingSessionSnapshot,
  type IRacingValue,
} from "./games/iracing/source-frame";
import { importSessionFrames } from "./import-session-bin";

const STAGE_TTL_MS = 30 * 60 * 1000;
const MAX_IBT_BYTES = 8 * 1024 * 1024 * 1024;
const DRIVING_SPEED_MPS = 1;
const TIMING_ROLLOVER_SECONDS = 5;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REQUIRED_IMPORT_VARIABLES = [
  "SessionTime",
  "SessionNum",
  "IsOnTrack",
  "Speed",
  "Lap",
  "LapLastLapTime",
  "LapCurrentLapTime",
] as const;

export interface IbtImportPreview {
  gameId: "iracing";
  fileName: string;
  fileSize: number;
  tickRate: number;
  recordCount: number;
  durationSeconds: number;
  sessionStartDate: string;
  trackId: number;
  trackName: string;
  carId: number;
  carName: string;
  carClassName: string;
  missingRaceIQVariables: string[];
  missingRequiredVariables: string[];
  drivingFrames: number;
  pitRoadFrames: number;
  lapTransitions: number;
  candidateLapCount: number;
  maxSpeedMph: number;
  firstDrivingRecord: number | null;
  lastDrivingRecord: number | null;
  canImport: boolean;
  reason: string | null;
}

interface StagedIbtManifest {
  version: 1;
  createdAt: number;
  preview: IbtImportPreview;
}

interface SessionScanState {
  lastLap: number | null;
  transitions: number;
  candidateLaps: number;
  skipFirstCompletion: boolean;
}

export class IbtImportError extends Error {
  readonly status: 400 | 404 | 410 | 413;

  constructor(
    message: string,
    status: 400 | 404 | 410 | 413 = 400,
  ) {
    super(message);
    this.name = "IbtImportError";
    this.status = status;
  }
}

function stageDir(): string {
  const path = resolve(resolveDataDir(), "imports", "ibt");
  mkdirSync(path, { recursive: true });
  return path;
}

function stagePaths(token: string): { ibt: string; manifest: string } {
  if (!TOKEN_PATTERN.test(token)) {
    throw new IbtImportError("Invalid staged IBT token");
  }
  const root = stageDir();
  return {
    ibt: join(root, `${token}.ibt`),
    manifest: join(root, `${token}.json`),
  };
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function removeStage(token: string): void {
  const paths = stagePaths(token);
  removeIfPresent(paths.ibt);
  removeIfPresent(paths.manifest);
}

function cleanupExpiredStages(): void {
  const root = stageDir();
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const name of readdirSync(root)) {
    const suffix = name.endsWith(".json")
      ? ".json"
      : name.endsWith(".ibt")
        ? ".ibt"
        : null;
    if (!suffix) continue;
    const token = name.slice(0, -suffix.length);
    if (!TOKEN_PATTERN.test(token)) continue;
    const stagedPath = join(root, name);
    try {
      if (statSync(stagedPath).mtimeMs < cutoff) removeStage(token);
    } catch {
      removeStage(token);
    }
  }
}

function numeric(
  values: Record<string, IRacingValue>,
  name: string,
  fallback = 0,
): number {
  const value = values[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function truthy(
  values: Record<string, IRacingValue>,
  name: string,
): boolean {
  const value = values[name];
  return value === true ||
    (typeof value === "number" && Number.isFinite(value) && value !== 0);
}

function safeUploadName(name: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  })();
  const leaf = basename(decoded.replaceAll("\\", "/"));
  return leaf && leaf.toLowerCase().endsWith(".ibt")
    ? leaf
    : "session.ibt";
}

export async function previewIbtFile(
  path: string,
  fileName = basename(path),
): Promise<IbtImportPreview> {
  const reader = new IRacingIbtReader(path);
  reader.start();
  try {
    const metadata = reader.metadata;
    if (!metadata) throw new IbtImportError("Unable to read IBT metadata");

    const missingRequiredVariables = REQUIRED_IMPORT_VARIABLES.filter(
      (name) => metadata.missingRaceIQVariables.includes(name),
    );
    const sessions = new Map<number, SessionScanState>();
    let identity: IRacingSessionSnapshot | null = null;
    let drivingFrames = 0;
    let pitRoadFrames = 0;
    let maxSpeedMps = 0;
    let firstDrivingRecord: number | null = null;
    let lastDrivingRecord: number | null = null;

    for (;;) {
      const snapshot = reader.readLatest();
      if (!snapshot) break;
      const recordIndex = reader.recordsRead - 1;
      const values = snapshot.values;
      const speed = Math.max(0, numeric(values, "Speed"));
      maxSpeedMps = Math.max(maxSpeedMps, speed);
      if (truthy(values, "OnPitRoad")) pitRoadFrames++;

      const sessionNum = Math.trunc(numeric(values, "SessionNum"));
      identity ??= parseIRacingSessionInfo(
        snapshot.sessionInfo,
        sessionNum,
      );

      const isDriving =
        truthy(values, "IsOnTrack") &&
        !truthy(values, "OnPitRoad") &&
        speed >= DRIVING_SPEED_MPS;
      if (!isDriving) continue;

      drivingFrames++;
      firstDrivingRecord ??= recordIndex;
      lastDrivingRecord = recordIndex;

      const lap = Math.max(0, Math.trunc(numeric(values, "Lap")));
      const state = sessions.get(sessionNum) ?? {
        lastLap: null,
        transitions: 0,
        candidateLaps: 0,
        skipFirstCompletion: true,
      };
      if (state.lastLap !== null && lap === state.lastLap + 1) {
        state.transitions++;
        if (state.skipFirstCompletion) {
          state.skipFirstCompletion = false;
        } else {
          state.candidateLaps++;
        }
      } else if (state.lastLap !== null && lap !== state.lastLap) {
        state.skipFirstCompletion = true;
      }
      if (state.lastLap === null || lap !== state.lastLap) {
        state.lastLap = lap;
      }
      sessions.set(sessionNum, state);
    }

    const lapTransitions = [...sessions.values()].reduce(
      (sum, state) => sum + state.transitions,
      0,
    );
    const candidateLapCount = [...sessions.values()].reduce(
      (sum, state) => sum + state.candidateLaps,
      0,
    );
    const durationSeconds =
      metadata.recordCount > 1
        ? (metadata.recordCount - 1) / metadata.tickRate
        : 0;

    let reason: string | null = null;
    if (missingRequiredVariables.length > 0) {
      reason =
        "This recording is missing channels required for RaceIQ lap import: " +
        missingRequiredVariables.join(", ");
    } else if (drivingFrames === 0) {
      reason =
        "No on-track driving above 2.2 mph was found in this recording";
    } else if (candidateLapCount === 0) {
      reason =
        "No complete laps were found; RaceIQ discards the partial lap at the start of an IBT recording";
    }

    return {
      gameId: "iracing",
      fileName: safeUploadName(fileName),
      fileSize: metadata.fileSize,
      tickRate: metadata.tickRate,
      recordCount: metadata.recordCount,
      durationSeconds,
      sessionStartDate: metadata.sessionStartDate.toISOString(),
      trackId: identity?.trackId ?? -1,
      trackName: identity?.trackName ?? "Unknown iRacing track",
      carId: identity?.carId ?? -1,
      carName: identity?.carName ?? "Unknown iRacing car",
      carClassName: identity?.carClassName ?? "Unknown class",
      missingRaceIQVariables: [...metadata.missingRaceIQVariables],
      missingRequiredVariables,
      drivingFrames,
      pitRoadFrames,
      lapTransitions,
      candidateLapCount,
      maxSpeedMph: maxSpeedMps * 2.2369362921,
      firstDrivingRecord,
      lastDrivingRecord,
      canImport: reason === null,
      reason,
    };
  } finally {
    await reader.stop();
  }
}

export async function stageIbtUpload(
  body: ReadableStream<Uint8Array> | null,
  fileName: string,
  declaredBytes?: number,
): Promise<{ token: string | null; preview: IbtImportPreview }> {
  cleanupExpiredStages();
  if (!body) throw new IbtImportError("Missing IBT request body");
  if (
    declaredBytes !== undefined &&
    (!Number.isSafeInteger(declaredBytes) ||
      declaredBytes <= 0 ||
      declaredBytes > MAX_IBT_BYTES)
  ) {
    throw new IbtImportError(
      `IBT upload exceeds the ${MAX_IBT_BYTES / 1024 ** 3} GiB limit`,
      413,
    );
  }

  const token = randomUUID();
  const paths = stagePaths(token);
  const file = await openFile(paths.ibt, "wx");
  const reader = body.getReader();
  let bytesWritten = 0;
  let uploadFailure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesWritten += value.byteLength;
      if (bytesWritten > MAX_IBT_BYTES) {
        throw new IbtImportError(
          `IBT upload exceeds the ${MAX_IBT_BYTES / 1024 ** 3} GiB limit`,
          413,
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (result.bytesWritten === 0) {
          throw new IbtImportError("IBT staging write stopped unexpectedly");
        }
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    uploadFailure = error;
  } finally {
    await file.close();
    reader.releaseLock();
  }
  if (uploadFailure) {
    removeIfPresent(paths.ibt);
    throw uploadFailure;
  }

  if (bytesWritten === 0) {
    removeIfPresent(paths.ibt);
    throw new IbtImportError("The uploaded IBT file is empty");
  }
  if (declaredBytes !== undefined && bytesWritten !== declaredBytes) {
    removeIfPresent(paths.ibt);
    throw new IbtImportError(
      `Incomplete IBT upload: expected ${declaredBytes} bytes, received ${bytesWritten}`,
    );
  }

  try {
    const preview = await previewIbtFile(paths.ibt, fileName);
    if (!preview.canImport) {
      removeIfPresent(paths.ibt);
      return { token: null, preview };
    }
    const manifest: StagedIbtManifest = {
      version: 1,
      createdAt: Date.now(),
      preview,
    };
    writeFileSync(paths.manifest, JSON.stringify(manifest));
    return { token, preview };
  } catch (error) {
    removeIfPresent(paths.ibt);
    removeIfPresent(paths.manifest);
    throw error;
  }
}

function loadManifest(token: string): {
  paths: { ibt: string; manifest: string };
  manifest: StagedIbtManifest;
} {
  cleanupExpiredStages();
  const paths = stagePaths(token);
  if (!existsSync(paths.ibt) || !existsSync(paths.manifest)) {
    throw new IbtImportError(
      "This IBT preview has expired or was already used",
      410,
    );
  }

  let manifest: StagedIbtManifest;
  try {
    manifest = JSON.parse(
      readFileSync(paths.manifest, "utf8"),
    ) as StagedIbtManifest;
  } catch {
    removeStage(token);
    throw new IbtImportError("The staged IBT manifest is invalid", 410);
  }
  if (
    manifest.version !== 1 ||
    !manifest.preview?.canImport ||
    Date.now() - manifest.createdAt > STAGE_TTL_MS
  ) {
    removeStage(token);
    throw new IbtImportError("This IBT preview has expired", 410);
  }
  if (statSync(paths.ibt).size !== manifest.preview.fileSize) {
    removeStage(token);
    throw new IbtImportError("The staged IBT file changed after preview", 410);
  }
  return { paths, manifest };
}

async function* ibtFrames(
  path: string,
  preview: IbtImportPreview,
): AsyncGenerator<Buffer> {
  const reader = new IRacingIbtReader(path);
  const sessionCache = new Map<number, IRacingSessionSnapshot>();
  const lastRecord = Math.min(
    preview.recordCount - 1,
    (preview.lastDrivingRecord ?? 0) +
      Math.ceil(preview.tickRate * TIMING_ROLLOVER_SECONDS),
  );
  reader.start();
  try {
    for (;;) {
      const snapshot = reader.readLatest();
      if (!snapshot) break;
      const recordIndex = reader.recordsRead - 1;
      if (
        preview.firstDrivingRecord === null ||
        recordIndex < preview.firstDrivingRecord
      ) {
        continue;
      }
      if (recordIndex > lastRecord) break;

      const sessionNum = Math.trunc(
        numeric(snapshot.values, "SessionNum"),
      );
      let session = sessionCache.get(sessionNum);
      if (!session) {
        session = parseIRacingSessionInfo(
          snapshot.sessionInfo,
          sessionNum,
        );
        sessionCache.set(sessionNum, session);
      }
      yield encodeIRacingSourceFrame({
        schemaVersion: 1,
        session,
        values: snapshot.values,
      });
    }
  } finally {
    await reader.stop();
  }
}

export async function commitStagedIbt(token: string): Promise<{
  packetCount: number;
  laps: Awaited<ReturnType<typeof importSessionFrames>>["laps"];
  preview: IbtImportPreview;
}> {
  const { paths, manifest } = loadManifest(token);
  try {
    try {
      const result = await importSessionFrames(
        ibtFrames(paths.ibt, manifest.preview),
        "iracing",
        { requireLaps: true },
      );
      return {
        packetCount: result.packetCount,
        laps: result.laps,
        preview: manifest.preview,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "No complete, importable laps were found"
      ) {
        throw new IbtImportError(error.message);
      }
      throw error;
    }
  } finally {
    removeStage(token);
  }
}

export function cancelStagedIbt(token: string): void {
  removeStage(token);
}
