import { decodeLmuSparseFrame, isLmuSparseFrame } from "./lmu-sparse";
import { decodeGenericSparseFrame, genericFrameIdentity, isGenericSparseFrame } from "./generic-sparse";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { decodeKunosSparseFrame, isKunosSparseFrame, kunosSourceMagic } from "./kunos-sparse";
import { gzip, gzipSync, gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { MAX_DECOMPRESSED_CAPTURE_BYTES } from "./limits";

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
export const PARSER_BOOTSTRAP_MAGIC = 0x54425043;
export const PARSER_BOOTSTRAP_VERSION = 1;
export type ParserBootstrapGameId = "acc" | "ac-evo" | "f1-2025" | "fm-2023" | "iracing" | "lmu";
const CAPTURE_GAME_IDS = ["acc", "ac-evo", "f1-2025", "fm-2023", "iracing", "lmu"] as const;
export const SESSION_SEGMENT_BOUNDARY = Symbol("session-segment-boundary");
export const SESSION_SEGMENT_CONTEXT = Symbol("session-segment-context");
export const SESSION_SEGMENT_CONTEXT_END = Symbol("session-segment-context-end");
export type ParserBootstrapRecord = {
  kind: "parser-bootstrap";
  offset: number;
  gameId: ParserBootstrapGameId;
  formatVersion: number;
  payload: Buffer;
};
export type ParserBootstrapPayload = Omit<ParserBootstrapRecord, "offset" | "endOffset">;
export type SessionCaptureRecord =
  | { kind: "frame"; offset: number; endOffset: number; frame: Buffer; frameTimeMs?: number }
  | { kind: "segment-boundary"; offset: number; endOffset: number }
  | { kind: "segment-context"; offset: number; endOffset: number }
  | { kind: "segment-context-end"; offset: number; endOffset: number }
  | (ParserBootstrapRecord & { endOffset: number });

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
export function encodeParserBootstrapFrame(gameId: ParserBootstrapGameId, payload: Uint8Array): Buffer {
  const gameCode = CAPTURE_GAME_IDS.indexOf(gameId) + 1;
  if (gameCode === 0 || payload.byteLength + 12 > MAX_FRAME_LENGTH) throw new RangeError("Invalid parser bootstrap");
  const markerPayloadBytes = 12 + payload.byteLength;
  const output = Buffer.allocUnsafe(8 + markerPayloadBytes);
  output.writeUInt32LE(META_FRAME_MAGIC, 0);
  output.writeUInt32LE(markerPayloadBytes, 4);
  output.writeUInt32LE(PARSER_BOOTSTRAP_MAGIC, 8);
  output.writeUInt32LE(PARSER_BOOTSTRAP_VERSION, 12);
  output.writeUInt32LE(gameCode, 16);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(output, 20);
  return output;
}
export function decodeParserBootstrapPayload(payload: Buffer): ParserBootstrapPayload | null {
  if (payload.length < 4 || payload.readUInt32LE(0) !== PARSER_BOOTSTRAP_MAGIC) return null;
  if (payload.length < 12) throw new Error("Truncated parser bootstrap marker");
  const formatVersion = payload.readUInt32LE(4);
  const gameId = CAPTURE_GAME_IDS[payload.readUInt32LE(8) - 1];
  if (formatVersion !== PARSER_BOOTSTRAP_VERSION || gameId === undefined) {
    throw new Error("Unsupported parser bootstrap marker");
  }
  return { kind: "parser-bootstrap", gameId, formatVersion, payload: payload.subarray(12) };
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
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== META_FRAME_MAGIC) return 0;
  if (bytes.length < 8) throw new Error("Truncated session capture record");
  if (bytes.readUInt32LE(4) !== META_FRAME_PAYLOAD_BYTES) return 0;
  if (bytes.length < META_FRAME_BYTES) throw new Error("Truncated session capture record");
  return META_FRAME_BYTES;
}
interface SessionFrameIterationOptions { skipMetaFrames?: boolean; allowEmptyFrames?: boolean; strict?: boolean; }

/**
 * Decode canonical session records. Trailing truncation is ignored by default
 * for backwards-compatible recovery reads; recovery callers SHOULD pass
 * `{ strict: false }` explicitly. Pass `{ strict: true }` when the complete
 * capture boundary must be validated.
 */
