import { gzip, gzipSync, gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { ACC_BROADCAST_CAPTURE_MAGIC, ACC_BROADCAST_CAPTURE_VERSION, decodeAccBroadcastCaptureRecord } from "../games/acc/broadcast-capture";
import { MAX_DECOMPRESSED_CAPTURE_BYTES } from "../archive/bounded-unzip";

export const META_FRAME_MAGIC = 0xffffffff;
const META_FRAME_PAYLOAD_BYTES = 4;
export const META_FRAME_BYTES = 8 + META_FRAME_PAYLOAD_BYTES;
export const SEGMENT_BOUNDARY_MAGIC = 0x4d474553;
export const SEGMENT_BOUNDARY_VERSION = 1;
export const SEGMENT_CONTEXT_MAGIC = 0x58544753;
export const SEGMENT_CONTEXT_VERSION = 1;
export const SEGMENT_CONTEXT_END_MAGIC = 0x454e4353;
export const SESSION_SEGMENT_BOUNDARY = Symbol("session-segment-boundary");
export const SESSION_SEGMENT_CONTEXT = Symbol("session-segment-context");
export const SESSION_SEGMENT_CONTEXT_END = Symbol("session-segment-context-end");
export type SessionCaptureRecord =
  | { kind: "frame"; offset: number; prefixOffset: number; frame: Buffer }
  | { kind: "segment-boundary"; offset: number }
  | { kind: "segment-context"; offset: number }
  | { kind: "segment-context-end"; offset: number }
  | { kind: "metadata"; offset: number; bytes: Buffer }
  | { kind: "acc-broadcast"; offset: number; batch: import("../games/acc/broadcast-capture").AccBroadcastCaptureBatch }
  | { kind: "acc-broadcast-malformed"; offset: number; reason: string };

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

export function encodeMetaFrame(totalFrames = 0): Buffer {
  const header = Buffer.allocUnsafe(META_FRAME_BYTES);
  header.writeUInt32LE(META_FRAME_MAGIC, 0);
  header.writeUInt32LE(META_FRAME_PAYLOAD_BYTES, 4);
  header.writeUInt32LE(totalFrames, 8);
  return header;
}
export function encodeSegmentBoundaryFrame(): Buffer {
  const frame = Buffer.alloc(16);
  frame.writeUInt32LE(META_FRAME_MAGIC, 0);
  frame.writeUInt32LE(8, 4);
  frame.writeUInt32LE(SEGMENT_BOUNDARY_MAGIC, 8);
  frame.writeUInt32LE(SEGMENT_BOUNDARY_VERSION, 12);
  return frame;
}
export function encodeSegmentContextFrame(): Buffer {
  const frame = Buffer.alloc(16);
  frame.writeUInt32LE(META_FRAME_MAGIC, 0);
  frame.writeUInt32LE(8, 4);
  frame.writeUInt32LE(SEGMENT_CONTEXT_MAGIC, 8);
  frame.writeUInt32LE(SEGMENT_CONTEXT_VERSION, 12);
  return frame;
}
export function encodeSegmentContextEndFrame(): Buffer {
  const frame = Buffer.alloc(16);
  frame.writeUInt32LE(META_FRAME_MAGIC, 0);
  frame.writeUInt32LE(8, 4);
  frame.writeUInt32LE(SEGMENT_CONTEXT_END_MAGIC, 8);
  frame.writeUInt32LE(SEGMENT_CONTEXT_VERSION, 12);
  return frame;
}
export function encodeFrameLength(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32LE(length, 0); return prefix;
}
export function readFrameStreamStart(bytes: Uint8Array): number {
  if (bytes.length < 8) return 0;
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.readUInt32LE(0) === META_FRAME_MAGIC ? 8 + view.readUInt32LE(4) : 0;
}
function readRecorderFrameStreamStart(bytes: Buffer): number {
  return bytes.length >= META_FRAME_BYTES && bytes.readUInt32LE(0) === META_FRAME_MAGIC && bytes.readUInt32LE(4) === META_FRAME_PAYLOAD_BYTES ? META_FRAME_BYTES : 0;
}
interface SessionFrameRecord { offset: number; prefixOffset: number; frame: Buffer; }
interface SessionFrameIterationOptions { skipMetaFrames?: boolean; allowEmptyFrames?: boolean; }

export function* iterateSessionCaptureRecords(bytes: Buffer, offset = readRecorderFrameStreamStart(bytes)): Generator<SessionCaptureRecord> {
  let prefixOffset: number | undefined;
  while (offset + 4 <= bytes.length) {
    const recordOffset = offset;
    const length = bytes.readUInt32LE(offset);
    if (length === META_FRAME_MAGIC) {
      if (offset + 8 > bytes.length) break;
      const payloadBytes = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + payloadBytes > bytes.length) break;
      const payload = bytes.subarray(offset + 8, offset + 8 + payloadBytes);
      const magic = payloadBytes >= 4 ? payload.readUInt32LE(0) : null;
      const version = payloadBytes >= 8 ? payload.readUInt32LE(4) : null;
      if (magic === ACC_BROADCAST_CAPTURE_MAGIC && (version === ACC_BROADCAST_CAPTURE_VERSION || version === null)) {
        prefixOffset ??= recordOffset;
        try {
          yield { kind: "acc-broadcast", offset: recordOffset, batch: decodeAccBroadcastCaptureRecord(payload) };
        } catch (error) {
          yield { kind: "acc-broadcast-malformed", offset: recordOffset, reason: error instanceof Error ? error.message : "invalid ACCB record" };
        }
      } else if (payloadBytes === 8 && magic === SEGMENT_BOUNDARY_MAGIC && version === SEGMENT_BOUNDARY_VERSION) {
        prefixOffset = undefined;
        yield { kind: "segment-boundary", offset: recordOffset };
      } else if (payloadBytes === 8 && magic === SEGMENT_CONTEXT_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
        prefixOffset = undefined;
        yield { kind: "segment-context", offset: recordOffset };
      } else if (payloadBytes === 8 && magic === SEGMENT_CONTEXT_END_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
        prefixOffset = undefined;
        yield { kind: "segment-context-end", offset: recordOffset };
      } else {
        prefixOffset ??= recordOffset;
        yield { kind: "metadata", offset: recordOffset, bytes: bytes.subarray(offset, offset + 8 + payloadBytes) };
      }
      offset += 8 + payloadBytes;
      continue;
    }
    offset += 4;
    if (length === 0 || offset + length > bytes.length) break;
    yield { kind: "frame", offset: recordOffset, prefixOffset: prefixOffset ?? recordOffset, frame: bytes.subarray(offset, offset + length) };
    prefixOffset = undefined;
    offset += length;
  }
}
export type SessionImportFrame = Buffer | typeof SESSION_SEGMENT_BOUNDARY | typeof SESSION_SEGMENT_CONTEXT | typeof SESSION_SEGMENT_CONTEXT_END | { kind: "metadata"; bytes: Buffer };
export function* iterateSessionImportFrames(bytes: Buffer): Generator<SessionImportFrame> {
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "segment-boundary") yield SESSION_SEGMENT_BOUNDARY;
    else if (record.kind === "segment-context") yield SESSION_SEGMENT_CONTEXT;
    else if (record.kind === "segment-context-end") yield SESSION_SEGMENT_CONTEXT_END;
    else if (record.kind === "frame") yield record.frame;
    else yield { kind: "metadata", bytes: bytes.subarray(record.offset, record.offset + 8 + bytes.readUInt32LE(record.offset + 4)) };
  }
}
export function* iterateSessionFrameRecords(bytes: Buffer, offset = readRecorderFrameStreamStart(bytes), _options?: SessionFrameIterationOptions): Generator<SessionFrameRecord> {
  for (const record of iterateSessionCaptureRecords(bytes, offset)) if (record.kind === "frame") yield record;
}
export function* iterateSessionFrames(bytes: Buffer, offset = readRecorderFrameStreamStart(bytes)): Generator<Buffer> {
  for (const record of iterateSessionCaptureRecords(bytes, offset)) if (record.kind === "frame") yield record.frame;
}
export function sessionFrameAt(bytes: Buffer, offset: number): Buffer | null {
  if (offset < 0) return null;
  for (const record of iterateSessionFrameRecords(bytes, offset)) return record.frame;
  return null;
}
export function advanceSessionFrames(bytes: Buffer, offset: number, count: number): number {
  let at = offset;
  if (count <= 0 || offset < 0) return at;
  for (const record of iterateSessionFrameRecords(bytes, offset)) {
    at = record.offset + 4 + record.frame.length;
    if (--count === 0) break;
  }
  return at;
}
export function isGzip(bytes: Uint8Array): boolean { return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }
export function gzipBufferSync(bytes: Buffer): Buffer { return gzipSync(bytes); }
export async function gzipBuffer(bytes: Buffer): Promise<Buffer> { return gzipAsync(bytes); }
export function gunzipBufferSync(
  bytes: Buffer,
  maxOutputLength = MAX_DECOMPRESSED_CAPTURE_BYTES,
): Buffer {
  return gunzipSync(bytes, { maxOutputLength });
}
export async function gunzipBuffer(
  bytes: Buffer,
  maxOutputLength = MAX_DECOMPRESSED_CAPTURE_BYTES,
): Promise<Buffer> {
  return gunzipAsync(bytes, { maxOutputLength });
}
export function decompressIfGzipSync(
  bytes: Buffer,
  maxOutputLength = MAX_DECOMPRESSED_CAPTURE_BYTES,
): Buffer {
  return isGzip(bytes) ? gunzipBufferSync(bytes, maxOutputLength) : bytes;
}
