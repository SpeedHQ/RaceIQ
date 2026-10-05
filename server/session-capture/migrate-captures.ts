import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
import { once } from "node:events";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { listCaptureMigrationCandidates } from "../db/session-queries";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame } from "./framing";
import { clearSessionCaptureCache, iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "./source-loader";
import { SparseCaptureEncoder } from "./sparse-recorder";
import { getRecorderEngine, getRecordingEngineKind, runRecordingJob } from "../runtime/recorder-engine";
import { resolveDataDir } from "../runtime/config/data-dir";
import type { GameId } from "@raceiq/shared/games/ids";


type Candidate = { rawFile: string; gameId: GameId; sessionIds: number[] };
type Result = { rawFile: string; status: "migrated" | "error"; error?: string };
export interface CaptureMigrationResult {
  migrated: number;
  failed: number;
  results: Result[];
}
export interface CaptureMigrationProgress {
  status: "idle" | "running" | "success" | "partial" | "error";
  done: number;
  total: number;
  migrated: number;
  failed: number;
  error: string | null;
}

let captureMigrationProgress: CaptureMigrationProgress = {
  status: "idle",
  done: 0,
  total: 0,
  migrated: 0,
  failed: 0,
  error: null,
};

export function getCaptureMigrationProgress(): CaptureMigrationProgress {
  return { ...captureMigrationProgress };
}

export async function migrateCaptures(onProgress?: (done: number, total: number, result: Result) => void): Promise<CaptureMigrationResult> {
  return runRecordingJob(() => withSessionCaptureMaintenanceLock(async () => {
    // Only closed legacy raw captures qualify; live sparse captures are excluded by format version.
    const candidates = await listCaptureMigrationCandidates();
    const results: Result[] = [];
    let migrated = 0;
    let failed = 0;
    captureMigrationProgress = {
      status: "running",
      done: 0,
      total: candidates.length,
      migrated: 0,
      failed: 0,
      error: null,
    };
    for (const candidate of candidates) {
      const result = await migrateOne(candidate);
      results.push(result);
      if (result.status === "migrated") migrated++;
      else failed++;
      captureMigrationProgress = {
        status: "running",
        done: results.length,
        total: candidates.length,
        migrated,
        failed,
        error: result.error ?? captureMigrationProgress.error,
      };
      onProgress?.(results.length, candidates.length, result);
    }
    captureMigrationProgress = {
      ...captureMigrationProgress,
      status: failed === 0 ? "success" : "partial",
      done: results.length,
      total: candidates.length,
      migrated,
      failed,
    };
    return { migrated, failed, results };
  }));
}

type LapOffset = { id: number; rawByteOffset: number | null; rawFrameCount: number | null };

/** A capture may predate the optional 12-byte meta header. Read only its first bytes. */
async function readCanonicalHeader(path: string): Promise<number | null> {
  let header: Buffer;
  if (path.endsWith(".gz")) {
    const input = createReadStream(path);
    const gunzip = createGunzip();
    input.pipe(gunzip);
    const pieces: Buffer[] = [];
    let length = 0;
    try {
      for await (const part of gunzip) {
        pieces.push(part);
        length += part.length;
        if (length >= 12) break;
      }
    } finally {
      gunzip.destroy();
      input.destroy();
    }
    header = Buffer.concat(pieces, length).subarray(0, 12);
  } else {
    const file = await open(path, "r");
    try {
      header = Buffer.alloc(12);
      const { bytesRead } = await file.read(header, 0, 12, 0);
      header = header.subarray(0, bytesRead);
    } finally { await file.close(); }
  }
  if (header.length < 4) throw new Error("Truncated canonical capture prefix");
  if (header.readUInt32LE(0) !== 0xffffffff) {
    const length = header.readUInt32LE(0) & 0x7fffffff;
    if (length === 0 || length > 16 * 1024 * 1024) throw new Error("Invalid canonical capture prefix");
    return null;
  }
  if (header.length !== 12 || header.readUInt32LE(4) !== 4) throw new Error("Invalid canonical capture header");
  return header.readUInt32LE(8);
}

function source(rawFile: string, gameId: GameId): SessionCaptureSource {
  return { rawFile, gameId, source: null, carOrdinal: -1, trackOrdinal: -1 };
}

async function writeVerifiedStage(candidate: Candidate, stage: string, lapRows: LapOffset[]): Promise<Map<number, number>> {
  return getRecordingEngineKind() === "rust"
    ? writeRustStage(candidate, stage, lapRows)
    : writeBunStage(candidate, stage, lapRows);
}

async function writeBunStage(candidate: Candidate, stage: string, lapRows: LapOffset[]): Promise<Map<number, number>> {
  const frameCount = await readCanonicalHeader(candidate.rawFile);
  const writer = createWriteStream(stage, { flags: "wx" });
  const gzip = stage.endsWith(".gz") ? createGzip() : null;
  const target = gzip ?? writer;
  const completion = gzip ? pipeline(gzip, writer) : finished(writer);
  const encoder = new SparseCaptureEncoder(candidate.gameId);
  const mapped = new Map<number, number>();
  const lapStarts = new Set(lapRows.map((lap) => lap.rawByteOffset).filter((value): value is number => value !== null));
  let offset = 0;
  let accepted = 0;
  const append = async (bytes: Buffer) => {
    if (!target.write(bytes)) await once(target, "drain");
    offset += bytes.length;
  };
  try {
    if (frameCount !== null) await append(encodeMetaFrame(frameCount));
    for await (const record of iterateSessionCaptureRecordsFromSource(source(candidate.rawFile, candidate.gameId), { strict: true })) {
      if (record.kind === "frame") {
        if (lapStarts.has(record.offset)) mapped.set(record.offset, offset);
        const payload = encoder.encode(record.frame, offset);
        await append(encodeFrameLength(payload.length, record.frameTimeMs));
        await append(payload);
        accepted++;
      } else {
        encoder.reset();
        await append(record.kind === "segment-boundary" ? encodeSegmentBoundaryFrame()
          : record.kind === "segment-context" ? encodeSegmentContextFrame() : encodeSegmentContextEndFrame());
      }
    }
    if (frameCount !== null && accepted !== frameCount) throw new Error(`Capture frame-count mismatch: header ${frameCount}, decoded ${accepted}`);
    if (mapped.size !== lapStarts.size) throw new Error("Lap offset does not point to a source frame");
    target.end();
    await completion;
    const handle = await open(stage, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    target.destroy();
    if (gzip) writer.destroy();
    await completion.catch(() => {});
    throw error;
  }
  return mapped;
}

async function writeRustStage(candidate: Candidate, stage: string, lapRows: LapOffset[]): Promise<Map<number, number>> {
  const engine = getRecorderEngine();
  if (!engine) throw new Error("Rust recorder is not registered");
  const outputRoot = resolve(resolveDataDir(), "recorder-jobs", `migration-${crypto.randomUUID()}`);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const jobId = `migrate-${crypto.randomUUID()}`;
  const oldOffsets = [...new Set(lapRows.flatMap((lap) => lap.rawByteOffset === null ? [] : [lap.rawByteOffset]))];
  try {
    const response = await engine.request("encode-capture", {
      jobId, gameId: candidate.gameId, sourcePath: resolve(candidate.rawFile), outputRoot,
      oldOffsets: oldOffsets.map(String),
    }) as Record<string, unknown>;
    if (response.jobId !== jobId || typeof response.resultPath !== "string") throw new Error("Invalid Rust capture-encode response");
    const resultPath = containedJobPath(outputRoot, response.resultPath, "manifest");
    const manifest = await Bun.file(resultPath).json() as Record<string, unknown>;
    if (manifest.version !== 1 || manifest.jobId !== jobId || manifest.operation !== "encode-capture" ||
        !Number.isSafeInteger(manifest.frameCount) || !Array.isArray(manifest.offsets)) throw new Error("Invalid Rust capture-encode manifest");
    const artifact = containedJobPath(outputRoot, manifest.artifactPath, "capture artifact");
    const mappings = new Map<number, number>();
    for (const value of manifest.offsets) {
      if (!value || typeof value !== "object") throw new Error("Invalid Rust capture offset mapping");
      const mapping = value as Record<string, unknown>;
      const from = migrationOffset(mapping.oldOffset);
      const to = migrationOffset(mapping.newOffset);
      if (mappings.has(from)) throw new Error("Duplicate Rust capture offset mapping");
      mappings.set(from, to);
    }
    if (mappings.size !== oldOffsets.length || oldOffsets.some((offset) => !mappings.has(offset))) throw new Error("Rust capture offset mappings are incomplete");
    if (stage.endsWith(".gz")) await pipeline(createReadStream(artifact), createGzip(), createWriteStream(stage, { flags: "wx" }));
    else await pipeline(createReadStream(artifact), createWriteStream(stage, { flags: "wx" }));
    const handle = await open(stage, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    if (manifest.frameCount !== await countSourceFrames(stage, candidate.gameId)) throw new Error("Rust capture frame-count mismatch");
    return mappings;
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

async function countSourceFrames(path: string, gameId: GameId): Promise<number> {
  let count = 0;
  for await (const record of iterateSessionCaptureRecordsFromSource(source(path, gameId), { strict: true })) {
    if (record.kind === "frame") count++;
  }
  return count;
}
function migrationOffset(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid Rust capture offset");
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Rust capture offset exceeds safe integer range");
  return Number(parsed);
}

function containedJobPath(root: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`Invalid Rust ${label} path`);
  const full = realpathSync(value);
  const rel = relative(realpathSync(root), full);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Rust ${label} path escapes job root`);
  }
  return full;
}

/** Compare *every* restored frame and marker, not compressed bytes or hashes. */
async function verifyStage(candidate: Candidate, stage: string, lapRows: LapOffset[], mapped: Map<number, number>): Promise<void> {
  const input = iterateSessionCaptureRecordsFromSource(source(candidate.rawFile, candidate.gameId), { strict: true })[Symbol.asyncIterator]();
  const output = iterateSessionCaptureRecordsFromSource(source(stage, candidate.gameId), { strict: true })[Symbol.asyncIterator]();
  const starts = new Map<number, LapOffset[]>();
  for (const lap of lapRows) {
    if (lap.rawByteOffset === null) continue;
    const sameOffset = starts.get(lap.rawByteOffset);
    if (sameOffset) sameOffset.push(lap);
    else starts.set(lap.rawByteOffset, [lap]);
  }
  const lapFrames = new Map<number, { start: number; count: number }>();
  let frameIndex = 0;
  try {
    while (true) {
      const [before, after] = await Promise.all([input.next(), output.next()]);
      if (before.done || after.done) {
        if (before.done !== after.done) throw new Error("Migrated capture record count mismatch");
        break;
      }
      if (before.value.kind !== after.value.kind ||
          (before.value.kind === "frame" && (after.value.kind !== "frame" || !before.value.frame.equals(after.value.frame) ||
            before.value.frameTimeMs !== after.value.frameTimeMs))) {
        throw new Error(`Migrated capture source-byte mismatch at ${before.value.offset}`);
      }
      if (before.value.kind !== "frame") continue;
      if (mapped.get(before.value.offset) !== undefined && mapped.get(before.value.offset) !== after.value.offset) {
        throw new Error("Migrated lap offset does not point to matching frame");
      }
      const lapsStartingHere = starts.get(before.value.offset);
      if (lapsStartingHere) {
        for (const lap of lapsStartingHere) lapFrames.set(lap.id, { start: frameIndex, count: lap.rawFrameCount ?? 0 });
      }
      frameIndex++;
    }
  } finally {
    await Promise.all([input.return?.(undefined), output.return?.(undefined)]);
  }
  for (const lap of lapRows) {
    if (lap.rawByteOffset === null) {
      if ((lap.rawFrameCount ?? 0) > 0) throw new Error(`Lap ${lap.id} has no source offset`);
      continue;
    }
    const window = lapFrames.get(lap.id);
    if (!window || !mapped.has(lap.rawByteOffset) || window.count < 0 || window.start + window.count > frameIndex) {
      throw new Error(`Lap ${lap.id} has invalid source frame window`);
    }
  }
  const originalCount = await readCanonicalHeader(candidate.rawFile);
  if (await readCanonicalHeader(stage) !== originalCount ||
      (originalCount !== null && originalCount !== frameIndex)) throw new Error("Migrated header frame-count mismatch");
}

async function commit(candidate: Candidate, lapRows: LapOffset[], mapped: Map<number, number>, final: string): Promise<void> {
  await db.transaction(async (tx) => {
    const shared = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.rawFile, candidate.rawFile)).all();
    if (shared.length !== candidate.sessionIds.length || shared.some((row) => !candidate.sessionIds.includes(row.id))) {
      throw new Error("Capture sessions changed during migration");
    }
    for (const lap of lapRows) {
      if (lap.rawByteOffset === null) continue;
      const rawByteOffset = mapped.get(lap.rawByteOffset);
      if (rawByteOffset === undefined) throw new Error(`Missing remapped lap ${lap.id}`);
      const changed = await tx.update(laps).set({ rawByteOffset }).where(eq(laps.id, lap.id)).run();
      if (changed.rowsAffected !== 1) throw new Error(`Lap ${lap.id} changed during migration`);
    }
    const changed = await tx.update(sessions)
      .set({ captureFormatVersion: 1, rawFile: final })
      .where(inArray(sessions.id, candidate.sessionIds)).run();
    if (changed.rowsAffected !== candidate.sessionIds.length) throw new Error("Capture session update incomplete");
  });
}

function invalidateCapture(candidate: Candidate, lapRows: LapOffset[], final: string): void {
  for (const lap of lapRows) cacheDelete(lap.id);
  clearSessionCaptureCache(candidate.rawFile);
  clearSessionCaptureCache(final);
}


async function migrateOne(candidate: Candidate): Promise<Result> {
  const suffix = candidate.rawFile.endsWith(".bin.gz") ? ".bin.gz" : ".bin";
  const stem = basename(candidate.rawFile, suffix);
  const uuid = crypto.randomUUID();
  const final = join(dirname(candidate.rawFile), `${stem}.${uuid}${suffix}`);
  const stage = join(dirname(candidate.rawFile), `${stem}.${uuid}.stage${suffix}`);
  let renamed = false;
  let committed = false;
  try {
    const lapRows = await db.select({ id: laps.id, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount })
      .from(laps).where(inArray(laps.sessionId, candidate.sessionIds)).all();
    const mapped = await writeVerifiedStage(candidate, stage, lapRows);
    await verifyStage(candidate, stage, lapRows, mapped);
    // Every verified legacy capture receives a new canonical file, even if compression yields no size saving.
    await rename(stage, final);
    renamed = true;
    await commit(candidate, lapRows, mapped, final);
    committed = true;
    invalidateCapture(candidate, lapRows, final);
    try {
      const stillReferenced = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.rawFile, candidate.rawFile)).limit(1).get();
      if (!stillReferenced) await unlink(candidate.rawFile);
    } catch (error) {
      console.warn(`[Capture migration] Could not remove unreferenced source ${candidate.rawFile}:`, error);
    }
    return { rawFile: candidate.rawFile, status: "migrated" };
  } catch (error) {
    if (renamed && !committed) await rm(final, { force: true }).catch(() => {});
    if (committed) {
      console.warn(`[Capture migration] Post-commit cleanup failed for ${candidate.rawFile}:`, error);
      return { rawFile: candidate.rawFile, status: "migrated" };
    }
    return { rawFile: candidate.rawFile, status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(stage, { force: true }).catch(() => {});
  }
}

