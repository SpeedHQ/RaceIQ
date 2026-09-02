import { gunzipBuffer, META_FRAME_MAGIC } from "./framing";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { MOTEC_SESSION_SOURCE } from "@shared/integrations/motec";
import { decodeMotecSourceArchive, type MotecOffsetEncoding } from "../motec/source-archive";
import { parseLd } from "../motec/ld";
import { parseLdxBeacons } from "../motec/ldx";
import { resolveMotecTarget } from "../motec/targets";

export interface SessionCaptureSource { rawFile: string; source: string | null; gameId: GameId; carOrdinal: number; trackOrdinal: number; }
export type LoadedSessionSource =
  | { kind: "capture"; buffer: Buffer }
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
export function clearRawFileCacheForTest(): void { cache.clear(); }
export function setCaptureFileFactoryForTest(factory: CaptureFileFactory | null): void {
  captureFileFactory = factory ?? ((path) => Bun.file(path));
}
function key(source: SessionCaptureSource): string { return `${source.rawFile}\0${source.source ?? ""}\0${source.gameId}\0${source.carOrdinal}\0${source.trackOrdinal}`; }

/**
 * Iterate capture frames without materializing the compressed or decompressed
 * session. Report offsets in the decompressed stream, matching lap metadata.
 */
export async function* iterateSessionCaptureFrames(
  source: SessionCaptureSource,
): AsyncGenerator<{ offset: number; frame: Buffer }> {
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
          assertCaptureRecordLength(metaLength);
          if (pending.length < 8 + metaLength) continue;
          pending = pending.subarray(8 + metaLength);
          offset = 8 + metaLength;
        }
        initialized = true;
      }

      while (pending.length >= 4) {
        const frameLength = pending.readUInt32LE(0);
        assertCaptureRecordLength(frameLength);
        if (frameLength <= 0 || pending.length < 4 + frameLength) break;
        const frameOffset = offset;
        const frame = pending.subarray(4, 4 + frameLength);
        pending = pending.subarray(4 + frameLength);
        offset += 4 + frameLength;
        yield { offset: frameOffset, frame };
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
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
    const carTrack = target.resolveCarTrack(log, { carOrdinal: source.carOrdinal, trackOrdinal: source.trackOrdinal });
    loaded = { kind: "packets", packets: target.convert(log, beacons, carTrack).packets, offsetEncoding: archive.offsetEncoding };
  } else loaded = { kind: "capture", buffer: bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipBuffer(bytes) : bytes };
  cache.set(cacheKey, { size, mtimeMs, loaded }); while (cache.size > MAX_ENTRIES) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
  return loaded;
}
export async function loadSessionCapture(source: SessionCaptureSource): Promise<Buffer> {
  const loaded = await loadSessionSource(source); if (loaded.kind === "packets") throw new Error("Session source contains canonical packets, not BIN frames"); return loaded.buffer;
}
