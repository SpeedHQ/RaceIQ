import { eq, inArray, isNotNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { open, readdir, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionDownsamplePreview, SessionDownsampleRequest, SessionDownsampleSkip, SessionDownsampleStatus } from "@raceiq/shared/racing/sessions/downsample";
import type { DownsampleLapIndex, DownsampleRecordingInput, DownsampleRecordingInspection } from "@raceiq/capture-formats/session/downsample";
import { DownsampleRecordingError, inspectDownsampleRecording, rewriteDownsampleRecording, validateDownsampleRecording } from "@raceiq/capture-formats/session/downsample";
import { getServerGame } from "../games/registry";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { isOwnedSessionRawFile } from "../db/session-queries";
import { clearSessionCaptureCache, iterateSessionCaptureRecordsFromSource } from "./source-loader";
import { commitSessionDownsample, commitSessionDownsampleCap } from "../db/lap-reprocessing-queries";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { isSessionActive } from "../telemetry/live-pipeline";
import { hasPendingLayoutMigration } from "./layout-migration";
import { listSessionCaptureFiles, loadReferencedCapturePaths, withSessionCaptureMaintenanceLock } from "./cleanup";
import { downsampleSourceFiles, prepareDownsampleCaptureBundles, type DownsampleCaptureBundle } from "./downsample-bundles";
import { loadSettings } from "../runtime/config/settings";
import { isRecordingRetentionPolicyValid } from "@raceiq/shared/platform/runtime/recording-frequency";
import { Cause, Deferred, Effect, Fiber, Ref } from "effect";
import {
  RecordingMaintenanceBusyError,
  RecordingMaintenanceIOError,
  admitMaintenance,
  emptySessionDownsampleStatus,
  getRecordingMaintenanceController,
  releaseMaintenance,
  trackMaintenanceFiber,
  type RecordingMaintenanceController,
} from "./maintenance-runtime";
import { reserveRecordingStorageOperation } from "./storage-activity";

let downsampleStatus = emptySessionDownsampleStatus();
function snapshotDownsampleStatus(status: SessionDownsampleStatus): SessionDownsampleStatus {
  return {
    ...status,
    skipped: status.skipped.map((item) => ({ ...item, sessionIds: [...item.sessionIds] })),
    failed: status.failed.map((item) => ({ ...item, sessionIds: [...item.sessionIds] })),
  };
}

function publishDownsampleStatus(runtime: RecordingMaintenanceController, status: SessionDownsampleStatus): Effect.Effect<void> {
  return Effect.gen(function* () {
    downsampleStatus = snapshotDownsampleStatus(status);
    yield* Ref.set(runtime.status, snapshotDownsampleStatus(status));
  });
}

function storageReservationEffect(): Effect.Effect<() => void, RecordingMaintenanceBusyError> {
  return Effect.try({
    try: () => reserveRecordingStorageOperation("downsample"),
    catch: (cause) => {
      const error = cause as { code?: "IMPORT_ACTIVE" | "MOVE_ACTIVE"; message?: string };
      return new RecordingMaintenanceBusyError({
        code: error.code ?? "MOVE_ACTIVE",
        message: error.message ?? "Recording storage operation is active",
      });
    },
  });
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function admittedDownsampleEffect(
  runtime: RecordingMaintenanceController,
  request: SessionDownsampleRequest,
  acknowledgement?: Deferred.Deferred<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }, never>,
  releaseAdmission = true,
): Effect.Effect<SessionDownsampleStatus, RecordingMaintenanceBusyError | RecordingMaintenanceIOError> {
  let acknowledged = false;
  const acknowledge = (error?: unknown): Effect.Effect<void> => {
    if (acknowledged || !acknowledgement) return Effect.void;
    acknowledged = true;
    return Deferred.succeed(acknowledgement, error === undefined ? { ok: true } : { ok: false, error });
  };
  const start = Effect.gen(function* () {
    if (isSessionActive()) {
      return yield* Effect.fail(new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Cannot downsample recordings while a session is active" }));
    }
    const migrationPending = yield* Effect.tryPromise({
      try: () => hasPendingLayoutMigration(),
      catch: (cause) => new RecordingMaintenanceIOError({ operation: "admission", message: summarizeError(cause), cause }),
    });
    if (migrationPending) {
      return yield* Effect.fail(new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording layout migration is pending" }));
    }
    if (!isRecordingRetentionPolicyValid(loadSettings())) {
      return yield* Effect.fail(new RecordingMaintenanceIOError({ operation: "admission", message: "Invalid recording retention policy", cause: new Error("Invalid recording retention policy") }));
    }
    const reserved = yield* storageReservationEffect().pipe(Effect.tapError((error) => acknowledge(error)));
    yield* publishDownsampleStatus(runtime, {
      ...emptySessionDownsampleStatus(),
      status: "running",
      request,
    });
    return reserved;
  }).pipe(Effect.tapError((error) => acknowledge(error)));
  const work = Effect.gen(function* () {
    yield* acknowledge();
    const plan = yield* Effect.tryPromise({
      try: () => buildSessionDownsamplePlan(request),
      catch: (cause) => new RecordingMaintenanceIOError({ operation: "plan", message: summarizeError(cause), cause }),
    }).pipe(Effect.uninterruptible);
    const status: SessionDownsampleStatus = {
      status: "running",
      request,
      done: 0,
      total: plan.groups.length,
      convertedFiles: 0,
      freedBytes: 0,
      skipped: [...plan.preview.skipped],
      failed: [],
      error: null,
    };
    yield* publishDownsampleStatus(runtime, status);
    for (const group of plan.groups) {
      yield* Effect.suspend(() => {
        if (isSessionActive()) {
          return Effect.uninterruptible(
            Effect.sync(() => {
              status.failed.push({ sessionIds: group.rows.map((row) => row.id), message: "A recording session became active" });
              status.done++;
            }).pipe(Effect.andThen(publishDownsampleStatus(runtime, status))),
          );
        }
        return Effect.tryPromise({
          try: () => executeSessionDownsampleGroup(request, group),
          catch: (cause) => new RecordingMaintenanceIOError({ operation: "downsample", message: summarizeError(cause), cause }),
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              status.failed.push({ sessionIds: group.rows.map((row) => row.id), message: summarizeError(error) });
              status.done++;
              return publishDownsampleStatus(runtime, status);
            },
            onSuccess: (result) => {
              status.done++;
              if (result.kind === "converted") {
                status.convertedFiles++;
                status.freedBytes += result.freedBytes;
                if (result.warning) status.failed.push({ sessionIds: result.sessionIds, message: result.warning });
              } else if (result.kind === "skipped") {
                status.skipped.push(result.skip);
              }
              return publishDownsampleStatus(runtime, status);
            },
          }),
          Effect.uninterruptible,
        );
      });
    }
    status.status = status.failed.length === 0 ? "success" : status.convertedFiles > 0 ? "partial" : "error";
    status.error = status.status === "error" && status.failed.length > 0 ? status.failed[0]!.message : null;
    yield* publishDownsampleStatus(runtime, status);
    return status;
  });
  const effect = Effect.acquireUseRelease(
    start,
    () =>
      work.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = summarizeError(cause);
            const failedStatus: SessionDownsampleStatus = {
              ...downsampleStatus,
              status: "error",
              error: message,
              failed: [...downsampleStatus.failed, { sessionIds: [], message }],
            };
            yield* publishDownsampleStatus(runtime, failedStatus);
            yield* acknowledge(cause);
            if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
            return failedStatus;
          }).pipe(Effect.uninterruptible),
        ),
      ),
    (release) => Effect.sync(release),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const error = new RecordingMaintenanceIOError({ operation: "admission", message: summarizeError(cause), cause });
        if (downsampleStatus.status === "running") {
          const failedStatus = {
            ...downsampleStatus,
            status: "error" as const,
            error: error.message,
            failed: [...downsampleStatus.failed, { sessionIds: [], message: error.message }],
          };
          yield* publishDownsampleStatus(runtime, failedStatus);
        }
        yield* acknowledge(error);
        return yield* Effect.failCause(cause);
      }).pipe(Effect.uninterruptible),
    ),
  );
  return releaseAdmission ? effect.pipe(Effect.ensuring(releaseMaintenance(runtime))) : effect;
}

