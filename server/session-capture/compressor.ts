/**
 * Background session compressor.
 *
 * Runs every 5 minutes. While no session is actively recording, finds session
 * .bin files older than 24 hours and gzips them in-place, updating the DB path
 * to .bin.gz. Skips if a session is active to avoid competing with live writes.
 */
import { createReadStream, createWriteStream, unlinkSync, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Cause, Effect, Fiber, Schedule } from "effect";
import { getUncompressedSessions } from "../db/session-queries";
import { isSessionActive } from "../telemetry/live-pipeline";
import { db } from "../db/index";
import { dashboardSummaryState, sessions } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { cleanupOrphanSessionFiles, listSessionCaptureFiles, withSessionCaptureMaintenanceLock } from "./cleanup";
import { cleanupExpiredStagedMotec } from "../motec/import-staging";
import { loadSettings } from "../runtime/config/settings";
import { executeSessionCleanup, SessionCleanupBusyError } from "./session-cleanup";
import { releaseDashboardCaptureCheckpoint, republishPersistedDashboardCaptureFacts } from "./dashboard-processor";
import { hasPendingLayoutMigration } from "./layout-migration";
import {
  getRecordingMaintenanceController,
  admitMaintenance,
  releaseMaintenance,
  trackMaintenanceFiber,
  disposeRecordingMaintenanceRuntime,
  RecordingMaintenanceBusyError,
  RecordingMaintenanceIOError,
  RecordingMaintenanceValidationError,
} from "./maintenance-runtime";
import { cleanupInterruptedSessionDownsampleFiles, runScheduledSessionDownsampleEffect } from "./session-downsample";
import { isRecordingRetentionPolicyValid } from "@raceiq/shared/platform/runtime/recording-frequency";
import { RecordingStorageBusyError, reserveRecordingStorageOperation } from "./storage-activity";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
type MaintenanceError = RecordingMaintenanceBusyError | RecordingMaintenanceIOError | RecordingMaintenanceValidationError;

function maintenanceIOError(operation: string, cause: unknown): RecordingMaintenanceIOError {
  return new RecordingMaintenanceIOError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

interface CompressedFile {
  gzPath: string;
  sizeSummary: string;
}

async function writeCompressedFile(binPath: string): Promise<CompressedFile> {
  const gzPath = `${binPath}.gz`;
  if (existsSync(gzPath)) {
    throw new Error(`Compressed target already exists: ${gzPath}`);
  }
  const tempPath = `${gzPath}.${crypto.randomUUID()}.tmp`;
  const source = createReadStream(binPath);
  const destination = createWriteStream(tempPath, { flags: "wx" });
  try {
    await pipeline(source, createGzip(), destination);
    await rename(tempPath, gzPath);
    return {
      gzPath,
      sizeSummary: `${(source.bytesRead / 1024).toFixed(0)}KB → ${(destination.bytesWritten / 1024).toFixed(0)}KB`,
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch((cleanupError) => {
      console.error(`[Compressor] Failed to remove temporary file ${tempPath}:`, cleanupError);
    });
    throw error;
  }
}

async function compressSessionGroup(ids: number[], binPath: string): Promise<void> {
  const compressedFile = await writeCompressedFile(binPath);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ rawFile: compressedFile.gzPath })
        .where(eq(sessions.rawFile, binPath))
        .run();
      await tx.update(dashboardSummaryState).set({ captureReady: 0 }).where(inArray(dashboardSummaryState.sessionId, ids)).run();
    });
  } catch (error) {
    await rm(compressedFile.gzPath, { force: true }).catch((cleanupError) => {
      console.error(`[Compressor] Failed to remove uncommitted target ${compressedFile.gzPath}:`, cleanupError);
    });
    throw error;
  }
  const preserved = await republishPersistedDashboardCaptureFacts(ids);
  if (!preserved) {
    for (const sessionId of ids) await releaseDashboardCaptureCheckpoint(sessionId);
  }

  unlinkSync(binPath);
  console.log(`[Compressor] ${ids.length} session(s): ${binPath} → ${compressedFile.gzPath} (${compressedFile.sizeSummary})`);
}

/**
 * Compress a .bin file on disk that has no matching DB session row (orphan).
 * Writes .bin.gz, removes .bin. No DB update since there's nothing to point.
 */
