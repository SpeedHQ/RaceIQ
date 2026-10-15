import { gunzipBuffer, META_FRAME_MAGIC, readFrameStreamStart, iterateSessionFrameRecords } from "@raceiq/capture-formats/session/framing";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { MOTEC_SESSION_SOURCE } from "@raceiq/shared/integrations/motec";
import { decodeMotecSourceArchive, type MotecOffsetEncoding } from "../motec/source-archive";
import { realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { ManifestSchema, type Chunk, type Manifest } from "@raceiq/capture-splitting";
import { Schema } from "effect";
import { parseLd } from "../motec/ld";
import { parseLdxBeacons } from "../motec/ldx";
import { resolveMotecTarget } from "../motec/targets";
import { countSourceFrameScanned } from "./test-instrumentation";
import {
  SEGMENT_BOUNDARY_MAGIC,
  SEGMENT_BOUNDARY_VERSION,
  SEGMENT_CONTEXT_MAGIC,
  SEGMENT_CONTEXT_VERSION,
  SEGMENT_CONTEXT_END_MAGIC,
  decodeParserBootstrapPayload,
  readFramePrefix,
  type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import { decodeLmuSparseFrame, isLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { decodeKunosSparseFrame, isKunosSparseFrame, kunosSourceMagic } from "@raceiq/capture-formats/session/kunos-sparse";
import { decodeGenericSparseFrame, genericFrameIdentity, isGenericSparseFrame } from "@raceiq/capture-formats/session/generic-sparse";

export interface SessionCaptureFrameRecord { readonly offset: number; readonly length: number; readonly frameIndex: number; }
export interface SessionCaptureFrameIndex {
  readonly records: readonly SessionCaptureFrameRecord[];
  readonly byOffset: ReadonlyMap<number, SessionCaptureFrameRecord>;
}
export interface SessionCaptureSource { rawFile: string; source: string | null; gameId: GameId; carId: string; trackId: string; }
export type LoadedSessionSource =
  | { kind: "capture"; buffer: Buffer; frameIndex: SessionCaptureFrameIndex }
  | { kind: "packets"; packets: TelemetryPacket[]; offsetEncoding: MotecOffsetEncoding };
interface CacheEntry { size: number; mtimeMs: number; loaded: LoadedSessionSource }
export interface SessionCaptureFile {
  readonly size: number;
  readonly lastModified: number;
  slice(start?: number, end?: number): Blob;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
type CaptureFileFactory = (path: string) => SessionCaptureFile;
let captureFileFactory: CaptureFileFactory = (path) => Bun.file(path);
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 2;
const MAX_CAPTURE_RECORD_BYTES = 16 * 1024 * 1024;
function assertCaptureRecordLength(length: number): void {
  if (length > MAX_CAPTURE_RECORD_BYTES) {
    throw new Error(`Capture record length ${length} exceeds 16 MiB limit`);
  }
}
export function indexCaptureFrames(buffer: Buffer): SessionCaptureFrameIndex {
  const records: SessionCaptureFrameRecord[] = [];
  const byOffset = new Map<number, SessionCaptureFrameRecord>();
  let frameIndex = 0;
  for (const { offset } of iterateSessionFrameRecords(buffer, readFrameStreamStart(buffer), { skipMetaFrames: true, strict: true })) {
    countSourceFrameScanned();
    const prefix = readFramePrefix(buffer, offset);
    if (!prefix) throw new Error(`Invalid capture frame prefix at ${offset}`);
    const record = { offset, length: prefix.length, frameIndex };
    records.push(record);
    byOffset.set(offset, record);
    frameIndex++;
  }
  return { records, byOffset };
}
export function clearSessionCaptureCache(rawFile?: string): void {
  if (rawFile === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${rawFile}\0`;
  for (const cacheKey of cache.keys()) {
    if (cacheKey.startsWith(prefix)) cache.delete(cacheKey);
  }
}
export function setCaptureFileFactoryForTest(factory: CaptureFileFactory | null): void {
  captureFileFactory = factory ?? ((path) => Bun.file(path));
}
function key(source: SessionCaptureSource): string { return `${source.rawFile}\0${source.source ?? ""}\0${source.gameId}\0${source.carId}\0${source.trackId}`; }
/**
 * Iterate capture records without materializing the compressed or decompressed
 * session. Report offsets in the decompressed stream, matching lap metadata.
 */
export async function* iterateSessionCaptureRecordsFromSource(
  source: SessionCaptureSource,
  options: { strict?: boolean } = {},
): AsyncGenerator<SessionCaptureRecord> {
  if (source.rawFile.endsWith(".motec.zip")) {
    throw new Error("Motec source archives expose canonical packets, not BIN frames");
  }

  const file = captureFileFactory(source.rawFile);
  const prefix = Buffer.from(await file.slice(0, 2).arrayBuffer());
  let stream = file.stream() as ReadableStream<Uint8Array>;
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    const decompressor = new DecompressionStream("gzip");
    // DOM stream types make BufferSource invariant although input is Uint8Array.
    const byteDecompressor = decompressor as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    stream = stream.pipeThrough(byteDecompressor);
  }

  const reader = stream.getReader();
  let pending = Buffer.alloc(0);
  let initialized = false;
  let offset = 0;
  let previous: Buffer | null = null;
  let checkpointOffset = -1;
  let checkpointIdentity: string | null = null;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending = pending.length === 0
        ? Buffer.from(next.value)
        : Buffer.concat([pending, next.value]);

      if (!initialized) {
        if (pending.length < 8) continue;
        if (pending.readUInt32LE(0) === META_FRAME_MAGIC) {
          const metaLength = pending.readUInt32LE(4);
          if (options.strict && metaLength !== 4) throw new Error("Invalid canonical capture header");
          assertCaptureRecordLength(metaLength);
          if (pending.length < 8 + metaLength) continue;
          pending = pending.subarray(8 + metaLength);
          offset = 8 + metaLength;
        }
        initialized = true;
      }

      while (pending.length >= 4) {
        const frameLength = pending.readUInt32LE(0);
        if (frameLength === META_FRAME_MAGIC) {
          if (pending.length < 8) break;
          const metaLength = pending.readUInt32LE(4);
          assertCaptureRecordLength(metaLength);
          if (pending.length < 8 + metaLength) break;
          if (metaLength === 8) {
            const magic = pending.readUInt32LE(8);
            const version = pending.readUInt32LE(12);
            if (magic === SEGMENT_BOUNDARY_MAGIC && version === SEGMENT_BOUNDARY_VERSION) {
              previous = null;
              checkpointOffset = -1;
              checkpointIdentity = null;
              yield { kind: "segment-boundary", offset, endOffset: offset + 8 + metaLength };
            }
            else if (magic === SEGMENT_CONTEXT_MAGIC && version === SEGMENT_CONTEXT_VERSION) yield { kind: "segment-context", offset, endOffset: offset + 8 + metaLength };
            else if (magic === SEGMENT_CONTEXT_END_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
              previous = null;
              checkpointOffset = -1;
              checkpointIdentity = null;
              yield { kind: "segment-context-end", offset, endOffset: offset + 8 + metaLength };
            }
            else if (options.strict) throw new Error(`Unknown capture segment marker at ${offset}`);
          }
          else {
            const bootstrap = decodeParserBootstrapPayload(pending.subarray(8, 8 + metaLength));
            if (bootstrap) {
              previous = null;
              checkpointOffset = -1;
              checkpointIdentity = null;
              yield { ...bootstrap, offset, endOffset: offset + 8 + metaLength };
            } else if (options.strict) throw new Error(`Unknown capture metadata at ${offset}`);
          }
          pending = pending.subarray(8 + metaLength);
          offset += 8 + metaLength;
          continue;
        }
        assertCaptureRecordLength(frameLength & 0x7fffffff);
        if ((frameLength & 0x80000000) !== 0 && pending.length < 12) break;
        const prefix = readFramePrefix(pending, 0);
        if (!prefix) {
          if (options.strict) throw new Error(`Invalid capture frame prefix at ${offset}`);
          break;
        }
        const payloadLength = prefix.length;
        if (pending.length < prefix.prefixBytes + payloadLength) break;
        const frameOffset = offset;
        const payload = pending.subarray(prefix.prefixBytes, prefix.prefixBytes + payloadLength);
        pending = pending.subarray(prefix.prefixBytes + payloadLength);
        offset += prefix.prefixBytes + payloadLength;
        let frame: Buffer = payload;
        const lmuDelta = isLmuSparseFrame(payload);
        const kunosDelta = isKunosSparseFrame(payload);
        const genericDelta = isGenericSparseFrame(payload);
        if (lmuDelta || kunosDelta || genericDelta) {
          const backDistance = genericDelta
            ? (payload.length >= 9 ? payload.readUInt32LE(5) : 0)
            : (payload.length >= 8 ? payload.readUInt32LE(4) : 0);
          if (!previous || checkpointOffset < 0 || backDistance <= 0 ||
              backDistance !== frameOffset - checkpointOffset) {
            throw new Error(`Invalid sparse checkpoint at ${frameOffset}`);
          }
          if (lmuDelta && checkpointIdentity !== "lmu-v2") throw new Error(`Invalid LMU sparse checkpoint identity at ${frameOffset}`);
          if (kunosDelta && (!checkpointIdentity || !checkpointIdentity.startsWith("kunos-") || Number(checkpointIdentity.slice(6)) !== kunosSourceMagic(previous))) {
            throw new Error(`Invalid Kunos sparse checkpoint identity at ${frameOffset}`);
          }
          if (genericDelta && (!checkpointIdentity || genericFrameIdentity(previous) !== checkpointIdentity)) {
            throw new Error(`Invalid generic sparse checkpoint identity at ${frameOffset}`);
          }
          frame = genericDelta ? decodeGenericSparseFrame(payload, previous)
            : lmuDelta ? decodeLmuSparseFrame(payload, previous) : decodeKunosSparseFrame(payload, previous);
          if (lmuDelta && (frame.length !== LMU_SOURCE_FRAME_V2_SIZE ||
              !frame.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC))) {
            throw new Error(`Invalid LMU sparse frame at ${frameOffset}`);
          }
          if (kunosDelta && kunosSourceMagic(frame) !== Number(checkpointIdentity!.slice(6))) {
            throw new Error(`Invalid Kunos sparse frame identity at ${frameOffset}`);
          }
        } else {
          const isLmu = payload.length === LMU_SOURCE_FRAME_V2_SIZE &&
            payload.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC);
          const magic = kunosSourceMagic(payload);
          checkpointIdentity = isLmu ? "lmu-v2" : magic ? `kunos-${magic}` : genericFrameIdentity(payload);
          checkpointOffset = checkpointIdentity ? frameOffset : -1;
        }
        previous = frame;
        if (prefix.frameTimeMs === undefined) yield { kind: "frame", offset: frameOffset, endOffset: offset, frame };
        else yield { kind: "frame", offset: frameOffset, endOffset: offset, frame, frameTimeMs: prefix.frameTimeMs };
      }
    }
    if (options.strict && (!initialized || pending.length !== 0)) throw new Error(`Truncated capture record at ${offset}`);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function* iterateSessionCaptureFrames(
  source: SessionCaptureSource,
): AsyncGenerator<{ offset: number; frame: Buffer; frameTimeMs?: number }> {
  for await (const record of iterateSessionCaptureRecordsFromSource(source)) {
    if (record.kind === "frame") yield record;
  }
}
export async function loadSessionSource(source: SessionCaptureSource): Promise<LoadedSessionSource> {
  const file = captureFileFactory(source.rawFile); const size = file.size; const mtimeMs = file.lastModified; const cacheKey = key(source);
  const hit = cache.get(cacheKey); if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.loaded;
  let loaded: LoadedSessionSource;
  const bytes = Buffer.from(await file.arrayBuffer());
  if (source.rawFile.endsWith(".motec.zip")) {
    if (source.source !== MOTEC_SESSION_SOURCE) throw new Error("Session source archive requires source 'motec'");
    const archive = decodeMotecSourceArchive(bytes); const log = parseLd(archive.ldBytes);
    const beacons = archive.ldxBytes ? parseLdxBeacons(archive.ldxBytes.toString("utf8")) : [];
    const target = resolveMotecTarget(source.gameId);
    const carTrack = target.resolveCarTrack(log, { carId: source.carId, trackId: source.trackId });
    loaded = { kind: "packets", packets: target.convert(log, beacons, carTrack).packets, offsetEncoding: archive.offsetEncoding };
  } else {
    const buffer = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipBuffer(bytes) : bytes;
    loaded = { kind: "capture", buffer, frameIndex: indexCaptureFrames(buffer) };
  }
  cache.set(cacheKey, { size, mtimeMs, loaded }); while (cache.size > MAX_ENTRIES) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
  return loaded;
}
const manifestCache = new Map<string, { size: number; mtimeMs: number; manifest: Manifest }>();
export function clearCaptureManifestCache(manifestPath?: string): void {
  if (manifestPath) manifestCache.delete(resolve(manifestPath));
  else manifestCache.clear();
}
export async function loadCaptureManifest(manifestPath: string): Promise<Manifest> {
  const absoluteManifest = resolve(manifestPath);
  const file = Bun.file(absoluteManifest);
  const size = file.size;
  const mtimeMs = file.lastModified;
  const cached = manifestCache.get(absoluteManifest);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.manifest;
  const manifest = Schema.decodeUnknownSync(ManifestSchema)(JSON.parse(await file.text()));
  manifestCache.set(absoluteManifest, { size, mtimeMs, manifest });
  return manifest;
}
export async function resolveLapCaptureArtifact(manifestPath: string, chunkId: string, expectedLapId?: number): Promise<{ path: string; manifest: Manifest; chunk: Chunk }> {
  const absoluteManifest = resolve(manifestPath);
  const manifest = await loadCaptureManifest(absoluteManifest);
  const chunk = manifest.chunks.find((candidate) => candidate.id === chunkId && candidate.kind === "lap");
  if (!chunk) throw new Error(`Capture manifest ${absoluteManifest} has no lap chunk ${chunkId}`);
  if (expectedLapId != null && chunk.lapId !== String(expectedLapId)) {
    throw new Error(`Capture chunk ${chunkId} lap ID mismatch: expected ${expectedLapId}, got ${chunk.lapId}`);
  }
  if (!chunk.lapId || chunk.ownedFrameByteOffset == null || chunk.ownedFrameCount == null) {
    throw new Error(`Capture manifest lap chunk ${chunkId} is missing owned frame window`);
  }
  if (isAbsolute(chunk.path)) throw new Error(`Capture chunk path must be relative: ${chunk.path}`);
  const path = resolve(dirname(absoluteManifest), chunk.path);
  const rel = relative(dirname(absoluteManifest), path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Capture chunk path escapes manifest directory: ${chunk.path}`);
  }
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`Capture chunk ${chunkId} is missing: ${path}`);
  const [realManifestDir, realChunkPath] = await Promise.all([realpath(dirname(absoluteManifest)), realpath(path)]);
  const realRelative = relative(realManifestDir, realChunkPath);
  if (realRelative === ".." || realRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(realRelative)) {
    throw new Error(`Capture chunk path escapes manifest directory: ${chunk.path}`);
  }
  if (file.size !== chunk.byteLength) throw new Error(`Capture chunk ${chunkId} size mismatch: expected ${chunk.byteLength}, got ${file.size}`);
  return { path, manifest, chunk };
}
export async function loadSessionCapture(source: SessionCaptureSource): Promise<Buffer> {
  const loaded = await loadSessionSource(source); if (loaded.kind === "packets") throw new Error("Session source contains canonical packets, not BIN frames"); return loaded.buffer;
}
