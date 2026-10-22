import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Manifest } from "@raceiq/capture-splitting";
import { ManifestSchema } from "@raceiq/capture-splitting";
import type { OpponentRemovalPreview, OpponentRemovalRequest, OpponentRemovalSkip, OpponentRemovalStatus } from "@raceiq/shared/racing/sessions/opponent-removal";
import { encodeFrameLength, encodeMetaFrame, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { getLMUPartitionSourceLength, partitionLMUSourceFrame } from "@raceiq/capture-formats/lmu/partition";
import { Effect, Ref, Schema } from "effect";
import { and, eq, inArray } from "drizzle-orm";
import { db, readDb } from "../db";
import { sessions, laps } from "../db/schema";
import { withDatabaseWrite } from "../db/write-coordination";
import { isOwnedSessionRawFile } from "../db/session-queries";
import { clearCaptureManifestCache, clearSessionCaptureCache, iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "./source-loader";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { isSessionActive } from "../telemetry/live-pipeline";
import { getRecordingMaintenanceController, admitMaintenance, releaseMaintenance, RecordingMaintenanceBusyError, trackMaintenanceFiber } from "./maintenance-runtime";
import { loadReferencedCapturePaths, withSessionCaptureMaintenanceLock } from "./cleanup";
import { readLmuOpponentRetention } from "./lmu-companion";
import { resolveRecordingDirectory } from "../runtime/config/recording-directory";

const initialStatus = (): OpponentRemovalStatus => ({
  status: "idle", request: null, done: 0, total: 0, removedSessionIds: [], freedBytes: 0,
  cleanupPendingSessionIds: [], skipped: [], failed: [], error: null,
});
let status = initialStatus();

type SessionRow = { id: number; rawFile: string | null; gameId: string; captureLayoutVersion?: number | null; captureManifestFile?: string | null; captureFormatVersion?: number | null; carId?: string; trackId?: string };
type Candidate = { path: string; referencePath: string; sessionIds: number[]; revision: string; manifest?: Manifest; companionBytes: number; legacy?: boolean };
type Plan = { preview: OpponentRemovalPreview; candidates: Candidate[] };

function skip(sessionIds: number[], reason: OpponentRemovalSkip["reason"]): OpponentRemovalSkip {
  return { sessionIds, reason };
}

async function readManifest(path: string): Promise<Manifest> {
  const bytes = await readFile(path);
  return Schema.decodeUnknownSync(ManifestSchema)(JSON.parse(bytes.toString("utf8")));
}


async function buildPlan(request: OpponentRemovalRequest): Promise<Plan> {
  const rows = await readDb.select({
    id: sessions.id, rawFile: sessions.rawFile, gameId: sessions.gameId,
    captureLayoutVersion: sessions.captureLayoutVersion, captureManifestFile: sessions.captureManifestFile,
    captureFormatVersion: sessions.captureFormatVersion, carId: sessions.carId, trackId: sessions.trackId,
  }).from(sessions).where(inArray(sessions.id, request.sessionIds)).all() as SessionRow[];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const skipped: OpponentRemovalSkip[] = [];
  const candidates: Candidate[] = [];
  const groups = new Map<string, SessionRow[]>();
  for (const id of request.sessionIds) {
    const row = rowsById.get(id);
    if (!row) { skipped.push(skip([id], "not-found")); continue; }
    if (!row.rawFile || !isOwnedSessionRawFile(row.rawFile)) { skipped.push(skip([id], "unowned")); continue; }
    const path = resolve(row.captureManifestFile ?? row.rawFile);
    const group = groups.get(path) ?? [];
    group.push(row); groups.set(path, group);
  }
  const references = await readDb.select({ id: sessions.id, rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile }).from(sessions).all();
  for (const [path, selected] of groups) {
    const ids = selected.map(({ id }) => id).sort((a, b) => a - b);
    const allRefs = references.filter((row) =>
      (row.rawFile !== null && resolve(row.rawFile) === path) ||
      (row.captureManifestFile !== null && resolve(row.captureManifestFile) === path),
    ).map(({ id }) => id).sort((a, b) => a - b);
    if (allRefs.length !== ids.length || allRefs.some((id, index) => id !== ids[index])) { skipped.push(skip(ids, "shared-reference")); continue; }
    if (selected.some((row) => row.gameId !== "lmu")) { skipped.push(skip(ids, "unsupported-format")); continue; }
    const manifestPath = selected[0]!.captureManifestFile
      ? resolve(selected[0]!.captureManifestFile)
      : path.endsWith("capture-manifest.json") ? path : null;
    if (manifestPath && !isOwnedSessionRawFile(manifestPath)) { skipped.push(skip(ids, "unowned")); continue; }
    if (manifestPath) {
      let manifest: Manifest;
      try { manifest = await readManifest(manifestPath); }
      catch { skipped.push(skip(ids, "invalid-source")); continue; }
      const retention = await readLmuOpponentRetention(manifestPath);
      if (retention.opponentRetention === "not-recorded") { skipped.push(skip(ids, "not-recorded")); continue; }
      if (retention.opponentRetention === "removed" && (manifest.cleanupPending?.length ?? 0) === 0) {
        skipped.push(skip(ids, "already-removed"));
        continue;
      }
      if (manifest.opponentRetention === "removed") {
        candidates.push({ path: manifestPath, referencePath: path, sessionIds: ids, revision: manifest.sourceRevision, manifest, companionBytes: 0 });
        continue;
      }
      if (!manifest.opponentCompanion) { skipped.push(skip(ids, "unsupported-format")); continue; }
      const companion = manifest.opponentCompanion;
      if (basename(companion.file) !== companion.file || companion.file.length === 0) {
        skipped.push(skip(ids, "invalid-source"));
        continue;
      }
      const companionPath = resolve(dirname(manifestPath), companion.file);
      const companionBytes = await stat(companionPath).then((value) => value.size).catch(() => 0);
      candidates.push({ path: manifestPath, referencePath: path, sessionIds: ids, revision: manifest.sourceRevision, manifest, companionBytes });
      continue;
    }
    const row = selected[0]!;
    if (selected.length !== 1 || row.captureLayoutVersion != null ||
        (!path.endsWith(".bin") && !path.endsWith(".bin.gz")) ||
        !row.carId || !row.trackId) {
      skipped.push(skip(ids, selected.length > 1 ? "shared-reference" : "unsupported-format"));
      continue;
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) { skipped.push(skip(ids, "invalid-source")); continue; }
    candidates.push({
      path, referencePath: path, sessionIds: ids, revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
      companionBytes: 0, legacy: true,
    });
  }
  const candidateSessionIds = candidates.flatMap((group) => group.sessionIds).sort((a, b) => a - b);
  return {
    preview: {
      request, candidateSessionIds, companionBytes: candidates.reduce((sum, group) => sum + group.companionBytes, 0),
      rewriteSessionIds: candidates.filter((candidate) => candidate.legacy).flatMap((candidate) => candidate.sessionIds).sort((a, b) => a - b),
      skipped,
    },
    candidates,
  };

}
function assertAvailable(): void {
  if (isSessionActive()) throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "An LMU capture is active" });
  const controller = getRecordingMaintenanceController();
  const state = controller.managed.runSync(Ref.get(controller.state));
  if (state !== "idle") throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording storage operation is active" });
}

