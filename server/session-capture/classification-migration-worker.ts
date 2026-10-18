import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { and, eq, inArray, lte } from "drizzle-orm";
import type { GameId } from "@raceiq/shared/games/ids";
import { PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { client, db } from "../db/index";
import { classificationMigrationMeta, classificationMigrationRecordings, laps, sessions } from "../db/schema";
import { CapturingDbAdapter } from "../telemetry/pipeline-ports";
import { getServerGame } from "../games/registry";
import { iterateSessionCaptureRecordsFromSource } from "./source-loader";
import { applyFrameTime } from "./frame-time";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { isSessionActive } from "../telemetry/live-pipeline";
import { isDelayedFinishContext } from "../db/telemetry-replay-storage";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { wsManager } from "../runtime/websocket-manager";
import {
  classificationMigrationBarrier,
  CLASSIFICATION_MIGRATION_VERSION,
  getClassificationMigrationStatus,
  reconcileClassificationMigrationInventory,
  invalidateStaleCompletedClassificationSources,
  classificationSourceSignature,
} from "./classification-migration";
const LEGACY_CATEGORY_BY_REASON: Record<string, string> = {
  inlap: "in_lap",
  outlap: "out_lap",
  "pit lap": "pit_lap",
};

/** Process one capture then yield before claiming another. */
export async function processNextClassificationRecording(): Promise<boolean> {
  if (isSessionActive()) return false;
  const candidate = await db.select().from(classificationMigrationRecordings)
    .where(and(
      eq(classificationMigrationRecordings.version, CLASSIFICATION_MIGRATION_VERSION),
      eq(classificationMigrationRecordings.state, "pending"),
    )).orderBy(classificationMigrationRecordings.recordingId).limit(1).get();
  if (!candidate) return false;
  const claim = await client.transaction("write");
  try {
    const claimed = await claim.execute({
      sql: "UPDATE classification_migration_recordings SET state='running',attempt=attempt+1,reason=NULL WHERE recording_id=? AND state='pending'",
      args: [candidate.recordingId],
    });
    if (Number(claimed.rowsAffected) !== 1) {
      await claim.rollback();
      return true;
    }
    await claim.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await claim.commit();
  } catch (error) {
    await claim.rollback();
    throw error;
  }
  try {
    await processClaimedRecording(candidate.recordingId, candidate.sourceKey, candidate.sourceRevision);
  } catch (error) {
    await finish(candidate.recordingId, "failed", "processing_error");
    throw error;
  }
  return true;
}

async function processClaimedRecording(recordingId: string, sourceKey: string, sourceRevision: number): Promise<void> {
  const sourcePath = sourceKey.startsWith("file:") ? sourceKey.slice(5) : null;
  if (!sourcePath) return finish(recordingId, "limited", "missing_source");
  let sourceStat: Stats;
  try { sourceStat = await stat(sourcePath); } catch { return finish(recordingId, "limited", "missing_source"); }
  const migrationMeta = await db.select({ cutoffSessionId: classificationMigrationMeta.cutoffSessionId })
    .from(classificationMigrationMeta).where(eq(classificationMigrationMeta.id, 1)).get();
  const existing = await db.select({
    id: sessions.id,
    gameId: sessions.gameId,
    carId: sessions.carId,
    trackId: sessions.trackId,
    source: sessions.source,
  }).from(sessions).where(and(
    eq(sessions.rawFile, sourcePath),
    lte(sessions.id, migrationMeta?.cutoffSessionId ?? 0),
  )).orderBy(sessions.id).all();
  if (!existing.length) return finish(recordingId, "failed", "source_changed");
  if (new Set(existing.map((session) => session.gameId)).size !== 1) return finish(recordingId, "failed", "ambiguous_match");
  const gameId = existing[0]!.gameId as GameId;
  let game;
  try { game = getServerGame(gameId); } catch { return finish(recordingId, "limited", "insufficient_evidence"); }
  const capture = new CapturingDbAdapter();
  let detector = game.createLapDetector({ db: capture, bypassPacketRateFilter: true });
  let parserState: unknown = game.createParserState?.() ?? null;
  let segmentHasFrames = false;
  let inContext = false;
  let lastOwnedPacket: TelemetryPacket | null = null;
  let frameIndex = 0;
  try {
    for await (const record of iterateSessionCaptureRecordsFromSource({
      rawFile: sourcePath,
      source: existing[0]!.source,
      gameId,
      carId: existing[0]!.carId,
      trackId: existing[0]!.trackId,
    }, { strict: true, allowLegacyFullFrames: true })) {
      if (record.kind === "segment-boundary") {
        detector = game.createLapDetector({ db: capture, bypassPacketRateFilter: true });
        detector.expectCompleteLapStart?.();
        parserState = game.createParserState?.() ?? null;
        segmentHasFrames = false;
        inContext = false;
        lastOwnedPacket = null;
        continue;
      }
      if (record.kind === "segment-context") {
        if (!segmentHasFrames) detector.expectCompleteLapStart?.();
        inContext = true;
        continue;
      }
      if (record.kind === "segment-context-end") {
        inContext = false;
        continue;
      }
      if (record.kind === "parser-bootstrap") {
        if (record.gameId !== gameId || record.formatVersion !== PARSER_BOOTSTRAP_VERSION) {
          throw new Error("Parser bootstrap does not match migration game");
        }
        if (!game.restoreParserCheckpoint) throw new Error(`Parser checkpoint restore unavailable for ${gameId}`);
        parserState = game.restoreParserCheckpoint(parserState, record.payload);
        inContext = false;
        continue;
      }
      if (record.kind !== "frame") continue;
      const packet = game.tryParse(record.frame, parserState);
      if (packet) {
        applyFrameTime(packet, record.frameTimeMs);
        if (inContext) {
          if (lastOwnedPacket && (packet.LapNumber > lastOwnedPacket.LapNumber ||
            isDelayedFinishContext(lastOwnedPacket, packet))) {
            await detector.feed(packet);
          }
        } else {
          segmentHasFrames = true;
          lastOwnedPacket = packet;
          await detector.feed(packet, record.offset);
        }
      }
      frameIndex++;
      if (frameIndex % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await classificationMigrationBarrier("duringDecodeBatch");
        if (isSessionActive()) {
          await deferRecording(recordingId, "active_capture");
          return;
        }
      }
    }
    await detector.flushIncompleteLap?.();
  } catch {
    return finish(recordingId, "failed", "corrupt_source");
  }
  const existingLaps = await db.select().from(laps).where(inArray(laps.sessionId, existing.map((session) => session.id))).all();
  const detected = capture.laps;
  if (!existingLaps.length || !detected.length) return finish(recordingId, "limited", "insufficient_evidence");
  const used = new Set<number>();
  const capturedToStoredSession = new Map<number, number>();
  const changes: {
    id: number;
    classification: string;
    isValid: boolean;
    invalidReason: string | null;
    expectedClassification: string | null;
    expectedIsValid: boolean;
    expectedInvalidReason: string | null;
  }[] = [];
  for (const detectedLap of detected) {
    const capturedSession = capture.sessions[detectedLap.sessionId - 1];
    if (!capturedSession) return finish(recordingId, "failed", "ambiguous_match");
    const matches = existingLaps.filter((lap) =>
      !used.has(lap.id) &&
      lap.rawByteOffset != null &&
      lap.rawByteOffset === detectedLap.rawByteOffset &&
      lap.rawFrameCount === detectedLap.rawFrameCount
    );
    if (matches.length !== 1) return finish(recordingId, "failed", "ambiguous_match");
    const matchedLap = matches[0]!;
    const owner = existing.find((session) => session.id === matchedLap.sessionId);
    if (!owner) return finish(recordingId, "failed", "ambiguous_match");
    const mappedOwner = capturedToStoredSession.get(detectedLap.sessionId);
    if (mappedOwner !== undefined && mappedOwner !== owner.id) {
      return finish(recordingId, "failed", "ambiguous_match");
    }
    const hasIdentity = (value: string | null) => value !== null && value !== "" && value !== "0" && value !== "unknown";
    if ((hasIdentity(capturedSession.carId) && hasIdentity(owner.carId) && capturedSession.carId !== owner.carId) ||
      (hasIdentity(capturedSession.trackId) && hasIdentity(owner.trackId) && capturedSession.trackId !== owner.trackId)) {
      return finish(recordingId, "failed", "ambiguous_match");
    }
    capturedToStoredSession.set(detectedLap.sessionId, owner.id);
    used.add(matchedLap.id);
    const isLegacyCategoryReason = matchedLap.invalidReason !== null &&
      LEGACY_CATEGORY_BY_REASON[matchedLap.invalidReason] !== undefined;
    const preserveExistingDecision = !isLegacyCategoryReason &&
      (!matchedLap.isValid || matchedLap.invalidReason !== null);
    if (detectedLap.classification) {
      changes.push({
        id: matchedLap.id,
        classification: detectedLap.classification,
        isValid: preserveExistingDecision ? matchedLap.isValid : detectedLap.isValid,
        invalidReason: preserveExistingDecision ? matchedLap.invalidReason : detectedLap.invalidReason,
        expectedClassification: matchedLap.classification,
        expectedIsValid: matchedLap.isValid,
        expectedInvalidReason: matchedLap.invalidReason,
      });
    }
  }
  if (used.size !== existingLaps.length) return finish(recordingId, "failed", "ambiguous_match");
  if (detected.some((lap) => !lap.classification)) return finish(recordingId, "limited", "insufficient_evidence");

  let committed = false;
  await classificationMigrationBarrier("beforeTransaction");
  await withSessionCaptureMaintenanceLock(async () => {
    if (isSessionActive()) {
      await deferRecording(recordingId, "active_capture");
      return;
    }
    const tx = await client.transaction("write");
    try {
      const current = await tx.execute({
        sql: "SELECT source_revision FROM classification_migration_recordings WHERE recording_id=? AND state='running'",
        args: [recordingId],
      });
      if (!current.rows.length || Number(current.rows[0]!.source_revision) !== sourceRevision) {
        await tx.rollback();
        await requeueRecording(recordingId, "source_changed");
        return;
      }
      await classificationMigrationBarrier("insideTransaction");
      const currentFile = await stat(sourcePath);
      if (currentFile.size !== sourceStat.size || currentFile.mtimeMs !== sourceStat.mtimeMs || currentFile.ino !== sourceStat.ino) {
        await tx.rollback();
        await requeueRecording(recordingId, "source_changed");
        return;
      }
      for (const change of changes) {
        const updated = await tx.execute({
          sql: `UPDATE laps SET classification=?,is_valid=?,invalid_reason=?
            WHERE id=? AND classification IS ? AND is_valid=? AND invalid_reason IS ?`,
          args: [
            change.classification, Number(change.isValid), change.invalidReason, change.id,
            change.expectedClassification, Number(change.expectedIsValid), change.expectedInvalidReason,
          ],
        });
        if (Number(updated.rowsAffected) !== 1) {
          await tx.rollback();
          await requeueRecording(recordingId, "source_changed");
          return;
        }
      }
      const completed = await tx.execute({
        sql: "UPDATE classification_migration_recordings SET state='completed',reason=NULL,source_signature=?,result_revision=source_revision WHERE recording_id=? AND state='running' AND source_revision=?",
        args: [classificationSourceSignature(currentFile), recordingId, sourceRevision],
      });
      if (Number(completed.rowsAffected) !== 1) {
        await tx.rollback();
        await requeueRecording(recordingId, "source_changed");
        return;
      }
      await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
      await tx.commit();
      committed = true;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  });
  if (!committed) return;
  await classificationMigrationBarrier("afterCommitBeforeAggregates");
  for (const session of existing) {
    wsManager.broadcastNotification({
      type: "lap-reprocessed",
      sessionId: session.id,
      lapsDetected: changes.length,
      lapsUpdated: changes.length,
      strategy: "in-place",
    });
  }
}

async function requeueRecording(recordingId: string, reason: "source_changed"): Promise<void> {
  const tx = await client.transaction("write");
  try {
    const updated = await tx.execute({
      sql: "UPDATE classification_migration_recordings SET state='pending',source_revision=source_revision+1,source_signature=NULL,reason=? WHERE recording_id=? AND state='running'",
      args: [reason, recordingId],
    });
    if (Number(updated.rowsAffected) > 0) await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function deferRecording(recordingId: string, reason: "active_capture"): Promise<void> {
  const tx = await client.transaction("write");
  try {
    const updated = await tx.execute({
      sql: "UPDATE classification_migration_recordings SET state='pending',source_signature=NULL,reason=? WHERE recording_id=? AND state='running'",
      args: [reason, recordingId],
    });
    if (Number(updated.rowsAffected) > 0) await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function finish(
  recordingId: string,
  state: "limited" | "failed",
  reason: "missing_source" | "insufficient_evidence" | "corrupt_source" | "ambiguous_match" | "source_changed" | "processing_error",
): Promise<void> {
  const tx = await client.transaction("write");
  try {
    const updated = await tx.execute({
      sql: "UPDATE classification_migration_recordings SET state=?,reason=?,source_signature=NULL WHERE recording_id=? AND state='running'",
      args: [state, reason, recordingId],
    });
    if (Number(updated.rowsAffected) > 0) await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export interface ClassificationMigrationWorkerHandle {
  stop(): void;
}

export function startClassificationMigrationWorker(options: { resetInterrupted?: boolean } = {}): ClassificationMigrationWorkerHandle {
  let inventoryReconciled = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void run(), delayMs);
    timer.unref?.();
  };
  const run = async (): Promise<void> => {
    if (isSessionActive()) {
      schedule(1_000);
      return;
    }
    try {
      if (!inventoryReconciled) {
        await withSessionCaptureMaintenanceLock(() => reconcileClassificationMigrationInventory({ resetInterrupted: options.resetInterrupted }));
        inventoryReconciled = true;
        await invalidateStaleCompletedClassificationSources(isSessionActive);
        const status = await getClassificationMigrationStatus();
        wsManager.setClassificationMigrationStatusNotification({ type: "classification-migration-status", ...status });
        schedule(5_000);
        return;
      }
      if (await processNextClassificationRecording()) {
        const status = await getClassificationMigrationStatus();
        wsManager.setClassificationMigrationStatusNotification({ type: "classification-migration-status", ...status });
        schedule(0);
      } else {
        await withSessionCaptureMaintenanceLock(() => reconcileClassificationMigrationInventory());
        await invalidateStaleCompletedClassificationSources(isSessionActive);
        const status = await getClassificationMigrationStatus();
        wsManager.setClassificationMigrationStatusNotification({ type: "classification-migration-status", ...status });
        schedule(5_000);
      }
    } catch (error) {
      console.error("[ClassificationMigration] Worker attempt failed:", error);
      schedule(5_000);
    }
  };
  void run();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
