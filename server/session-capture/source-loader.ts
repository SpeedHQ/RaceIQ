import { gunzipBuffer } from "./framing";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { MOTEC_SESSION_SOURCE } from "@shared/integrations/motec";
import { decodeMotecSourceArchive, type MotecOffsetEncoding } from "../motec/source-archive";
import { parseLd } from "../motec/ld";
import { parseLdxBeacons } from "../motec/ldx";
import { resolveMotecTarget } from "../motec/targets";
import { estimateTelemetryPacketsBytes } from "../telemetry/memory-estimate";

export interface SessionCaptureSource { rawFile: string; source: string | null; gameId: GameId; carOrdinal: number; trackOrdinal: number; }
export type LoadedSessionSource =
  | { kind: "capture"; buffer: Buffer }
  | { kind: "packets"; packets: TelemetryPacket[]; offsetEncoding: MotecOffsetEncoding };
interface CacheEntry { sourceSize: number; mtimeMs: number; bytes: number; loaded: LoadedSessionSource }

const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LoadedSessionSource>>();
let cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;
let cacheBytesUsed = 0;

function key(source: SessionCaptureSource): string {
  return `${source.rawFile}\0${source.source ?? ""}\0${source.gameId}\0${source.carOrdinal}\0${source.trackOrdinal}`;
}

function loadedBytes(loaded: LoadedSessionSource): number {
  return loaded.kind === "capture" ? loaded.buffer.byteLength : estimateTelemetryPacketsBytes(loaded.packets);
}

function touch(cacheKey: string, entry: CacheEntry): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
}

function evictUntilWithinBudget(): void {
  while (cacheBytesUsed > cacheMaxBytes && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    if (!oldest) break;
    cacheBytesUsed -= oldest.bytes;
    cache.delete(oldestKey);
  }
}

export function clearRawFileCacheForTest(): void {
  cache.clear();
  inFlight.clear();
  cacheBytesUsed = 0;
}

/**
 * Stream decompressed capture records without materializing the capture.
 * Offsets are decompressed-stream byte offsets, matching lap metadata.
 */
export async function* iterateSessionCaptureFrames(
  source: SessionCaptureSource,
): AsyncGenerator<{ offset: number; frame: Buffer }> {
  if (source.rawFile.endsWith(".motec.zip")) {
    throw new Error("Motec source archives expose canonical packets, not BIN frames");
  }
  const file = Bun.file(source.rawFile);
  const prefix = Buffer.from(await file.slice(0, 2).arrayBuffer());
  let stream: ReadableStream<Uint8Array> = file.stream() as ReadableStream<Uint8Array>;
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
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
        if (pending.readUInt32LE(0) === 0xffffffff) {
          const metaLength = pending.readUInt32LE(4);
          if (pending.length < 8 + metaLength) continue;
          pending = pending.subarray(8 + metaLength);
          offset = 8 + metaLength;
        }
        initialized = true;
      }

      while (pending.length >= 4) {
        const frameLength = pending.readUInt32LE(0);
        if (frameLength <= 0 || pending.length < 4 + frameLength) break;
        const frameOffset = offset;
        const frame = Buffer.from(pending.subarray(4, 4 + frameLength));
        pending = pending.subarray(4 + frameLength);
        offset += 4 + frameLength;
        yield { offset: frameOffset, frame };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const _sourceLoaderCacheForTest = {
  clear: clearRawFileCacheForTest,
  bytesUsed: () => cacheBytesUsed,
  entries: () => cache.size,
  inFlight: () => inFlight.size,
  maxBytes: () => cacheMaxBytes,
  setMaxBytes: (bytes: number) => {
    cacheMaxBytes = Math.max(0, Math.floor(bytes));
    evictUntilWithinBudget();
  },
  resetMaxBytes: () => {
    cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;
    evictUntilWithinBudget();
  },
};

async function loadUncached(source: SessionCaptureSource): Promise<LoadedSessionSource> {
  const file = Bun.file(source.rawFile);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (source.rawFile.endsWith(".motec.zip")) {
    if (source.source !== MOTEC_SESSION_SOURCE) throw new Error("Session source archive requires source 'motec'");
    const archive = decodeMotecSourceArchive(bytes);
    const log = parseLd(archive.ldBytes);
    const beacons = archive.ldxBytes ? parseLdxBeacons(archive.ldxBytes.toString("utf8")) : [];
    const target = resolveMotecTarget(source.gameId);
    const carTrack = target.resolveCarTrack(log, { carOrdinal: source.carOrdinal, trackOrdinal: source.trackOrdinal });
    return { kind: "packets", packets: target.convert(log, beacons, carTrack).packets, offsetEncoding: archive.offsetEncoding };
  }
  return { kind: "capture", buffer: bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipBuffer(bytes) : bytes };
}

export async function loadSessionSource(source: SessionCaptureSource): Promise<LoadedSessionSource> {
  const cacheKey = key(source);
  const file = Bun.file(source.rawFile);
  const sourceSize = file.size;
  const mtimeMs = file.lastModified;
  const hit = cache.get(cacheKey);
  if (hit && hit.sourceSize === sourceSize && hit.mtimeMs === mtimeMs) {
    touch(cacheKey, hit);
    return hit.loaded;
  }
  if (hit) {
    cacheBytesUsed -= hit.bytes;
    cache.delete(cacheKey);
  }

  const existingLoad = inFlight.get(cacheKey);
  if (existingLoad) return existingLoad;
  const load = (async () => {
    const loaded = await loadUncached(source);
    const bytes = loadedBytes(loaded);
    if (bytes <= cacheMaxBytes) {
      cache.set(cacheKey, { sourceSize, mtimeMs, bytes, loaded });
      cacheBytesUsed += bytes;
      evictUntilWithinBudget();
    }
    return loaded;
  })();
  inFlight.set(cacheKey, load);
  try {
    return await load;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function loadSessionCapture(source: SessionCaptureSource): Promise<Buffer> {
  const loaded = await loadSessionSource(source);
  if (loaded.kind === "packets") throw new Error("Session source contains canonical packets, not BIN frames");
  return loaded.buffer;
}