export async function previewSessionOpponentRemoval(request: OpponentRemovalRequest): Promise<OpponentRemovalPreview> {
  assertAvailable();
  return (await buildPlan(request)).preview;
}

async function persistManifest(path: string, manifest: Manifest): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(manifest), { flag: "wx" });
    const file = await open(temp, "r+");
    try { await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

type LegacyLap = { id: number; sessionId: number; lapNumber: number; rawByteOffset: number | null; rawFrameCount: number | null };
type LegacyChunk = {
  handle: Awaited<ReturnType<typeof open>>;
  tempPath: string;
  path: string;
  id: string;
  kind: "lap" | "auxiliary";
  lapId?: string;
  lapNumber?: number;
  recordCount: number;
  firstOrdinal: number;
  sourceByteStart: number;
  sourceByteEnd: number;
  sourceRecordByteOffset: number;
  ownedFrameByteOffset?: number;
  ownedFrameCount: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  parserBootstrapHash?: string;
  encoder: SparseCaptureEncoder;
  physicalOffset: number;
};

async function rewriteLegacyCandidate(candidate: Candidate): Promise<{ freedBytes: number; cleanupPending: boolean }> {
  if (candidate.sessionIds.length !== 1) throw new Error("Legacy shared sources require a single owning session");
  const sessionId = candidate.sessionIds[0]!;
  const session = await readDb.select({
    id: sessions.id, rawFile: sessions.rawFile, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId,
    captureLayoutVersion: sessions.captureLayoutVersion, captureFormatVersion: sessions.captureFormatVersion,
  }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.rawFile !== candidate.path || session.gameId !== "lmu" || session.captureLayoutVersion !== null) {
    throw new Error("Legacy session ownership changed after preview");
  }
  const lapRows = await readDb.select({
    id: laps.id, sessionId: laps.sessionId, lapNumber: laps.lapNumber,
    rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
  }).from(laps).where(eq(laps.sessionId, sessionId)).all() as LegacyLap[];
  const windows = lapRows.map((lap) => {
    if (lap.rawByteOffset === null || lap.rawFrameCount === null || lap.rawFrameCount <= 0) {
      throw new Error(`Legacy lap ${lap.id} has no source frame window`);
    }
    return { ...lap, remaining: lap.rawFrameCount, startOrdinal: -1 };
  }).sort((a, b) => a.rawByteOffset! - b.rawByteOffset!);
  for (let index = 1; index < windows.length; index++) {
    const previous = windows[index - 1]!;
    const current = windows[index]!;
    if (current.rawByteOffset! <= previous.rawByteOffset!) throw new Error("Legacy lap windows are ambiguous");
  }

  const identity = randomUUID();
  const directory = dirname(candidate.path);
  const chunks: LegacyChunk[] = [];
  const cleanupPaths: string[] = [];
  const manifestPath = `${candidate.path}.opponents-removed.capture-manifest.json`;
  let current: LegacyChunk | null = null;
  let currentGroup = "auxiliary";
  let nextLap = 0;
  let activeLap: (typeof windows)[number] | null = null;
  let ordinal = 0;
  let frameOrdinal = 0;
  let sourceByteOffset = 12;
  let physicalInputOffset = 12;
  let frameWindowsVerified = 0;
  const source: SessionCaptureSource = {
    rawFile: candidate.path, source: null, gameId: "lmu", carId: session.carId, trackId: session.trackId,
    captureFormatVersion: session.captureFormatVersion,
  };

  const startChunk = async (group: string, lap?: (typeof windows)[number]): Promise<LegacyChunk> => {
    const chunkIndex = chunks.length;
    const id = group === "auxiliary" ? `aux-${chunkIndex}` : `lap-${lap!.id}`;
    const fileName = `${basename(candidate.path)}.strip-${identity}-${chunkIndex}.bin`;
    const path = resolve(directory, fileName);
    const tempPath = `${path}.tmp.bin`;
    cleanupPaths.push(path, tempPath);
    const handle = await open(tempPath, "wx");
    const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
    await handle.writeFile(header);
    return {
      handle, tempPath, path, id, kind: lap ? "lap" : "auxiliary",
      ...(lap ? { lapId: String(lap.id), lapNumber: lap.lapNumber } : {}),
      recordCount: 0, firstOrdinal: ordinal, sourceByteStart: sourceByteOffset, sourceByteEnd: sourceByteOffset,
      sourceRecordByteOffset: header.length, ownedFrameCount: 0, encoder: new SparseCaptureEncoder("lmu"), physicalOffset: header.length,
    };
  };
  const finishChunk = async (): Promise<void> => {
    if (!current) return;
    await current.handle.sync();
    await current.handle.close();
    await rename(current.tempPath, current.path);
    chunks.push(current);
    current = null;
  };
  const ensureChunk = async (group: string, lap?: (typeof windows)[number]): Promise<void> => {
    if (current && currentGroup !== group) await finishChunk();
    if (!current) current = await startChunk(group, lap);
    currentGroup = group;
  };

  try {
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true, allowLegacyFullFrames: true })) {
      let lap: (typeof windows)[number] | null = null;
      if (record.kind === "frame") {
        if (!activeLap && nextLap < windows.length && windows[nextLap]!.rawByteOffset === record.offset) {
          activeLap = windows[nextLap++]!;
          activeLap.startOrdinal = frameOrdinal;
        }
        if (!activeLap && nextLap < windows.length && windows[nextLap]!.rawByteOffset! < record.offset) {
          throw new Error(`Legacy lap offset ${windows[nextLap]!.rawByteOffset} is not aligned to a source frame`);
        }
        if (activeLap) {
          lap = activeLap;
          activeLap.remaining--;
          if (activeLap.remaining === 0) {
            frameWindowsVerified += activeLap.rawFrameCount!;
            activeLap = null;
          }
        }
      }
      const group = lap ? String(lap.id) : currentGroup;
      await ensureChunk(group, lap ?? undefined);
      if (record.offset < physicalInputOffset) throw new Error(`Legacy source coordinate regressed at ${record.offset}`);
      physicalInputOffset = record.endOffset;
      let wireLength: number;
      if (record.kind === "frame") {
        const version = record.frame.length >= 10 ? record.frame.readUInt16LE(8) : 0;
        if (version !== 2 && version !== 3) throw new Error(`Unsupported legacy LMU source version ${version}`);
        const partition = partitionLMUSourceFrame(record.frame);
        if (!partition?.companion) throw new Error("Legacy LMU frame cannot be safely partitioned");
        const frameOffset = current!.physicalOffset;
        const encoded = current!.encoder.encode(partition.primary, frameOffset);
        const recordBytes = Buffer.concat([encodeFrameLength(encoded.length, record.frameTimeMs), encoded]);
        await current!.handle.writeFile(recordBytes);
        current!.physicalOffset += recordBytes.length;
        if (lap) {
          lap.startOrdinal = lap.startOrdinal < 0 ? frameOrdinal : lap.startOrdinal;
          current!.ownedFrameByteOffset ??= frameOffset;
          current!.ownedFrameCount++;
        }
        const originalLength = getLMUPartitionSourceLength(partition.primary) ?? record.frame.length;
        wireLength = encodeFrameLength(originalLength, record.frameTimeMs).length + originalLength;
        current!.firstTimestamp ??= record.frameTimeMs;
        current!.lastTimestamp = record.frameTimeMs;
        frameOrdinal++;
      } else {
        const payload = record.kind === "parser-bootstrap" ? encodeParserBootstrapFrame(record.gameId, record.payload)
          : record.kind === "segment-boundary" ? encodeSegmentBoundaryFrame()
          : record.kind === "segment-context" ? encodeSegmentContextFrame()
          : encodeSegmentContextEndFrame();
        await current!.handle.writeFile(payload);
        current!.physicalOffset += payload.length;
        wireLength = record.endOffset - record.offset;
        if (record.kind === "parser-bootstrap") {
          current!.parserBootstrapHash = createHash("sha256").update(record.payload).digest("hex");
        }
      }
      current!.recordCount++;
      current!.sourceByteEnd += wireLength;
      sourceByteOffset += wireLength;
      ordinal++;
    }
    if (activeLap || nextLap !== windows.length || frameWindowsVerified !== windows.reduce((sum, lap) => sum + lap.rawFrameCount!, 0)) {
      throw new Error("Legacy lap windows do not match source frame stream");
    }
    await finishChunk();
    for (const lap of windows) {
      const matches = chunks.filter((chunk) => chunk.kind === "lap" && chunk.lapId === String(lap.id));
      if (matches.length !== 1 || matches[0]!.ownedFrameCount !== lap.rawFrameCount) {
        throw new Error(`Legacy lap ${lap.id} does not map to one rewritten chunk`);
      }
    }
    const publishedChunks = chunks.map((chunk) => ({
      id: chunk.id, kind: chunk.kind, ...(chunk.lapId ? { lapId: chunk.lapId } : {}),
      ...(chunk.lapNumber === undefined ? {} : { lapNumber: chunk.lapNumber }),
      path: basename(chunk.path), byteLength: chunk.physicalOffset, firstOrdinal: chunk.firstOrdinal,
      recordCount: chunk.recordCount, sourceStart: chunk.firstOrdinal, sourceEnd: chunk.firstOrdinal + chunk.recordCount,
      sourceByteStart: chunk.sourceByteStart,
      sourceByteEnd: chunk.sourceByteEnd, sourceRecordByteOffset: chunk.sourceRecordByteOffset,
      ...(chunk.firstTimestamp === undefined ? {} : { firstTimestamp: chunk.firstTimestamp }),
      ...(chunk.lastTimestamp === undefined ? {} : { lastTimestamp: chunk.lastTimestamp }),
      ...(chunk.ownedFrameByteOffset === undefined ? {} : { ownedFrameByteOffset: chunk.ownedFrameByteOffset, ownedFrameCount: chunk.ownedFrameCount }),
      ...(chunk.parserBootstrapHash ? { parserBootstrapHash: chunk.parserBootstrapHash } : {}),
    }));
    let recordStart = 0;
    for (const chunk of publishedChunks) {
      chunk.sourceStart = recordStart;
      chunk.firstOrdinal = recordStart;
      recordStart = chunk.sourceEnd;
    }
    const manifest: Manifest = Schema.decodeSync(ManifestSchema)({
      version: 3, gameId: "lmu", sourceRevision: identity, sourceByteLength: sourceByteOffset,
      sourceRecordCount: ordinal, sourceCoordinates: "native-wire-v1",
      opponentRetention: "removed", cleanupPending: [basename(candidate.path)], chunks: publishedChunks,
    });
    for (const chunk of chunks) cleanupPaths.push(chunk.path);
    await persistManifest(manifestPath, manifest);
    cleanupPaths.push(manifestPath);
    const currentSource = await stat(candidate.path);
    const currentRevision = `${currentSource.dev}:${currentSource.ino}:${currentSource.size}:${currentSource.mtimeMs}`;
    if (currentRevision !== candidate.revision) throw new Error("Legacy source changed during staged rewrite");
    await withDatabaseWrite(() => db.transaction(async (tx) => {
      const ownerRows = await tx.select({ id: sessions.id, rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile }).from(sessions).all();
      const owners = ownerRows.filter((row) =>
        (row.rawFile !== null && resolve(row.rawFile) === candidate.path) ||
        (row.captureManifestFile !== null && resolve(row.captureManifestFile) === candidate.path),
      ).map(({ id }) => id).sort((a, b) => a - b);
      if (owners.length !== 1 || owners[0] !== sessionId || ownerRows.some((row) => row.id === sessionId && row.captureManifestFile !== null)) {
        throw new Error("Legacy source references changed during staged rewrite");
      }
      const checkedSession = await tx.select({
        gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId,
        captureLayoutVersion: sessions.captureLayoutVersion, captureFormatVersion: sessions.captureFormatVersion,
      }).from(sessions).where(eq(sessions.id, sessionId)).get();
      if (!checkedSession || checkedSession.gameId !== session.gameId || checkedSession.carId !== session.carId ||
          checkedSession.trackId !== session.trackId || checkedSession.captureLayoutVersion !== null ||
          checkedSession.captureFormatVersion !== session.captureFormatVersion) {
        throw new Error("Legacy session metadata changed during staged rewrite");
      }
      const checkedLaps = await tx.select({
        id: laps.id, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
      }).from(laps).where(eq(laps.sessionId, sessionId)).all();
      if (checkedLaps.length !== lapRows.length || checkedLaps.some((lap) => {
        const expected = lapRows.find((row) => row.id === lap.id);
        return !expected || expected.rawByteOffset !== lap.rawByteOffset || expected.rawFrameCount !== lap.rawFrameCount;
      })) throw new Error("Legacy lap references changed during staged rewrite");
      const updated = await tx.update(sessions).set({
        rawFile: manifestPath, captureLayoutVersion: 1, captureManifestFile: manifestPath,
        captureArchiveFile: null, captureFormatVersion: 1,
      }).where(and(eq(sessions.id, sessionId), eq(sessions.rawFile, candidate.path))).run();
      if (updated.rowsAffected !== 1) throw new Error("Legacy session changed during staged rewrite");
      for (const lap of windows) {
        const chunk = chunks.find((entry) => entry.kind === "lap" && entry.lapId === String(lap.id));
        if (!chunk) throw new Error(`Missing rewritten capture chunk for lap ${lap.id}`);
        const bound = await tx.update(laps).set({
          captureChunkId: chunk.id, sourceFrameStart: lap.startOrdinal, sourceFrameCount: lap.rawFrameCount,
        }).where(and(eq(laps.id, lap.id), eq(laps.sessionId, sessionId))).run();
        if (bound.rowsAffected !== 1) throw new Error(`Lap ${lap.id} changed during staged rewrite`);
      }
    }));
    cleanupPaths.splice(cleanupPaths.indexOf(manifestPath), 1);
    for (const chunk of chunks) cleanupPaths.splice(cleanupPaths.indexOf(chunk.path), 1);
    clearCaptureManifestCache(manifestPath);
    clearSessionCaptureCache(candidate.path);
    clearSessionCaptureCache(manifestPath);
    for (const lap of lapRows) cacheDelete(lap.id);
    return { freedBytes: 0, cleanupPending: true };
  } catch (error) {
    const unfinished = current as LegacyChunk | null;
    await unfinished?.handle.close().catch(() => {});
    await Promise.all(cleanupPaths.map((path) => rm(path, { force: true }).catch(() => {})));
    await rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function executeCandidate(candidate: Candidate): Promise<{ freedBytes: number; cleanupPending: boolean }> {
  return withSessionCaptureMaintenanceLock(async () => {
    if (isSessionActive()) throw new Error("An LMU capture is active");
    if (candidate.legacy) {
      const info = await stat(candidate.path);
      if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` !== candidate.revision) throw new Error("Legacy source revision changed after preview");
      return rewriteLegacyCandidate(candidate);
    }
    const refs = await readDb.select({ id: sessions.id, rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile }).from(sessions).all();
    const owners = refs.filter((row) =>
      (row.rawFile !== null && resolve(row.rawFile) === resolve(candidate.referencePath)) ||
      (row.captureManifestFile !== null && resolve(row.captureManifestFile) === resolve(candidate.path)),
    ).map(({ id }) => id).sort((a, b) => a - b);
    if (owners.length !== candidate.sessionIds.length || owners.some((id, index) => id !== candidate.sessionIds[index])) throw new Error("Session references changed after preview");
    const current = await readManifest(candidate.path);
    if (current.sourceRevision !== candidate.revision) throw new Error("Source revision changed after preview");
    const pending = [...new Set([...(current.cleanupPending ?? []), ...(current.opponentCompanion ? [current.opponentCompanion.file] : [])])];
    const removed: Manifest = Schema.decodeSync(ManifestSchema)({
      ...current,
      sourceRevision: randomUUID(),
      opponentRetention: "removed",
      cleanupPending: pending,
    });
    await persistManifest(candidate.path, removed);
    clearCaptureManifestCache(candidate.path);
    clearSessionCaptureCache(candidate.path);
    const affectedLaps = await readDb.select({ id: laps.id }).from(laps).where(inArray(laps.sessionId, candidate.sessionIds)).all();
    for (const lap of affectedLaps) cacheDelete(lap.id);
    return { freedBytes: 0, cleanupPending: pending.length > 0 };
  });
}

function snapshot(): OpponentRemovalStatus {
  return { ...status, request: status.request ? { sessionIds: [...status.request.sessionIds] } : null,
    removedSessionIds: [...status.removedSessionIds], cleanupPendingSessionIds: [...status.cleanupPendingSessionIds],
    skipped: status.skipped.map((item) => ({ ...item, sessionIds: [...item.sessionIds] })),
    failed: status.failed.map((item) => ({ ...item, sessionIds: [...item.sessionIds] })) };
}

export function getSessionOpponentRemovalStatus(): OpponentRemovalStatus { return snapshot(); }

export async function startSessionOpponentRemoval(request: OpponentRemovalRequest): Promise<void> {
  assertAvailable();
  const plan = await buildPlan(request);
  const controller = getRecordingMaintenanceController();
  const admitted = await controller.managed.runPromise(admitMaintenance(controller, "maintenance"));
  if (!admitted) throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording storage operation is active" });
  status = { status: "running", request, done: 0, total: request.sessionIds.length, removedSessionIds: [], freedBytes: 0,
    cleanupPendingSessionIds: [], skipped: [...plan.preview.skipped], failed: [], error: null };
  const task = Effect.promise(async () => {
    try {
      for (const candidate of plan.candidates) {
        try {
          const current = await buildPlan({ sessionIds: candidate.sessionIds });
          const revalidated = current.candidates.find((item) => item.path === candidate.path);
          if (!revalidated || revalidated.revision !== candidate.revision) throw new Error("Source changed after preview");
          await executeCandidate(candidate);
          const publishedPath = candidate.legacy ? `${candidate.path}.opponents-removed.capture-manifest.json` : candidate.path;
          // executeCandidate has durably published removal; later cleanup failures cannot roll it back.
          status.removedSessionIds.push(...candidate.sessionIds);
          status.cleanupPendingSessionIds.push(...candidate.sessionIds);
          const cleanup = await recoverPendingOpponentRemovalCleanupDetailed(publishedPath);
          const published = await readManifest(publishedPath);
          status.freedBytes += cleanup.bytes;
          if (!(published.cleanupPending?.length ?? 0)) {
            status.cleanupPendingSessionIds = status.cleanupPendingSessionIds.filter((id) => !candidate.sessionIds.includes(id));
          }
        } catch (error) {
          if (status.removedSessionIds.some((id) => candidate.sessionIds.includes(id)) &&
              !status.cleanupPendingSessionIds.some((id) => candidate.sessionIds.includes(id))) {
            status.cleanupPendingSessionIds.push(...candidate.sessionIds);
          }
          status.failed.push({ sessionIds: candidate.sessionIds, message: error instanceof Error ? error.message : String(error) });
        } finally { status.done += candidate.sessionIds.length; }
      }
      status.done += status.total - status.done;
      status.status = status.failed.length === 0 && status.skipped.length === 0 && status.cleanupPendingSessionIds.length === 0
        ? "success" : status.removedSessionIds.length > 0 ? "partial" : "error";
      status.error = status.status === "error" ? status.failed[0]?.message ?? "No eligible sessions" : null;
    } catch (error) {
      status.status = "error"; status.error = error instanceof Error ? error.message : String(error);
    } finally {
      await controller.managed.runPromise(releaseMaintenance(controller));
    }
  });
  const fiber = controller.managed.runFork(task);
  trackMaintenanceFiber(controller, fiber);
}
async function recoverPendingOpponentRemovalCleanupDetailed(onlyManifestPath?: string): Promise<{ files: number; bytes: number }> {
  if (isSessionActive()) return { files: 0, bytes: 0 };
  const manifestRows = await readDb.select({ manifestFile: sessions.captureManifestFile, rawFile: sessions.rawFile }).from(sessions).all();
  const manifestPaths = [...new Set(manifestRows.flatMap((row) => {
    const path = row.manifestFile ?? (row.rawFile?.endsWith("capture-manifest.json") ? row.rawFile : null);
    return path ? [resolve(path)] : [];
  }))].filter((path) => !onlyManifestPath || path === resolve(onlyManifestPath));
  let removedFiles = 0;
  let freedBytes = 0;
  for (const manifestPath of manifestPaths) {
    await withSessionCaptureMaintenanceLock(async () => {
      if (isSessionActive()) return;
      let manifest: Manifest;
      try { manifest = await readManifest(manifestPath); } catch { return; }
      if (manifest.opponentRetention !== "removed" || !manifest.cleanupPending?.length) return;
      const directory = dirname(manifestPath);
      const canonicalDirectory = await realpath(directory);
      const canonicalRoot = await realpath(resolveRecordingDirectory());
      const directoryRelative = relative(canonicalRoot, canonicalDirectory);
      if (directoryRelative === ".." || directoryRelative.startsWith(`..${sep}`) || isAbsolute(directoryRelative)) return;
      const referenced = await loadReferencedCapturePaths(manifestPath);
      let reclaimedBytes = 0;
      const remaining: string[] = [];
      for (const relativePath of manifest.cleanupPending) {
        if (basename(relativePath) !== relativePath) { remaining.push(relativePath); continue; }
        const path = resolve(directory, relativePath);
        if (relative(directory, path) !== relativePath || !isOwnedSessionRawFile(path) ||
            referenced.has(path) || referenced.has(directory)) {
          remaining.push(relativePath);
          continue;
        }
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) {
            remaining.push(relativePath);
            continue;
          }
          const actual = await realpath(path);
          const resolvedRelative = relative(canonicalDirectory, actual);
          if (resolvedRelative === ".." || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
            remaining.push(relativePath);
            continue;
          }
          await unlink(path);
          removedFiles++;
          if (info.nlink === 1) reclaimedBytes += info.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") remaining.push(relativePath);
        }
      }
      if (remaining.length !== manifest.cleanupPending.length) {
        await persistManifest(manifestPath, Schema.decodeSync(ManifestSchema)({ ...manifest, cleanupPending: remaining }));
        clearCaptureManifestCache(manifestPath);
        clearSessionCaptureCache(manifestPath);
      }
      if (reclaimedBytes > 0) {
        freedBytes += manifest.opponentCompanion ? reclaimedBytes
          : Math.max(0, reclaimedBytes - manifest.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      }
    });
  }
  if (status.status === "partial" && onlyManifestPath === undefined) status.freedBytes += freedBytes;
  if (status.status === "partial" && status.cleanupPendingSessionIds.length > 0) {
    const stillPending: number[] = [];
    for (const id of status.cleanupPendingSessionIds) {
      const row = await readDb.select({ manifestFile: sessions.captureManifestFile }).from(sessions).where(eq(sessions.id, id)).get();
      if (!row?.manifestFile || (await readManifest(row.manifestFile).catch(() => null))?.cleanupPending?.length) stillPending.push(id);
    }
    status.cleanupPendingSessionIds = stillPending;
    if (!stillPending.length && !status.failed.length && !status.skipped.length) status.status = "success";
  }
  return { files: removedFiles, bytes: freedBytes };
}

export async function recoverPendingOpponentRemovalCleanup(): Promise<number> {
  return (await recoverPendingOpponentRemovalCleanupDetailed()).files;
}