export function* iterateSessionCaptureRecords(
  bytes: Buffer,
  requestedOffset = readRecorderFrameStreamStart(bytes),
  options: SessionFrameIterationOptions = {},
): Generator<SessionCaptureRecord> {
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
  let checkpointOffset = -1;
  let previous: Buffer | null = null;
  let checkpointIdentity: string | null = null;
  while (offset + 4 <= bytes.length) {
    const recordOffset = offset;
    const isMeta = bytes.readUInt32LE(offset) === META_FRAME_MAGIC;
    const prefix = isMeta ? null : readFramePrefix(bytes, offset);
    if (!isMeta && !prefix) {
      if (options.strict) throw new Error(`Truncated session capture record at ${offset}`);
      return;
    }
    const length = isMeta ? META_FRAME_MAGIC : prefix!.length;
    if (isMeta) {
      if (offset + 8 > bytes.length) {
        if (options.strict) throw new Error(`Truncated session capture record at ${offset}`);
        return;
      }
      const payloadBytes = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + payloadBytes > bytes.length) {
        if (options.strict) throw new Error(`Truncated session capture record at ${offset}`);
        return;
      }
      if (payloadBytes === 8) {
        const magic = bytes.readUInt32LE(offset + 8);
        const version = bytes.readUInt32LE(offset + 12);
        if (magic === SEGMENT_BOUNDARY_MAGIC && version === SEGMENT_BOUNDARY_VERSION) {
          previous = null;
          checkpointOffset = -1;
          checkpointIdentity = null;
          if (recordOffset >= requestedOffset) yield { kind: "segment-boundary", offset: recordOffset, endOffset: offset + 8 + payloadBytes };
        } else if (magic === SEGMENT_CONTEXT_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
          if (recordOffset >= requestedOffset) yield { kind: "segment-context", offset: recordOffset, endOffset: offset + 8 + payloadBytes };
        } else if (magic === SEGMENT_CONTEXT_END_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
          previous = null;
          checkpointIdentity = null;
          checkpointOffset = -1;
          if (recordOffset >= requestedOffset) yield { kind: "segment-context-end", offset: recordOffset, endOffset: offset + 8 + payloadBytes };
        }
      } else {
        const bootstrap = decodeParserBootstrapPayload(bytes.subarray(offset + 8, offset + 8 + payloadBytes));
        if (bootstrap) {
          previous = null;
          checkpointOffset = -1;
          checkpointIdentity = null;
          if (recordOffset >= requestedOffset) yield { ...bootstrap, offset: recordOffset, endOffset: offset + 8 + payloadBytes };
        }
      }
      offset += 8 + payloadBytes;
      continue;
    }
    const frameTimeMs = prefix?.frameTimeMs;
    const payloadOffset = offset + prefix!.prefixBytes;
    if (payloadOffset + length > bytes.length) {
      if (options.strict) throw new Error(`Truncated session capture record at ${offset}`);
      return;
    }
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
      if (frameTimeMs === undefined) yield { kind: "frame", offset: recordOffset, endOffset: payloadOffset + length, frame };
      else yield { kind: "frame", offset: recordOffset, endOffset: payloadOffset + length, frame, frameTimeMs };
    }
    offset = payloadOffset + length;
  }
  if (offset < bytes.length && options.strict) throw new Error(`Truncated session capture record at ${offset}`);
}
/**
 * Incrementally decodes decompressed session records. Offsets refer to the
 * original decompressed stream, including any META header and marker records.
 */
