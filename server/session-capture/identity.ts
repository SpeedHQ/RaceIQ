import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createGunzip, gunzipSync } from "node:zlib";
import { isGzip } from "./framing";

/** Persisted captures retain the historical iRacing admission ceiling. */
export const MAX_RAW_CAPTURE_STORED_BYTES = 8 * 1024 * 1024 * 1024;
/** Gzip input may not inflate beyond this safe streaming processing ceiling. */
export const MAX_RAW_CAPTURE_EXPANDED_BYTES = 512 * 1024 * 1024;
/** APIs accepting an in-memory capture must reject before allocating above this ceiling. */
export const MAX_RAW_CAPTURE_BUFFERED_BYTES = 512 * 1024 * 1024;

export interface RawCaptureIdentity {
  bytes: Buffer;
  contentHash: string;
  storageEncoding: "identity" | "gzip";
}

export interface RawCaptureIdentitySummary {
  contentHash: string;
  byteSize: number;
  storageEncoding: "identity" | "gzip";
}

export function rawCaptureObjectId(sessionId: number): string {
  return `session:${sessionId}:raw-capture`;
}

export function sha256ContentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256SourceArtifacts(artifacts: readonly { name: string; bytes: Uint8Array }[]): string {
  const hash = createHash("sha256");
  const lengths = Buffer.allocUnsafe(12);
  for (const artifact of artifacts) {
    const name = Buffer.from(artifact.name);
    lengths.writeUInt32LE(name.length, 0);
    lengths.writeBigUInt64LE(BigInt(artifact.bytes.byteLength), 4);
    hash.update(lengths);
    hash.update(name);
    hash.update(artifact.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function rawCaptureStream(path: string): Promise<{
  stream: AsyncIterable<Buffer>;
  storageEncoding: "identity" | "gzip";
  decodedByteLimit: number;
} | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  if (file.size > MAX_RAW_CAPTURE_STORED_BYTES) {
    throw new Error(`Raw capture exceeds ${MAX_RAW_CAPTURE_STORED_BYTES} byte stored limit`);
  }
  const header = Buffer.from(await file.slice(0, 2).arrayBuffer());
  const storageEncoding = isGzip(header) ? "gzip" : "identity";
  const source = createReadStream(path);
  return {
    stream: storageEncoding === "gzip" ? source.pipe(createGunzip()) : source,
    storageEncoding,
    decodedByteLimit: storageEncoding === "gzip" ? MAX_RAW_CAPTURE_EXPANDED_BYTES : MAX_RAW_CAPTURE_STORED_BYTES,
  };
}

/**
 * Yield decoded source bytes without materializing source capture. Every caller
 * receives a hard decoded-byte ceiling, including gzip inputs.
 */
export async function* iterateRawCaptureBytes(path: string): AsyncGenerator<Buffer> {
  const opened = await rawCaptureStream(path);
  if (!opened) return;
  let expandedBytes = 0;
  try {
    for await (const chunk of opened.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      expandedBytes += bytes.byteLength;
      if (expandedBytes > opened.decodedByteLimit) {
        throw new Error(`Raw capture exceeds ${opened.decodedByteLimit} byte decoded limit`);
      }
      yield bytes;
    }
  } finally {
    (opened.stream as { destroy?: () => void }).destroy?.();
  }
}

/** Hash decoded source bytes without retaining a duplicate capture buffer. */
export async function inspectRawCaptureIdentity(path: string): Promise<RawCaptureIdentitySummary | undefined> {
  const opened = await rawCaptureStream(path);
  if (!opened) return undefined;
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    for await (const chunk of opened.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > opened.decodedByteLimit) {
        throw new Error(`Raw capture exceeds ${opened.decodedByteLimit} byte decoded limit`);
      }
      hash.update(bytes);
    }
  } finally {
    (opened.stream as { destroy?: () => void }).destroy?.();
  }
  return {
    contentHash: `sha256:${hash.digest("hex")}`,
    byteSize,
    storageEncoding: opened.storageEncoding,
  };
}

/**
 * Compatibility loader for callers that require bytes. New admission and
 * archive paths must use inspectRawCaptureIdentity/iterateRawCaptureBytes.
 */
export async function loadRawCaptureIdentity(path: string): Promise<RawCaptureIdentity | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  if (file.size > MAX_RAW_CAPTURE_BUFFERED_BYTES) {
    throw new Error(`Raw capture exceeds ${MAX_RAW_CAPTURE_BUFFERED_BYTES} byte buffered limit`);
  }
  const stored = Buffer.from(await file.arrayBuffer());
  const storageEncoding = isGzip(stored) ? "gzip" : "identity";
  const bytes = storageEncoding === "gzip"
    ? gunzipSync(stored, { maxOutputLength: MAX_RAW_CAPTURE_EXPANDED_BYTES })
    : stored;
  if (bytes.byteLength > MAX_RAW_CAPTURE_BUFFERED_BYTES) {
    throw new Error(`Raw capture exceeds ${MAX_RAW_CAPTURE_BUFFERED_BYTES} byte buffered limit`);
  }
  return {
    bytes,
    contentHash: sha256ContentHash(bytes),
    storageEncoding,
  };
}
