import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { open, readdir, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import { db } from "../db/index";
import { laps, sessions, sessionCaptureSplitJobs, liveCaptures } from "../db/schema";
import { commitSessionCaptureRewrite } from "../db/lap-reprocessing-queries";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { isOwnedSessionRawFile } from "../db/session-queries";
import { clearSessionCaptureCache, type SessionCaptureSource } from "./source-loader";
import { loadReferencedCapturePaths, withSessionCaptureMaintenanceLock } from "./cleanup";
import { downsampleSourceFiles, prepareDownsampleCaptureBundles, type DownsampleCaptureBundle } from "./downsample-bundles";
import { hasPendingLayoutMigration } from "./layout-migration";
import { isSessionActive } from "../telemetry/live-pipeline";
import { reserveRecordingStorageOperation, RecordingStorageBusyError } from "./storage-activity";
import { admitMaintenance, getRecordingMaintenanceController, releaseMaintenance, trackMaintenanceFiber, RecordingMaintenanceBusyError, RecordingMaintenanceIOError } from "./maintenance-runtime";
import { rewriteF1MotionCapture } from "./f1-motion-rewrite";

export interface F1MotionReconcileResult {
  convertedFiles: number;
  freedBytes: number;
  skipped: Array<{ sessionIds: number[]; reason: string }>;
  failed: Array<{ sessionIds: number[]; error: string }>;
  warnings: string[];
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function assertInactive(): void {
  if (isSessionActive()) throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Cannot compact recordings while a session is active" });
}

/** Promise boundary for immediate reconciliation; automatic maintenance uses the admitted effect. */
export async function reconcileF1MotionRecordings(): Promise<F1MotionReconcileResult> {
  const runtime = getRecordingMaintenanceController();
  if (!(await runtime.managed.runPromise(admitMaintenance(runtime, "maintenance")))) {
    throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording storage operation is active" });
  }
  const operation = runScheduledF1MotionReconcileEffect().pipe(Effect.ensuring(releaseMaintenance(runtime)));
  const fiber = trackMaintenanceFiber(runtime, runtime.managed.runFork(operation));
  return runtime.managed.runPromise(Fiber.join(fiber));
}

/** Caller already owns maintenance admission. Storage remains reserved until I/O settles. */
export function runScheduledF1MotionReconcileEffect(): Effect.Effect<F1MotionReconcileResult, RecordingMaintenanceBusyError | RecordingMaintenanceIOError> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        assertInactive();
        return reserveRecordingStorageOperation("f1-motion-compaction");
      },
      catch: (error) =>
        error instanceof RecordingMaintenanceBusyError
          ? error
          : error instanceof RecordingStorageBusyError
            ? new RecordingMaintenanceBusyError({ code: error.code, message: error.message })
            : new RecordingMaintenanceIOError({ operation: "f1-motion-compaction-admission", message: message(error), cause: error }),
    }),
    () => runReconciliation(),
    (release) => Effect.sync(release),
  );
}

