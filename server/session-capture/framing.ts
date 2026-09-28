import { decodeLmuSparseFrame, isLmuSparseFrame } from "./lmu-sparse";
import { decodeGenericSparseFrame, genericFrameIdentity, isGenericSparseFrame } from "./generic-sparse";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "../games/lmu/source-frame";
import { decodeKunosSparseFrame, isKunosSparseFrame, kunosSourceMagic } from "./kunos-sparse";
import { gzip, gzipSync, gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { ACC_BROADCAST_CAPTURE_MAGIC, ACC_BROADCAST_CAPTURE_VERSION, decodeAccBroadcastCaptureRecord } from "../games/acc/broadcast-capture";
import { MAX_DECOMPRESSED_CAPTURE_BYTES } from "../archive/bounded-unzip";

function isLmuSourceFrame(frame: Buffer): boolean {
  return frame.length === LMU_SOURCE_FRAME_V2_SIZE && frame.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC);
}
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
  | { kind: "frame"; offset: number; prefixOffset: number; frame: Buffer; frameTimeMs?: number }
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
const TIMESTAMPED_LENGTH_FLAG = 0x80000000;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;
const MAX_SAFE_FRAME_TIME_MS = BigInt(Number.MAX_SAFE_INTEGER);
export interface FramePrefix { length: number; prefixBytes: number; frameTimeMs?: number }
export function encodeFrameLength(length: number, frameTimeMs?: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_LENGTH) throw new RangeError("Invalid capture frame length");
  if (frameTimeMs === undefined) {
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32LE(length, 0);
    return prefix;
  }
  if (!Number.isSafeInteger(frameTimeMs) || frameTimeMs < 0) throw new RangeError("Invalid frameTimeMs");
  const prefix = Buffer.allocUnsafe(12);
  prefix.writeUInt32LE((length | TIMESTAMPED_LENGTH_FLAG) >>> 0, 0);
  prefix.writeBigUInt64LE(BigInt(frameTimeMs), 4);
  return prefix;
}
export function readFramePrefix(bytes: Buffer, offset: number): FramePrefix | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const storedLength = bytes.readUInt32LE(offset);
  if (storedLength === META_FRAME_MAGIC) return null;
  const timestamped = (storedLength & TIMESTAMPED_LENGTH_FLAG) !== 0;
  const length = timestamped ? storedLength & ~TIMESTAMPED_LENGTH_FLAG : storedLength;
  const prefixBytes = timestamped ? 12 : 4;
  if (length > MAX_FRAME_LENGTH || offset + prefixBytes > bytes.length) return null;
  if (!timestamped) return { length, prefixBytes };
  const frameTimeMs = bytes.readBigUInt64LE(offset + 4);
  if (frameTimeMs > MAX_SAFE_FRAME_TIME_MS) return null;
  return { length, prefixBytes, frameTimeMs: Number(frameTimeMs) };
}
export function readFrameStreamStart(bytes: Uint8Array): number {
  if (bytes.length < 8) return 0;
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.readUInt32LE(0) === META_FRAME_MAGIC ? 8 + view.readUInt32LE(4) : 0;
}
function readRecorderFrameStreamStart(bytes: Buffer): number {
  return bytes.length >= META_FRAME_BYTES && bytes.readUInt32LE(0) === META_FRAME_MAGIC && bytes.readUInt32LE(4) === META_FRAME_PAYLOAD_BYTES ? META_FRAME_BYTES : 0;
}
interface SessionFrameRecord { offset: number; prefixOffset: number; frame: Buffer; frameTimeMs?: number }
interface SessionFrameIterationOptions { skipMetaFrames?: boolean; allowEmptyFrames?: boolean; }