async function compressOrphanFile(binPath: string): Promise<void> {
  const compressedFile = await writeCompressedFile(binPath);
  unlinkSync(binPath);
  console.log(`[Compressor] (orphan) ${binPath} → ${compressedFile.gzPath} (${compressedFile.sizeSummary})`);
}

async function runManualCompression(userTriggered: boolean): Promise<void> {
  const runtime = getRecordingMaintenanceController();
  if (!await runtime.managed.runPromise(admitMaintenance(runtime, "maintenance"))) {
    throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording storage operation is active" });
  }
  let releaseStorage: () => void;
  try {
    releaseStorage = reserveRecordingStorageOperation("downsample");
  } catch (error) {
    await runtime.managed.runPromise(releaseMaintenance(runtime));
    if (error instanceof RecordingStorageBusyError) {
      throw new RecordingMaintenanceBusyError({ code: error.code, message: error.message });
    }
    throw error;
  }
  const operation = Effect.tryPromise({
    try: () => runCompression(userTriggered),
    catch: (cause) => maintenanceIOError("compression", cause),
  }).pipe(
    Effect.uninterruptible,
    Effect.ensuring(Effect.sync(releaseStorage)),
    Effect.ensuring(releaseMaintenance(runtime)),
  );
  const fiber = trackMaintenanceFiber(runtime, runtime.managed.runFork(operation));
  await runtime.managed.runPromise(Fiber.join(fiber));
}

/** Background-style compression: respects the 24-hour age filter. */
export async function runCompressionNow(): Promise<void> {
  await runManualCompression(false);
}

/** User-triggered compression: ignores the age filter, compresses all uncompressed sessions. */
export async function runUserCompressionNow(): Promise<void> {
  await runManualCompression(true);
}

async function runCompression(userTriggered = false): Promise<void> {
  await withSessionCaptureMaintenanceLock(async () => {
    // Recording may have started while this pass waited for maintenance.
    if (isSessionActive()) return;
    if (await hasPendingLayoutMigration()) return;

    const ageMs = userTriggered ? 0 : ONE_DAY_MS;
    const candidates = await getUncompressedSessions(ageMs);
    const groupedCandidates = new Map<string, number[]>();
    for (const { id, rawFile } of candidates) {
      const ids = groupedCandidates.get(rawFile) ?? [];
      ids.push(id);
      groupedCandidates.set(rawFile, ids);
    }
    const dbPaths = new Set(groupedCandidates.keys());

    // User-triggered: also sweep .bin files that live on disk without a DB row.
    // Background (age-gated) runs stay DB-driven so we don't compress brand-new
    // files still being written by a just-finished session.
    const orphanPaths = userTriggered
      ? (await listSessionCaptureFiles()).filter((path) => path.endsWith(".bin") && !dbPaths.has(path))
      : [];

    const total = groupedCandidates.size + orphanPaths.length;
    if (total === 0) {
      console.debug("[Compressor] No sessions to compress");
      return;
    }

    console.log(`[Compressor] Compressing ${candidates.length} session(s) across ${groupedCandidates.size} capture(s), ${orphanPaths.length} orphan file(s)…`);
    for (const [rawFile, ids] of groupedCandidates) {
      if (isSessionActive()) break;
      try {
        const file = Bun.file(rawFile);
        if (!(await file.exists())) continue;
        await compressSessionGroup(ids, rawFile);
      } catch (err) {
        console.error(`[Compressor] Failed to compress capture ${rawFile}:`, err);
      }
    }
    for (const path of orphanPaths) {
      if (isSessionActive()) break;
      try {
        if (!existsSync(path)) continue;
        await compressOrphanFile(path);
      } catch (err) {
        console.error(`[Compressor] Failed to compress orphan ${path}:`, err);
      }
    }
  });
}

let maintenanceFiber: Fiber.Fiber<unknown, unknown> | null = null;