const runReconciliation = Effect.fn("reconcileF1MotionRecordings")(function* () {
  const result: F1MotionReconcileResult = { convertedFiles: 0, freedBytes: 0, skipped: [], failed: [], warnings: [] };
  const rows = yield* Effect.tryPromise({
    try: () => db.select().from(sessions).all(),
    catch: (cause) => new RecordingMaintenanceIOError({ operation: "f1-motion-compaction-plan", message: message(cause), cause }),
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.rawFile === null) {
      if (row.gameId === "f1-2025") result.skipped.push({ sessionIds: [row.id], reason: "missing-capture" });
      continue;
    }
    const path = resolve(row.rawFile!);
    const group = groups.get(path) ?? [];
    group.push(row);
    groups.set(path, group);
  }
  for (const [path, planned] of groups) {
    if (!planned.some((row) => row.gameId === "f1-2025")) continue;
    if (planned.every((row) => row.gameId === "f1-2025" && row.f1MotionCompactedSource === path)) {
      result.skipped.push({ sessionIds: planned.map((row) => row.id), reason: "already-compact" });
      continue;
    }
    const sessionIds = planned.map((row) => row.id);
    // Finish this group's I/O/publication before interruption can release storage.
    // The next yield remains interruptible, so shutdown never admits another group.
    yield* Effect.promise(async () => {
      try {
        await withSessionCaptureMaintenanceLock(async () => {
          assertInactive();
          if (await hasPendingLayoutMigration()) throw new Error("Recording layout migration is pending");
          const current = await db.select().from(sessions).where(isNotNull(sessions.rawFile)).all();
          const refs = current.filter((row) => resolve(row.rawFile!) === path);
          if (refs.length !== planned.length || refs.some((row) => !sessionIds.includes(row.id))) throw new Error("Recording references changed");
          if (refs.some((row) => row.gameId !== "f1-2025") || !isOwnedSessionRawFile(path) || !(path.endsWith(".bin") || path.endsWith(".bin.gz") || path.endsWith("manifest.json"))) {
            result.skipped.push({ sessionIds, reason: "unsupported-or-unowned" });
            return;
          }
          if (refs.some((row) => row.lapDetectorVersion === null)) {
            result.skipped.push({ sessionIds, reason: "pending-lap-reconciliation" });
            return;
          }
          for (const entry of await readdir(dirname(path), { withFileTypes: true })) {
            if (entry.isFile() && /^f1-2025\.motion-compact-[0-9a-f-]{36}\.bin(?:\.gz)?(?:\.raw)?\.tmp$/.test(entry.name)) {
              const temporary = join(dirname(path), entry.name);
              if (isOwnedSessionRawFile(temporary)) await unlink(temporary);
            }
          }
          const jobs = await db.select().from(sessionCaptureSplitJobs).where(inArray(sessionCaptureSplitJobs.sessionId, sessionIds)).all();
          const live = await db.select().from(liveCaptures).all();
          if (
            jobs.some((job) => !["ready", "queued", "failed"].includes(job.status)) ||
            live.some((capture) => (sessionIds.includes(capture.sessionId) || resolve(capture.sourcePath) === path || resolve(capture.archivePath) === path) && capture.status !== "sealed")
          ) {
            result.skipped.push({ sessionIds, reason: "active-capture-or-split" });
            return;
          }
          const sourceFiles = await downsampleSourceFiles(path, sessionIds);
          const states = new Map<string, Stats>();
          for (const file of sourceFiles.keys()) states.set(file, await stat(file));
          const originalBytes = [...sourceFiles.values()].reduce((sum, bytes) => sum + bytes, 0);
          const row = refs[0]!;
          const source: SessionCaptureSource = { rawFile: path, gameId: "f1-2025", source: row.source, carId: row.carId, trackId: row.trackId, captureFormatVersion: row.captureFormatVersion };
          const lapRows = await db.select().from(laps).where(inArray(laps.sessionId, sessionIds)).all();
          let gzip = path.endsWith("manifest.json");
          if (!gzip) {
            const handle = await open(path, "r");
            try {
              const prefix = Buffer.alloc(2);
              const read = await handle.read(prefix, 0, 2, 0);
              gzip = read.bytesRead === 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
            } finally {
              await handle.close();
            }
          }
          const outputPath = join(dirname(path), `f1-2025.motion-compact-${randomUUID()}.bin${gzip ? ".gz" : ""}`);
          let bundles: DownsampleCaptureBundle[] = [];
          let committed = false;
          try {
            const rewritten = await rewriteF1MotionCapture(
              source,
              lapRows.map((lap) => ({ lapId: lap.id, rawByteOffset: lap.rawByteOffset, rawFrameCount: lap.rawFrameCount })),
              outputPath,
              gzip,
            );
            if (!rewritten.changed) {
              assertInactive();
              for (const [file, previous] of states) {
                const now = await stat(file);
                if (now.ino !== previous.ino || now.size !== previous.size || now.mtimeMs !== previous.mtimeMs) throw new Error("Recording source changed during compaction");
              }
              await db.transaction(async (tx) => {
                for (const ref of refs) {
                  const marked = await tx
                    .update(sessions)
                    .set({ f1MotionCompactedSource: path })
                    .where(and(eq(sessions.id, ref.id), eq(sessions.rawFile, ref.rawFile!), eq(sessions.gameId, "f1-2025"), isNotNull(sessions.lapDetectorVersion)))
                    .returning({ id: sessions.id });
                  if (marked.length !== 1) throw new Error("Recording references changed before marking compaction complete");
                }
              });
              result.skipped.push({ sessionIds, reason: "already-compact" });
              return;
            }
            bundles = await prepareDownsampleCaptureBundles({ ...source, rawFile: outputPath, captureFormatVersion: 1 }, sessionIds, rewritten.lapIndexes);
            assertInactive();
            for (const [file, previous] of states) {
              const now = await stat(file);
              if (now.ino !== previous.ino || now.size !== previous.size || now.mtimeMs !== previous.mtimeMs) throw new Error("Recording source changed during compaction");
            }
            await commitSessionCaptureRewrite({ oldRawFile: path, newRawFile: outputPath, sessionIds, targetHz: null, lapIndexes: rewritten.lapIndexes, captureBundles: bundles });
            committed = true;
            result.convertedFiles++;
            for (const lap of lapRows) cacheDelete(lap.id);
            for (const file of [path, outputPath, ...sourceFiles.keys()]) clearSessionCaptureCache(file);
            const referenced = await loadReferencedCapturePaths();
            let removed = 0;
            for (const [file, bytes] of sourceFiles) {
              if (!isOwnedSessionRawFile(file) || referenced.has(resolve(file)) || referenced.has(dirname(resolve(file)))) {
                result.warnings.push(`Original remains referenced or unowned: ${file}`);
                continue;
              }
              try {
                await unlink(file);
                removed += bytes;
              } catch (error) {
                result.warnings.push(`Original removal failed: ${file}: ${message(error)}`);
              }
            }
            const outputFiles = await downsampleSourceFiles(outputPath, sessionIds);
            const outputBytes = [...outputFiles.values()].reduce((sum, bytes) => sum + bytes, 0);
            result.freedBytes += Math.max(0, removed - outputBytes);
            if (outputBytes >= originalBytes) result.warnings.push(`Session ${row.id}: channels removed, but stored output is not smaller`);
          } catch (error) {
            // A transport failure may occur after commit; never remove authoritative output.
            const published = await db.select({ rawFile: sessions.rawFile, manifest: sessions.captureManifestFile }).from(sessions).all();
            const authoritative = committed || published.some((ref) => ref.rawFile !== null && resolve(ref.rawFile) === outputPath);
            if (authoritative) {
              result.warnings.push(`Replacement committed; finalization failed: ${message(error)}`);
              if (!committed) result.convertedFiles++;
            } else {
              await rm(outputPath, { force: true });
              for (const bundle of bundles) {
                if (!published.some((ref) => ref.manifest === bundle.manifestPath)) await rm(dirname(bundle.manifestPath), { recursive: true, force: true });
              }
              throw error;
            }
          }
        });
      } catch (error) {
        result.failed.push({ sessionIds, error: message(error) });
      }
    }).pipe(Effect.uninterruptible);
  }
  return result;
});