export async function* iterateSessionCaptureRecordsAsync(
  source: AsyncIterable<Uint8Array>,
  options: { strict?: boolean } = {},
): AsyncGenerator<SessionCaptureRecord, number> {
  const iterator = source[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0);
  let cursor = 0;
  let offset = 0;
  let ended = false;
  const strict = options.strict ?? true;
  async function take(length: number): Promise<Buffer | null> {
    if (length < 0 || length > MAX_FRAME_LENGTH + 12) throw new Error("Invalid capture record length");
    while (chunk.length - cursor < length && !ended) {
      if (cursor) { chunk = chunk.subarray(cursor); cursor = 0; }
      const next = await iterator.next();
      if (next.done) { ended = true; break; }
      const incoming = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      if (chunk.length === 0) chunk = incoming;
      else {
        const merged = Buffer.allocUnsafe(chunk.length + incoming.length);
        chunk.copy(merged); incoming.copy(merged, chunk.length); chunk = merged;
      }
    }
    if (chunk.length - cursor < length) {
      const remaining = chunk.length - cursor;
      if (strict && remaining > 0) throw new Error("Truncated session capture record");
      return null;
    }
    const result = chunk.subarray(cursor, cursor + length);
    cursor += length;
    offset += length;
    return result;
  }
  try {
    const first = await take(4);
    if (!first) return offset;
    let initialMetadataSize: number | undefined;
    if (first.readUInt32LE(0) === META_FRAME_MAGIC) {
      const rest = await take(4);
      if (!rest) throw new Error("Truncated session capture record");
      const size = rest.readUInt32LE(0);
      if (size > MAX_FRAME_LENGTH) throw new Error("Invalid META frame length");
      if (size === META_FRAME_PAYLOAD_BYTES) {
        if (!await take(size)) throw new Error("Truncated session capture record");
      } else {
        initialMetadataSize = size;
      }
    } else {
      // Keep first prefix for the ordinary record path.
      cursor -= 4;
      offset -= 4;
    }
    let previous: Buffer | null = null;
    let checkpointOffset = -1;
    let checkpointIdentity: string | null = null;
    for (;;) {
      const initialMetadata = initialMetadataSize !== undefined;
      const availablePrefix = initialMetadata ? first : await take(4);
      if (!availablePrefix) return offset;
      const recordOffset = initialMetadata ? 0 : offset - 4;
      const stored = availablePrefix.readUInt32LE(0);
      if (stored === META_FRAME_MAGIC) {
        let size: number;
        if (initialMetadataSize !== undefined) {
          size = initialMetadataSize;
          initialMetadataSize = undefined;
        } else {
          const sizeBytes = await take(4);
          if (!sizeBytes) throw new Error("Truncated session capture record");
          size = sizeBytes.readUInt32LE(0);
        }
        if (size > MAX_FRAME_LENGTH) throw new Error("Invalid META frame length");
        const payload = await take(size);
        if (!payload) throw new Error("Truncated session capture record");
        const endOffset = offset;
        if (size === 8) {
          const magic = payload.readUInt32LE(0), version = payload.readUInt32LE(4);
          if (magic === SEGMENT_BOUNDARY_MAGIC && version === SEGMENT_BOUNDARY_VERSION) {
            previous = null; checkpointOffset = -1; checkpointIdentity = null;
            yield { kind: "segment-boundary", offset: recordOffset, endOffset };
          } else if (magic === SEGMENT_CONTEXT_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
            yield { kind: "segment-context", offset: recordOffset, endOffset };
          } else if (magic === SEGMENT_CONTEXT_END_MAGIC && version === SEGMENT_CONTEXT_VERSION) {
            previous = null; checkpointOffset = -1; checkpointIdentity = null;
            yield { kind: "segment-context-end", offset: recordOffset, endOffset };
          } else if (strict) throw new Error(`Unknown capture segment marker at ${recordOffset}`);
        } else {
          const bootstrap = decodeParserBootstrapPayload(payload);
          if (bootstrap) {
            previous = null; checkpointOffset = -1; checkpointIdentity = null;
            yield { ...bootstrap, offset: recordOffset, endOffset };
          } else if (strict) throw new Error(`Unknown capture metadata at ${recordOffset}`);
        }
        continue;
      }
      const timestamped = (stored & TIMESTAMPED_LENGTH_FLAG) !== 0;
      const length = timestamped ? stored & ~TIMESTAMPED_LENGTH_FLAG : stored;
      if (length > MAX_FRAME_LENGTH) throw new Error("Invalid capture frame length");
      let frameTimeMs: number | undefined;
      if (timestamped) {
        const ts = await take(8);
        if (!ts) throw new Error("Truncated session capture record");
        const value = ts.readBigUInt64LE(0);
        if (value > MAX_SAFE_FRAME_TIME_MS) throw new Error("Invalid frame timestamp");
        frameTimeMs = Number(value);
      }
      const payload = await take(length);
      if (!payload) throw new Error("Truncated session capture record");
      let frame = payload;
      const lmu = isLmuSparseFrame(payload), kunos = isKunosSparseFrame(payload), generic = isGenericSparseFrame(payload);
      if (lmu || kunos || generic) {
        if (!previous || checkpointOffset < 0) throw new Error(`Sparse frame at ${recordOffset} has no checkpoint`);
        const distance = generic ? (payload.length >= 9 ? payload.readUInt32LE(5) : 0) : (payload.length >= 8 ? payload.readUInt32LE(4) : 0);
        if (distance <= 0 || recordOffset - distance !== checkpointOffset) throw new Error(`Invalid sparse checkpoint distance at ${recordOffset}`);
        if (lmu && checkpointIdentity !== "lmu-v2") throw new Error(`Invalid LMU sparse checkpoint identity at ${recordOffset}`);
        if (kunos && (!checkpointIdentity?.startsWith("kunos-") || Number(checkpointIdentity.slice(6)) !== kunosSourceMagic(previous))) throw new Error(`Invalid Kunos sparse checkpoint identity at ${recordOffset}`);
        if (generic && (!checkpointIdentity || genericFrameIdentity(previous) !== checkpointIdentity)) throw new Error(`Invalid generic sparse checkpoint identity at ${recordOffset}`);
        frame = generic ? decodeGenericSparseFrame(payload, previous) : lmu ? decodeLmuSparseFrame(payload, previous) : decodeKunosSparseFrame(payload, previous);
        if (lmu && !isLmuSourceFrame(frame)) throw new Error(`Invalid LMU sparse frame at ${recordOffset}`);
        if (kunos && kunosSourceMagic(frame) !== Number(checkpointIdentity!.slice(6))) throw new Error(`Invalid Kunos sparse frame identity at ${recordOffset}`);
      } else {
        const magic = kunosSourceMagic(payload);
        checkpointIdentity = isLmuSourceFrame(payload) ? "lmu-v2" : magic ? `kunos-${magic}` : genericFrameIdentity(payload);
        checkpointOffset = checkpointIdentity ? recordOffset : -1;
      }
      previous = frame;
      const endOffset = offset;
      yield frameTimeMs === undefined ? { kind: "frame", offset: recordOffset, endOffset, frame } : { kind: "frame", offset: recordOffset, endOffset, frame, frameTimeMs };
    }
  } finally {
    await iterator.return?.();
  }
}
export type SessionImportFrame =
  | Buffer
  | typeof SESSION_SEGMENT_BOUNDARY
  | typeof SESSION_SEGMENT_CONTEXT
  | typeof SESSION_SEGMENT_CONTEXT_END
  | ParserBootstrapPayload;