export function* iterateSessionCaptureRecords(bytes: Buffer, requestedOffset = readRecorderFrameStreamStart(bytes)): Generator<SessionCaptureRecord> {
  let offset = readRecorderFrameStreamStart(bytes);
  if (requestedOffset > offset && requestedOffset + 4 <= bytes.length) {
    const requestedPrefix = readFramePrefix(bytes, requestedOffset);
    const length = requestedPrefix?.length ?? 0;
    const payloadOffset = requestedOffset + (requestedPrefix?.prefixBytes ?? 4);
    const payload = requestedPrefix && payloadOffset + length <= bytes.length
      ? bytes.subarray(payloadOffset, payloadOffset + length) : Buffer.alloc(0);
    if (length > 0 && (isLmuSparseFrame(payload) || isKunosSparseFrame(payload) || isGenericSparseFrame(payload))) {
      const backDistance = isGenericSparseFrame(payload) ? payload.readUInt32LE(5) : payload.readUInt32LE(4);
      if (backDistance === 0 || backDistance > requestedOffset - offset) throw new Error("Invalid sparse checkpoint distance");
      offset = requestedOffset - backDistance;
      const checkpointPrefix = readFramePrefix(bytes, offset);
      if (!checkpointPrefix || checkpointPrefix.length === 0 || offset + checkpointPrefix.prefixBytes + checkpointPrefix.length > requestedOffset) throw new Error("Invalid sparse checkpoint distance");
      const checkpointPayload = bytes.subarray(offset + checkpointPrefix.prefixBytes, offset + checkpointPrefix.prefixBytes + checkpointPrefix.length);
      if ((isLmuSparseFrame(payload) && !isLmuSourceFrame(checkpointPayload)) ||
          (isKunosSparseFrame(payload) && !kunosSourceMagic(checkpointPayload)) ||
          (isGenericSparseFrame(payload) && !genericFrameIdentity(checkpointPayload))) {
        throw new Error("Invalid sparse checkpoint distance");
      }
    }
    else offset = requestedOffset;
  }
  let pendingPrefixOffset: number | undefined;
  let checkpointOffset = -1;
  let previous: Buffer | null = null;
  let checkpointIdentity: string | null = null;
  while (offset + 4 <= bytes.length) {
    const recordOffset = offset;
    const isMeta = bytes.readUInt32LE(offset) === META_FRAME_MAGIC;
    const prefix = isMeta ? null : readFramePrefix(bytes, offset);
    if (!isMeta && !prefix) break;
    const length = isMeta ? META_FRAME_MAGIC : prefix!.length;
    if (isMeta) {
      if (offset + 8 > bytes.length) break;
      const payloadBytes = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + payloadBytes > bytes.length) break;
      const payload = bytes.subarray(offset + 8, offset + 8 + payloadBytes);
      const magic = payloadBytes >= 4 ? payload.readUInt32LE(0) : null;
      const version = payloadBytes >= 8 ? payload.readUInt32LE(4) : null;
      if (magic === ACC_BROADCAST_CAPTURE_MAGIC && (version === ACC_BROADCAST_CAPTURE_VERSION || version === null)) {
        pendingPrefixOffset ??= recordOffset;
        try {
          yield { kind: "acc-broadcast", offset: recordOffset, batch: decodeAccBroadcastCaptureRecord(payload) };
        } catch (error) {
          yield { kind: "acc-broadcast-malformed", offset: recordOffset, reason: error instanceof Error ? error.message : "invalid ACCB record" };
        }
      } else if (payloadBytes === 8 && magic === SEGMENT_BOUNDARY_MAGIC && version === SEGMENT_BOUNDARY_VERSION) {
        pendingPrefixOffset = undefined;
        previous = null;
        checkpointOffset = -1;
        checkpointIdentity = null;
        if (recordOffset >= requestedOffset) yield { kind: "segment-boundary", offset: recordOffset };
      } else if (payloadBytes === 8 && magic === SEGMENT_CONTEXT_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
        pendingPrefixOffset = undefined;
        if (recordOffset >= requestedOffset) yield { kind: "segment-context", offset: recordOffset };
      } else if (payloadBytes === 8 && magic === SEGMENT_CONTEXT_END_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
        pendingPrefixOffset = undefined;
        previous = null;
        checkpointOffset = -1;
        checkpointIdentity = null;
        if (recordOffset >= requestedOffset) yield { kind: "segment-context-end", offset: recordOffset };
      } else {
        pendingPrefixOffset ??= recordOffset;
        if (recordOffset >= requestedOffset) yield { kind: "metadata", offset: recordOffset, bytes: bytes.subarray(offset, offset + 8 + payloadBytes) };
      }
      offset += 8 + payloadBytes;
      continue;
    }
    const frameTimeMs = prefix?.frameTimeMs;
    const payloadOffset = offset + prefix!.prefixBytes;
    if (length === 0 || payloadOffset + length > bytes.length) break;
    const payload = bytes.subarray(payloadOffset, payloadOffset + length);
    let frame = payload;
    const lmuDelta = isLmuSparseFrame(payload);
    const kunosDelta = isKunosSparseFrame(payload);
    const genericDelta = isGenericSparseFrame(payload);
    if (lmuDelta || kunosDelta || genericDelta) {
      if (!previous || checkpointOffset < 0) throw new Error(`Sparse frame at ${recordOffset} has no checkpoint`);
      const backDistance = genericDelta
        ? (payload.length >= 9 ? payload.readUInt32LE(5) : 0)
        : (payload.length >= 8 ? payload.readUInt32LE(4) : 0);
      if (backDistance <= 0 || recordOffset - backDistance !== checkpointOffset) throw new Error(`Invalid sparse checkpoint distance at ${recordOffset}`);
      if (lmuDelta && checkpointIdentity !== "lmu-v2") throw new Error(`Invalid LMU sparse checkpoint identity at ${recordOffset}`);
      if (kunosDelta && (!checkpointIdentity || !checkpointIdentity.startsWith("kunos-") || Number(checkpointIdentity.slice(6)) !== kunosSourceMagic(previous))) {
        throw new Error(`Invalid Kunos sparse checkpoint identity at ${recordOffset}`);
      }
      if (genericDelta && (!checkpointIdentity || genericFrameIdentity(previous) !== checkpointIdentity)) {
        throw new Error(`Invalid generic sparse checkpoint identity at ${recordOffset}`);
      }
      frame = genericDelta ? decodeGenericSparseFrame(payload, previous)
        : lmuDelta ? decodeLmuSparseFrame(payload, previous) : decodeKunosSparseFrame(payload, previous);
      if (lmuDelta && !isLmuSourceFrame(frame)) throw new Error(`Invalid LMU sparse frame at ${recordOffset}`);
      if (kunosDelta && kunosSourceMagic(frame) !== Number(checkpointIdentity!.slice(6))) {
        throw new Error(`Invalid Kunos sparse frame identity at ${recordOffset}`);
      }
    } else {
      const magic = kunosSourceMagic(payload);
      checkpointIdentity = isLmuSourceFrame(payload) ? "lmu-v2" : magic ? `kunos-${magic}` : genericFrameIdentity(payload);
      checkpointOffset = checkpointIdentity ? recordOffset : -1;
    }
    previous = frame;
    if (recordOffset >= requestedOffset) {
      yield {
        kind: "frame", offset: recordOffset,
        prefixOffset: pendingPrefixOffset ?? recordOffset,
        frame, ...(frameTimeMs === undefined ? {} : { frameTimeMs }),
      };
    }
    pendingPrefixOffset = undefined;
    offset = payloadOffset + length;
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
  if (offset < 0 || offset + 4 > bytes.length) return null;
  for (const record of iterateSessionCaptureRecords(bytes, offset)) {
    if (record.kind !== "frame") continue;
    if (record.offset === offset || record.prefixOffset === offset) return record.frame;
    if (record.prefixOffset > offset) break;
  }
  return null;
}
export function advanceSessionFrames(bytes: Buffer, offset: number, count: number): number {
  let at = offset;
  if (count <= 0 || offset < 0) return at;
  for (const record of iterateSessionCaptureRecords(bytes, offset)) {
    if (record.kind === "segment-boundary") break;
    if (record.kind !== "frame") continue;
    const prefix = readFramePrefix(bytes, record.offset);
    if (!prefix) break;
    at = record.offset + prefix.prefixBytes + prefix.length;
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