async function spawnDownsample(request: SessionDownsampleRequest, awaitCompletion: boolean): Promise<SessionDownsampleStatus | void> {
  const runtime = getRecordingMaintenanceController();
  const admitted = await runtime.managed.runPromise(admitMaintenance(runtime, "downsample"));
  if (!admitted) {
    throw new RecordingMaintenanceBusyError({
      code: "MOVE_ACTIVE",
      message: "Recording storage operation is active",
    });
  }
  const acknowledgement = runtime.managed.runSync(Deferred.make<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }, never>());
  const fiber = runtime.managed.runFork(admittedDownsampleEffect(runtime, request, acknowledgement));
  trackMaintenanceFiber(runtime, fiber);
  const admission = await runtime.managed.runPromise(Deferred.await(acknowledgement));
  if (!admission.ok) {
    await runtime.managed.runPromise(Effect.ignore(Fiber.await(fiber)));
    throw admission.error;
  }
  if (!awaitCompletion) return;
  return runtime.managed.runPromise(Fiber.join(fiber));
}

export async function startSessionDownsample(request: SessionDownsampleRequest): Promise<void> {
  await spawnDownsample(request, false);
}

export async function runSessionDownsampleNow(request: SessionDownsampleRequest): Promise<SessionDownsampleStatus> {
  return (await spawnDownsample(request, true)) as SessionDownsampleStatus;
}

