import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import type { GameId } from "@raceiq/shared/games/ids";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import { getLMUPartitionSourceLength } from "@raceiq/capture-formats/lmu/partition";
import { encodeFrameLength, META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";
import { MAX_CAPTURE_MANIFEST_BYTES, ManifestSchema, PublishedManifestSchema, type Manifest, type PublishedManifest } from "@raceiq/capture-splitting";
import { db, readDb } from "../db/index";
import { laps, sessions } from "../db/schema";
import { withDatabaseWrite } from "../db/write-coordination";
import { isSessionActive } from "../telemetry/live-pipeline";
import { clearCaptureManifestCache, clearSessionCaptureCache, iterateSessionCaptureRecordsFromSource } from "./source-loader";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { persistCaptureManifest } from "./manifest-persistence";
import { and, eq, inArray, like, or } from "drizzle-orm";

export interface DirectCaptureRepairResult { repaired: number; failed: number; deferred: boolean }
type SessionRow = typeof sessions.$inferSelect;
type LapRow = typeof laps.$inferSelect;
function fail(message: string): never { throw new Error(message); }
async function safeFile(path: string, root: string): Promise<string> {
  if (isAbsolute(path) || basename(path) !== path || path === "." || path === "..") fail(`Unsafe capture member path: ${path}`);
  const candidate = resolve(root, path);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Unsafe capture member: ${path}`);
  const real = await realpath(candidate);
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`Capture member escapes directory: ${path}`);
  return real;
}
async function parseManifest(path: string): Promise<PublishedManifest> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("Unsafe capture manifest");
  if (info.size > MAX_CAPTURE_MANIFEST_BYTES) fail("Oversized capture manifest");
  return Schema.decodeUnknownSync(PublishedManifestSchema)(JSON.parse((await readFile(path)).toString("utf8")));
}
async function parseRecoveryManifest(path: string): Promise<Manifest> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("Unsafe recovery manifest");
  if (info.size > MAX_CAPTURE_MANIFEST_BYTES) fail("Oversized recovery manifest");
  return Schema.decodeUnknownSync(ManifestSchema)(JSON.parse((await readFile(path)).toString("utf8")));
}
function mayUseRecovery(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  return error instanceof SyntaxError || (error instanceof Error && error.name === "SchemaError");
}
async function validateChunk(path: string, chunk: Manifest["chunks"][number], gameId: GameId): Promise<void> {
  if ((await stat(path)).size !== chunk.byteLength) fail(`Chunk ${chunk.id} byte length mismatch`);
  const source = { rawFile: path, source: null, gameId, carId: "", trackId: "", captureFormatVersion: 1 };
  let nativeOffset = chunk.sourceByteStart;
  let recordCount = 0;
  let ownedFrames = 0;
  let firstOwnedOffset: number | undefined;
  let trailingFrames = 0;
  let bootstrapSeen = false;
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true, allowLegacyFullFrames: true })) {
    if (record.offset < chunk.sourceRecordByteOffset!) {
      if (record.kind === "parser-bootstrap" && chunk.parserBootstrapHash !== undefined) {
        if (bootstrapSeen || record.gameId !== gameId || createHash("sha256").update(record.payload).digest("hex") !== chunk.parserBootstrapHash) {
          fail(`Chunk ${chunk.id} parser bootstrap mismatch`);
        }
        bootstrapSeen = true;
      }
      continue;
    }
    if (recordCount >= chunk.recordCount) {
      if (record.kind !== "frame") fail(`Chunk ${chunk.id} has unexpected trailing metadata`);
      trailingFrames++;
      continue;
    }
    if (recordCount === 0 && record.offset !== chunk.sourceRecordByteOffset) fail(`Chunk ${chunk.id} source offset is not record-aligned`);
    if (record.kind === "frame") {
      const nativeLength = getLMUPartitionSourceLength(record.frame) ?? record.frame.length;
      nativeOffset += encodeFrameLength(nativeLength, record.frameTimeMs).length + nativeLength;
      firstOwnedOffset ??= record.offset;
      ownedFrames++;
    } else {
      nativeOffset += record.endOffset - record.offset;
    }
    recordCount++;
  }
  if (recordCount !== chunk.recordCount || nativeOffset !== chunk.sourceByteEnd) fail(`Chunk ${chunk.id} range/count mismatch`);
  if (chunk.parserBootstrapHash !== undefined && !bootstrapSeen) fail(`Chunk ${chunk.id} parser bootstrap is missing`);
  if (chunk.kind === "lap" && (ownedFrames !== chunk.ownedFrameCount || firstOwnedOffset !== chunk.ownedFrameByteOffset)) {
    fail(`Chunk ${chunk.id} lap ownership mismatch`);
  }
  if (trailingFrames !== (chunk.trailingContextFrameCount ?? 0)) fail(`Chunk ${chunk.id} trailing context mismatch`);
}
async function inspect(manifestPath: string, manifest: Manifest, owner: SessionRow, lapRows: LapRow[]): Promise<void> {
  if (manifest.version !== 3 || manifest.sourceCoordinates !== "native-wire-v1" || manifest.gameId !== owner.gameId) fail("Unsupported direct capture manifest");
  const root = await realpath(dirname(manifestPath));
  const chunkIds = new Set<string>();
  const lapIds = new Set<string>();
  let ordinal = 0;
  let sourceByte = META_FRAME_BYTES;
  for (const chunk of manifest.chunks) {
    if (chunk.firstOrdinal !== ordinal || chunk.sourceStart !== ordinal || chunk.sourceEnd - chunk.sourceStart !== chunk.recordCount || chunk.sourceByteStart !== sourceByte || chunk.sourceByteEnd < sourceByte) fail(`Chunk ${chunk.id} has discontinuous coordinates`);
    if (chunkIds.has(chunk.id)) fail(`Duplicate chunk ID ${chunk.id}`);
    chunkIds.add(chunk.id);
    if (chunk.kind === "lap") {
      if (!chunk.lapId || chunk.lapNumber === undefined || chunk.ownedFrameByteOffset === undefined || chunk.ownedFrameCount === undefined || lapIds.has(chunk.lapId)) fail(`Invalid or duplicate lap chunk ${chunk.id}`);
      const lap = lapRows.find((row) => String(row.id) === chunk.lapId);
      if (!lap) fail(`Manifest references unknown lap ${chunk.lapId}`);
      if (lap.lapNumber !== chunk.lapNumber || lap.rawByteOffset !== chunk.sourceByteStart || lap.rawFrameCount !== chunk.ownedFrameCount) fail(`Lap ${lap.id} ownership mismatch`);
      lapIds.add(chunk.lapId);
    } else if (chunk.lapId !== undefined || chunk.lapNumber !== undefined || chunk.ownedFrameByteOffset !== undefined || chunk.ownedFrameCount !== undefined) fail(`Auxiliary chunk ${chunk.id} has lap ownership`);
    if (chunk.recordCount > 0 && chunk.sourceRecordByteOffset === undefined) fail(`Chunk ${chunk.id} lacks sourceRecordByteOffset`);
    await validateChunk(await safeFile(chunk.path, root), chunk, manifest.gameId);
    ordinal = chunk.sourceEnd;
    sourceByte = chunk.sourceByteEnd;
  }
  if (ordinal !== manifest.sourceRecordCount || sourceByte !== manifest.sourceByteLength) fail("Manifest source totals mismatch");
  for (const lap of lapRows) {
    const chunk = manifest.chunks.find((item) => item.kind === "lap" && item.lapId === String(lap.id));
    if (lap.captureChunkId !== null && (!chunk || chunk.id !== lap.captureChunkId)) fail(`Published lap ${lap.id} references conflicting chunk`);
  }
  if (manifest.opponentCompanion && manifest.opponentRetention !== "removed" && manifest.opponentRetention !== "not-recorded") {
    const companion = manifest.opponentCompanion;
    const path = await safeFile(companion.file, root);
    const info = await stat(path);
    if (companion.committedPrefix.byteLength !== companion.byteLength || info.size !== companion.byteLength) fail("Companion committed evidence length mismatch");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (hash.digest("hex") !== companion.sha256) fail("Companion digest mismatch");
    let companionRecords = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource(
      { rawFile: path, source: null, gameId: "lmu", carId: "", trackId: "", captureFormatVersion: 1 },
      { strict: true, allowLegacyFullFrames: true },
    )) {
      if (record.kind === "frame") companionRecords++;
    }
    if (companionRecords !== companion.committedPrefix.recordCount) fail("Companion committed record count mismatch");
  }
}
function fullyPublished(owner: SessionRow, manifest: Manifest, lapRows: LapRow[], path: string): boolean {
  return owner.rawFile === path && owner.captureManifestFile === path && owner.captureLayoutVersion === 1 &&
    manifest.chunks.filter((chunk) => chunk.kind === "lap").every((chunk) => {
      const lap = lapRows.find((row) => String(row.id) === chunk.lapId);
      return !!lap && lap.captureChunkId === chunk.id && lap.sourceFrameStart === chunk.firstOrdinal && lap.sourceFrameCount === chunk.ownedFrameCount;
    }) &&
    lapRows.every((lap) => lap.captureChunkId === null || manifest.chunks.some((chunk) => chunk.kind === "lap" && chunk.id === lap.captureChunkId && chunk.lapId === String(lap.id)));
}
async function recheck(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], owner: SessionRow, lapRows: LapRow[], path: string): Promise<void> {
  const session = await tx.select().from(sessions).where(eq(sessions.id, owner.id)).get();
  if (!session || session.rawFile !== owner.rawFile || session.captureManifestFile !== owner.captureManifestFile || session.captureLayoutVersion !== owner.captureLayoutVersion || session.gameId !== owner.gameId || session.carId !== owner.carId || session.trackId !== owner.trackId) fail("Session reference changed during repair");
  const sameManifestOwners = await tx.select({ id: sessions.id }).from(sessions)
    .where(or(eq(sessions.rawFile, path), eq(sessions.captureManifestFile, path))).all();
  if (sameManifestOwners.length !== 1 || sameManifestOwners[0]!.id !== owner.id) fail("Manifest ownership changed during repair");
  const currentLaps = await tx.select().from(laps).where(eq(laps.sessionId, owner.id)).all();
  if (currentLaps.length !== lapRows.length) fail("Lap rows changed during repair");
  for (const lap of lapRows) {
    const current = currentLaps.find((row) => row.id === lap.id);
    if (!current || current.lapNumber !== lap.lapNumber || current.rawByteOffset !== lap.rawByteOffset || current.rawFrameCount !== lap.rawFrameCount || current.captureChunkId !== lap.captureChunkId || current.sourceFrameStart !== lap.sourceFrameStart || current.sourceFrameCount !== lap.sourceFrameCount) fail(`Lap ${lap.id} changed during repair`);
  }
}
export async function repairDirectCaptureManifests(): Promise<DirectCaptureRepairResult> {
  if (isSessionActive()) return { repaired: 0, failed: 0, deferred: true };
  return withSessionCaptureMaintenanceLock(async () => {
    if (isSessionActive()) return { repaired: 0, failed: 0, deferred: true };
    let repaired = 0;
    let failed = 0;
    const sessionRows = await readDb.select().from(sessions).where(or(
      like(sessions.captureManifestFile, "%capture-manifest.json"),
      like(sessions.rawFile, "%capture-manifest.json"),
    )).all();
    if (sessionRows.length === 0) return { repaired, failed, deferred: false };
    const references = new Map<string, SessionRow[]>();
    const ownerIds = new Set<number>();
    for (const row of sessionRows) {
      for (const path of new Set([row.captureManifestFile, row.rawFile].filter((value): value is string => value !== null && value.endsWith("capture-manifest.json")))) {
        const key = resolve(path);
        const owners = references.get(key) ?? [];
        owners.push(row);
        references.set(key, owners);
        ownerIds.add(row.id);
      }
    }
    const lapRowsAll = ownerIds.size > 0 ? await readDb.select().from(laps).where(inArray(laps.sessionId, [...ownerIds])).all() : [];
    const lapsBySession = new Map<number, LapRow[]>();
    for (const lap of lapRowsAll) {
      const rows = lapsBySession.get(lap.sessionId) ?? [];
      rows.push(lap);
      lapsBySession.set(lap.sessionId, rows);
    }
    for (const [path, owners] of references) {
      if (isSessionActive()) return { repaired, failed, deferred: true };
      const owner = owners[0]!;
      const ownedLaps = lapsBySession.get(owner.id) ?? [];
      try {
        let primary: PublishedManifest | null = null;
        let backupRequired = false;
        try { primary = await parseManifest(path); }
        catch (error) {
          if (!mayUseRecovery(error)) throw error;
          backupRequired = true;
        }
        let candidate: Manifest;
        if (primary && primary.version !== 3) continue;
        if (primary?.version === 3 && primary.sourceCoordinates !== "native-wire-v1") continue;
        if (primary) candidate = primary;
        else candidate = await parseRecoveryManifest(`${path}.recovery`);
        if (owners.length !== 1) fail("Manifest is referenced by multiple sessions");
        if (primary?.version === 3 && fullyPublished(owner, primary, ownedLaps, path)) continue;
        if (owner.rawFile !== path && owner.captureManifestFile !== path) fail("Manifest reference changed");
        await inspect(path, candidate, owner, ownedLaps);
        if (isSessionActive()) return { repaired, failed, deferred: true };
        await withDatabaseWrite(() => db.transaction(async (tx) => recheck(tx, owner, ownedLaps, path)));
        if (isSessionActive()) return { repaired, failed, deferred: true };
        if (backupRequired) await persistCaptureManifest(path, candidate);
        await withDatabaseWrite(() => db.transaction(async (tx) => {
          if (isSessionActive()) fail("Capture became active before publication");
          await recheck(tx, owner, ownedLaps, path);
          for (const chunk of candidate.chunks) {
            if (chunk.kind !== "lap") continue;
            const lap = ownedLaps.find((row) => String(row.id) === chunk.lapId)!;
            await tx.update(laps).set({ captureChunkId: chunk.id, sourceFrameStart: chunk.firstOrdinal, sourceFrameCount: chunk.ownedFrameCount }).where(and(eq(laps.id, lap.id), eq(laps.sessionId, owner.id))).run();
          }
          await tx.update(sessions).set({ rawFile: path, captureManifestFile: path, captureLayoutVersion: 1 }).where(eq(sessions.id, owner.id)).run();
        }));
        clearCaptureManifestCache(path);
        clearSessionCaptureCache(path);
        repaired++;
      } catch (error) {
        failed++;
        console.error("[CaptureRepair] Failed manifest repair", path, error);
      }
    }
    return { repaired, failed, deferred: false };
  });
}