function maintenancePassEffect(): Effect.Effect<void, MaintenanceError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => runCompression(),
      catch: (cause) => maintenanceIOError("compression", cause),
    }).pipe(Effect.uninterruptible);
    const settings = yield* Effect.sync(() => loadSettings());
    if (!isRecordingRetentionPolicyValid(settings)) {
      return yield* Effect.fail(new RecordingMaintenanceValidationError({
        operation: "retention",
        message: "Automatic deletion must be scheduled after automatic downsampling.",
      }));
    }
    if (settings.sessionDownsampleEnabled && !isSessionActive()) {
      const status = yield* runScheduledSessionDownsampleEffect({
        mode: "older-than",
        olderThanDays: settings.sessionDownsampleAgeDays,
        targetHz: settings.sessionDownsampleFrequencyHz,
      });
      if (status.status === "partial" || status.status === "error") {
        return yield* Effect.fail(maintenanceIOError(
          "downsample",
          new Error(status.error ?? "Automatic recording downsampling failed"),
        ));
      }
    }
    if (settings.sessionCleanupEnabled && !isSessionActive()) {
      const cleanup = yield* Effect.tryPromise({
        try: () => executeSessionCleanup({ mode: "older-than", olderThanDays: settings.sessionCleanupAgeDays }),
        catch: (cause) => cause instanceof SessionCleanupBusyError
          ? new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: cause.message })
          : maintenanceIOError("cleanup", cause),
      }).pipe(Effect.uninterruptible);
      if (cleanup.failed.length > 0) {
        return yield* Effect.fail(maintenanceIOError(
          "cleanup",
          new Error(`Failed to remove ${cleanup.failed.length} recording group(s)`),
        ));
      }
    }
    const orphanCount = yield* Effect.tryPromise({
      try: () => cleanupOrphanSessionFiles(isSessionActive),
      catch: (cause) => maintenanceIOError("orphan-cleanup", cause),
    }).pipe(Effect.uninterruptible);
    const stagedMotecCount = yield* Effect.tryPromise({
      try: () => cleanupExpiredStagedMotec(),
      catch: (cause) => maintenanceIOError("staged-import-cleanup", cause),
    }).pipe(Effect.uninterruptible);
    const downsampleTempCount = yield* Effect.tryPromise({
      try: () => cleanupInterruptedSessionDownsampleFiles(),
      catch: (cause) => maintenanceIOError("downsample-temp-cleanup", cause),
    }).pipe(Effect.uninterruptible);
    console.debug(orphanCount > 0 ? `[Cleanup] Removed ${orphanCount} orphan session file(s)` : "[Cleanup] No orphan session files found");
    if (stagedMotecCount > 0) console.debug(`[Cleanup] Removed ${stagedMotecCount} expired MoTeC staging director${stagedMotecCount === 1 ? "y" : "ies"}`);
    if (downsampleTempCount > 0) console.debug(`[Downsample] Removed ${downsampleTempCount} interrupted temporary file(s)`);
  });
}

function runAdmittedMaintenanceEffect(): Effect.Effect<void, MaintenanceError> {
  const runtime = getRecordingMaintenanceController();
  return Effect.gen(function* () {
    const admitted = yield* admitMaintenance(runtime, "maintenance");
    if (!admitted) return;
    yield* maintenancePassEffect().pipe(Effect.ensuring(releaseMaintenance(runtime)));
  });
}

export async function runSessionCaptureMaintenanceNow(): Promise<void> {
  const runtime = getRecordingMaintenanceController();
  const admitted = await runtime.managed.runPromise(admitMaintenance(runtime, "maintenance"));
  if (!admitted) throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording storage operation is active" });
  const fiber = runtime.managed.runFork(maintenancePassEffect().pipe(Effect.ensuring(releaseMaintenance(runtime))));
  trackMaintenanceFiber(runtime, fiber);
  await runtime.managed.runPromise(Fiber.join(fiber));
}

export function sessionMaintenanceSchedule<E>(pass: Effect.Effect<void, E>): Effect.Effect<void, E> {
  const caughtPass = pass.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.sync(() => console.error("[Maintenance] Recording maintenance pass failed:", cause)),
    ),
  );
  return Effect.repeat(caughtPass, Schedule.spaced("5 minutes"));
}

export function startSessionCompressor(): void {
  if (maintenanceFiber) return;
  const runtime = getRecordingMaintenanceController();
  maintenanceFiber = trackMaintenanceFiber(runtime, runtime.managed.runFork(sessionMaintenanceSchedule(runAdmittedMaintenanceEffect())));
}

export async function stopSessionCompressor(): Promise<void> {
  maintenanceFiber = null;
  await disposeRecordingMaintenanceRuntime();
}