export function getSessionDownsampleStatus(): SessionDownsampleStatus {
  return snapshotDownsampleStatus(downsampleStatus);
}
export function runScheduledSessionDownsampleEffect(request: SessionDownsampleRequest): Effect.Effect<SessionDownsampleStatus, RecordingMaintenanceBusyError | RecordingMaintenanceIOError> {
  const runtime = getRecordingMaintenanceController();
  return Effect.gen(function* () {
    const transitioned = yield* Ref.modify(runtime.state, (current) => (current === "maintenance" ? ([true, "downsample"] as const) : ([false, current] as const)));
    if (!transitioned) {
      return yield* Effect.fail(new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording storage operation is active" }));
    }
    return yield* admittedDownsampleEffect(runtime, request, undefined, false);
  }).pipe(Effect.ensuring(Ref.update(runtime.state, (current) => (current === "downsample" ? "maintenance" : current))));
}

export type SessionDownsampleRow = {
  id: number;
  gameId: GameId;
  source: string | null;
  rawFile: string | null;
  createdAt: string;
  isFavorite: boolean;
  downsampledFrequencyHz: number | null;
  carId: string;
  trackId: string;
};
export type SessionDownsampleGroup = {
  path: string;
  rows: SessionDownsampleRow[];
  source: { rawFile: string; source: string | null; gameId: GameId; carId: string; trackId: string };
  inspection: DownsampleRecordingInspection;
  size: number;
};
export type SessionDownsamplePlan = { preview: SessionDownsamplePreview; groups: SessionDownsampleGroup[] };

const DAY_MS = 86_400_000;
const MOTEC_SOURCE = "motec";
const RATE_COMPARISON_TOLERANCE_HZ = 3;

function skip(rows: SessionDownsampleRow[], reason: SessionDownsampleSkip["reason"]): SessionDownsampleSkip {
  return { sessionIds: rows.map((row) => row.id).sort((a, b) => a - b), reason };
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export async function buildSessionDownsamplePlan(request: SessionDownsampleRequest, options: { onlyPath?: string } = {}): Promise<SessionDownsamplePlan> {
  const rows = (await db
    .select({
      id: sessions.id,
      gameId: sessions.gameId,
      source: sessions.source,
      rawFile: sessions.rawFile,
      createdAt: sessions.createdAt,
      isFavorite: sessions.isFavorite,
      downsampledFrequencyHz: sessions.downsampledFrequencyHz,
      carId: sessions.carId,
      trackId: sessions.trackId,
    })
    .from(sessions)
    .all()) as SessionDownsampleRow[];
  const lapIndexes = await db
    .select({
      lapId: laps.id,
      sessionId: laps.sessionId,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
    })
    .from(laps)
    .all();
  const favoriteLaps = await db.select({ sessionId: laps.sessionId }).from(laps).where(eq(laps.isFavorite, true)).all();
  const favorites = new Set(rows.filter((row) => row.isFavorite).map((row) => row.id));
  for (const lap of favoriteLaps) favorites.add(lap.sessionId);
  const cutoff = request.mode === "older-than" ? Date.now() - request.olderThanDays * DAY_MS : null;
  const groupsByPath = new Map<string, SessionDownsampleRow[]>();
  const skipped: SessionDownsampleSkip[] = [];
  const candidates: SessionDownsampleGroup[] = [];

  const eligibleForAge = (row: SessionDownsampleRow) => cutoff === null || Date.parse(row.createdAt) < cutoff;
  for (const row of rows) {
    if (row.rawFile === null && eligibleForAge(row)) skipped.push(skip([row], "missing"));
    if (!row.rawFile) continue;
    const path = resolve(row.rawFile);
    const group = groupsByPath.get(path) ?? [];
    group.push(row);
    groupsByPath.set(path, group);
  }

  for (const [path, refs] of groupsByPath) {
    if (options.onlyPath !== undefined && path !== resolve(options.onlyPath)) continue;
    const qualifying = refs.filter(eligibleForAge);
    if (qualifying.length === 0) continue;
    if (refs.some((row) => favorites.has(row.id))) {
      skipped.push(skip(refs, "favorite"));
      continue;
    }
    if (cutoff !== null && qualifying.length !== refs.length) {
      skipped.push(skip(refs, "shared-age-conflict"));
      continue;
    }
    if (!refs.every((row) => isOwnedSessionRawFile(row.rawFile!))) {
      skipped.push(skip(refs, "unowned"));
      continue;
    }
    if (refs.some((row) => row.source === MOTEC_SOURCE)) {
      skipped.push(skip(refs, "unsupported-format"));
      continue;
    }
    // Manifest-backed captures are published as JSON, but stream as canonical
    // records through the source loader just like their legacy raw-file source.
    if (!(path.endsWith(".bin") || path.endsWith(".bin.gz") || path.endsWith("capture-manifest.json"))) {
      skipped.push(skip(refs, "unsupported-format"));
      continue;
    }
    if (refs.some((row) => row.gameId !== refs[0]!.gameId)) {
      skipped.push(skip(refs, "unsupported-format"));
      continue;
    }
    const size = await fileSize(path);
    if (size === null) {
      skipped.push(skip(refs, "missing"));
      continue;
    }
    if (refs.every((row) => row.downsampledFrequencyHz !== null && row.downsampledFrequencyHz <= request.targetHz)) {
      skipped.push(skip(refs, "already-at-or-below-target"));
      continue;
    }
    const row = refs[0]!;
    const source = { rawFile: path, source: row.source, gameId: row.gameId, carId: row.carId, trackId: row.trackId };
    const groupLapIndexes: DownsampleLapIndex[] = lapIndexes
      .filter((lap) => refs.some((ref) => ref.id === lap.sessionId))
      .map(({ lapId, rawByteOffset, rawFrameCount }) => ({ lapId, rawByteOffset, rawFrameCount }));
    try {
      const inspection = await inspectDownsampleRecording(createSessionDownsampleRecordingInput(source, groupLapIndexes));
      if (inspection.streams.some((stream) => stream.sampleRateHz === null)) {
        skipped.push(skip(refs, "unreliable-time"));
        continue;
      }
      if (inspection.streams.every((stream) => Math.round(stream.sampleRateHz!) <= request.targetHz + RATE_COMPARISON_TOLERANCE_HZ)) {
        skipped.push(skip(refs, "already-at-or-below-target"));
        continue;
      }
      const sourceFiles = await downsampleSourceFiles(path, refs.map((ref) => ref.id));
      candidates.push({ path, rows: refs, source, inspection, size: [...sourceFiles.values()].reduce((sum, bytes) => sum + bytes, 0) });
    } catch (error) {
      if (error instanceof DownsampleRecordingError) {
        skipped.push(skip(refs, error.reason));
        continue;
      }
      if (error instanceof Error && (error as NodeJS.ErrnoException).code) throw error;
      skipped.push(skip(refs, "unsupported-format"));
      continue;
    }
  }

  const candidateSessionIds = candidates.flatMap((group) => group.rows.map((row) => row.id)).sort((a, b) => a - b);
  return {
    preview: {
      request,
      candidateSessionIds,
      fileCount: candidates.length,
      sourceBytes: candidates.reduce((sum, group) => sum + group.size, 0),
      skipped,
    },
    groups: candidates,
  };
}

export async function previewSessionDownsample(request: SessionDownsampleRequest): Promise<SessionDownsamplePreview> {
  const plan = await buildSessionDownsamplePlan(request);
  return plan.preview;
}

export function createSessionDownsampleRecordingInput(source: SessionDownsampleGroup["source"], lapIndexes: readonly DownsampleLapIndex[]): DownsampleRecordingInput {
  const game = getServerGame(source.gameId);
  return {
    gameId: source.gameId,
    records: () => iterateSessionCaptureRecordsFromSource(source, { strict: true }),
    createTelemetryParser: () => {
      let state = game.createParserState?.() ?? null;
      return {
        parse: (frame) => game.tryParse(frame, state) !== null,
        reset: () => {
          state = game.createParserState?.() ?? null;
        },
      };
    },
    lapIndexes,
    appendsDelayedFinishFrame: game.appendsDelayedFinishFrame,
  };
}

export type SessionDownsampleGroupResult =
  | { kind: "converted"; sessionIds: number[]; freedBytes: number; warning: string | null }
  | { kind: "cap-only"; sessionIds: number[] }
  | { kind: "skipped"; skip: SessionDownsampleSkip };

async function assertDownsampleQuiescent(): Promise<void> {
  const migrationPending = await hasPendingLayoutMigration();
  if (isSessionActive()) throw new Error("Cannot downsample recordings while a session is active");
  if (migrationPending) throw new Error("Recording layout migration is pending");
  if (!isRecordingRetentionPolicyValid(loadSettings())) throw new Error("Invalid recording retention policy");
}

async function isGzipCapture(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const prefix = Buffer.allocUnsafe(2);
    const { bytesRead } = await file.read(prefix, 0, 2, 0);
    return bytesRead === 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
  } finally {
    await file.close();
  }
}

/** Caller owns a storage reservation; this function acquires the shared lock once. */
export async function executeSessionDownsampleGroup(request: SessionDownsampleRequest, planned: SessionDownsampleGroup): Promise<SessionDownsampleGroupResult> {
  return withSessionCaptureMaintenanceLock(async () => {
    await assertDownsampleQuiescent();
    const sessionIds = planned.rows.map((row) => row.id).sort((a, b) => a - b);
    const sourceState = await stat(planned.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (sourceState === null) return { kind: "skipped", skip: { sessionIds, reason: "missing" } };
    const currentPlan = await buildSessionDownsamplePlan(request, { onlyPath: planned.path });
    const group = currentPlan.groups.find((candidate) => candidate.path === planned.path);
    if (!group) {
      const reason = currentPlan.preview.skipped.find((item) => item.sessionIds.some((id) => sessionIds.includes(id)));
      return { kind: "skipped", skip: reason ?? { sessionIds, reason: "missing" } };
    }
    const currentIds = group.rows.map((row) => row.id).sort((a, b) => a - b);
    if (currentIds.length !== sessionIds.length || currentIds.some((id, index) => id !== sessionIds[index])) {
      throw new Error("Recording references changed before downsampling");
    }
    const plannedIndexes = new Map(planned.inspection.laps.map((lap) => [lap.lapId, lap]));
    if (
      group.inspection.laps.length !== plannedIndexes.size ||
      group.inspection.laps.some((lap) => {
        const expected = plannedIndexes.get(lap.lapId);
        return !expected || expected.expectedRawByteOffset !== lap.expectedRawByteOffset || expected.expectedRawFrameCount !== lap.expectedRawFrameCount;
      })
    )
      throw new Error("Recording lap indexes changed before downsampling");
    const oldIndexes = group.inspection.laps.map((lap) => ({
      lapId: lap.lapId,
      rawByteOffset: lap.expectedRawByteOffset,
      rawFrameCount: lap.expectedRawFrameCount,
    }));
    const gzip = group.path.endsWith("manifest.json") || await isGzipCapture(group.path);
    const newPath = join(dirname(group.path), `${group.source.gameId}.downsample-${randomUUID()}.bin${gzip ? ".gz" : ""}`);
    let outputCreated = false;
    let committed = false;
    let captureBundles: DownsampleCaptureBundle[] = [];
    const sourceFiles = await downsampleSourceFiles(group.path, sessionIds);
    try {
      const result = await rewriteDownsampleRecording(createSessionDownsampleRecordingInput(group.source, oldIndexes), group.inspection, { targetHz: request.targetHz, outputPath: newPath, gzip });
      outputCreated = true;
      await validateDownsampleRecording(
        createSessionDownsampleRecordingInput(
          { ...group.source, rawFile: newPath },
          result.lapIndexes.map((lap) => ({ lapId: lap.lapId, rawByteOffset: lap.rawByteOffset, rawFrameCount: lap.rawFrameCount })),
        ),
        result,
      );
      await assertDownsampleQuiescent();
      const sourceNow = await stat(group.path);
      if (sourceNow.size !== sourceState.size || sourceNow.mtimeMs !== sourceState.mtimeMs || sourceNow.ino !== sourceState.ino) {
        throw new Error("Recording source changed during downsampling");
      }
      if (result.frameCount === result.sourceFrameCount) {
        await unlink(newPath);
        outputCreated = false;
        await assertDownsampleQuiescent();
        await commitSessionDownsampleCap({
          oldRawFile: group.path,
          sessionIds,
          targetHz: request.targetHz,
          lapIndexes: group.inspection.laps,
        });
        return { kind: "cap-only", sessionIds };
      }
      const outputState = await stat(newPath);
      if (outputState.size >= group.size) {
        await unlink(newPath);
        outputCreated = false;
        return { kind: "skipped", skip: { sessionIds, reason: "not-smaller" } };
      }
      captureBundles = await prepareDownsampleCaptureBundles(
        { ...group.source, rawFile: newPath }, sessionIds, result.lapIndexes,
      );
      let outputBytes = outputState.size;
      for (const bundle of captureBundles) {
        outputBytes += (await stat(bundle.manifestPath)).size;
        for (const chunk of bundle.manifest.chunks) outputBytes += chunk.byteLength;
      }
      if (outputBytes >= group.size) {
        for (const bundle of captureBundles) await rm(dirname(bundle.manifestPath), { recursive: true, force: true });
        await unlink(newPath);
        outputCreated = false;
        return { kind: "skipped", skip: { sessionIds, reason: "not-smaller" } };
      }
      await assertDownsampleQuiescent();
      const sourceBeforeCommit = await stat(group.path);
      if (sourceBeforeCommit.size !== sourceState.size || sourceBeforeCommit.mtimeMs !== sourceState.mtimeMs || sourceBeforeCommit.ino !== sourceState.ino) {
        throw new Error("Recording source changed before publication");
      }
      await commitSessionDownsample({
        oldRawFile: group.path,
        newRawFile: newPath,
        captureBundles,
        sessionIds,
        targetHz: request.targetHz,
        lapIndexes: result.lapIndexes,
      });
      committed = true;
      const affectedLaps = await db.select({ id: laps.id }).from(laps).where(inArray(laps.sessionId, sessionIds)).all();
      for (const lap of affectedLaps) cacheDelete(lap.id);
      for (const path of new Set([group.path, newPath, ...group.rows.flatMap((row) => (row.rawFile ? [row.rawFile] : []))])) {
        clearSessionCaptureCache(path);
      }
      const referenced = await loadReferencedCapturePaths();
      let freedBytes = 0;
      const warnings: string[] = [];
      for (const [path, bytes] of sourceFiles) {
        if (!isOwnedSessionRawFile(path) || referenced.has(resolve(path)) || referenced.has(dirname(resolve(path)))) continue;
        try {
          await unlink(path);
          freedBytes += bytes;
        } catch (error) {
          warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {
        kind: "converted", sessionIds, freedBytes: Math.max(0, freedBytes - outputBytes),
        warning: warnings.length ? `Replacement committed; original files could not be removed: ${warnings.join("; ")}` : null,
      };
    } catch (error) {
      if (committed) {
        return { kind: "converted", sessionIds, freedBytes: 0, warning: `Replacement committed; finalization failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (outputCreated) {
        // A transport error can be ambiguous after commit. Never delete a referenced replacement.
        const refs = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(isNotNull(sessions.rawFile)).all();
        if (!refs.some((row) => row.rawFile !== null && resolve(row.rawFile) === newPath)) {
          await unlink(newPath).catch((cleanupError: unknown) => {
            console.error("[Downsample] Failed to remove uncommitted output", newPath, cleanupError);
          });
        }
        const manifestRefs = await db.select({ path: sessions.captureManifestFile }).from(sessions).all();
        for (const bundle of captureBundles) {
          if (!manifestRefs.some((row) => row.path !== null && resolve(row.path) === resolve(bundle.manifestPath))) {
            await rm(dirname(bundle.manifestPath), { recursive: true, force: true });
          }
        }
      }
      throw error;
    }
  });
}

/** Clean only this operation's interrupted temporary siblings, never final captures. */
export async function cleanupInterruptedSessionDownsampleFiles(): Promise<number> {
  return withSessionCaptureMaintenanceLock(async () => {
    await assertDownsampleQuiescent();
    const dirs = new Set((await listSessionCaptureFiles()).map(dirname));
    const refs = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(isNotNull(sessions.rawFile)).all();
    for (const row of refs) if (row.rawFile !== null && isOwnedSessionRawFile(row.rawFile)) dirs.add(dirname(resolve(row.rawFile)));
    const tempName = /\.downsample-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin(?:\.gz)?(?:\.raw)?\.tmp$/i;
    let removed = 0;
    for (const dir of dirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (!entry.isFile() || !tempName.test(entry.name) || !isOwnedSessionRawFile(path)) continue;
        await unlink(path);
        removed++;
      }
    }
    return removed;
  });
}