export function* iterateSessionImportFrames(bytes: Buffer): Generator<SessionImportFrame> {
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "segment-boundary") yield SESSION_SEGMENT_BOUNDARY;
    else if (record.kind === "segment-context") yield SESSION_SEGMENT_CONTEXT;
    else if (record.kind === "segment-context-end") yield SESSION_SEGMENT_CONTEXT_END;
    else if (record.kind === "parser-bootstrap") yield { kind: record.kind, gameId: record.gameId, formatVersion: record.formatVersion, payload: record.payload };
    else yield record.frame;
  }
}
export function* iterateSessionFrameRecords(
  bytes: Buffer,
  offset = readRecorderFrameStreamStart(bytes),
  options?: SessionFrameIterationOptions,
): Generator<Extract<SessionCaptureRecord, { kind: "frame" }>> {
  for (const record of iterateSessionCaptureRecords(bytes, offset, options)) if (record.kind === "frame") yield record;
}
export function* iterateSessionFrames(
  bytes: Buffer,
  offset = readRecorderFrameStreamStart(bytes),
  options?: SessionFrameIterationOptions,
): Generator<Buffer> {
  for (const record of iterateSessionCaptureRecords(bytes, offset, options)) if (record.kind === "frame") yield record.frame;
}
export function sessionFrameAt(bytes: Buffer, offset: number): Buffer | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  for (const record of iterateSessionCaptureRecords(bytes, offset)) {
    if (record.kind === "frame" && record.offset === offset) return record.frame;
    if (record.offset > offset) break;
  }
  return null;
}
export function advanceSessionFrames(bytes: Buffer, offset: number, count: number): number {
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at < 0 || at + 4 > bytes.length) break;
    const prefix = readFramePrefix(bytes, at);
    if (!prefix || prefix.length === 0 || at + prefix.prefixBytes + prefix.length > bytes.length) break;
    at += prefix.prefixBytes + prefix.length;
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
