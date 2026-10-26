import { setImmediate as yieldToWorker } from "node:timers/promises";
import { getServerGame } from "../games/registry";
import { F1_PACKET_IDS, isF1NativePacket, parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC, unpackTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { IRACING_SOURCE_MAGIC } from "@raceiq/capture-formats/iracing/source-frame";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import {
  META_FRAME_MAGIC, PARSER_BOOTSTRAP_VERSION,
  SEGMENT_BOUNDARY_MAGIC, SEGMENT_BOUNDARY_VERSION,
  SEGMENT_CONTEXT_MAGIC, SEGMENT_CONTEXT_VERSION, SEGMENT_CONTEXT_END_MAGIC,
  decodeParserBootstrapPayload, encodeParserBootstrapFrame,
  decodeSessionClockAnchorPayload, encodeSessionClockAnchor,
  encodeFrameLength, encodeMetaFrame, readFramePrefix,
  type SessionCaptureRecord, type ParserBootstrapPayload,
} from "@raceiq/capture-formats/session/framing";
import type { UploadGame, VerifiedRecordingCodec } from "@raceiq/online/server/payload";
import { isWholeLapSelf, type GameIdentityBinding } from "@raceiq/shared/driver-attribution";
import { NativeAttributionTracker, getNativeSourceClock, nativeDriverBindings } from "../lap-detection/native-attribution";

/** Service admission and decompression are independent limits, both inclusive. */
export const MAX_ONLINE_RECORDING_BYTES = 500_000_000;
export const MAX_ONLINE_CAPTURE_BYTES = 512 * 1024 * 1024;
export const MAX_ONLINE_CAPTURE_FRAMES = 1_000_000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const F1_CHECKPOINT_KEYS = [
  "format", "version", "sessionUID", "motion", "carTelemetry", "lapData",
  "finalClassification", "carStatus", "carDamage", "carSetup", "motionEx",
  "session", "participants", "driverHistory", "driverLapSectors", "playerCarIndex",
] as const;

export type OnlineRecordingErrorCode =
  | "unsupported_recording_format" | "f1_sanitization_failed"
  | "recording_too_large" | "recording_not_ready" | "driver_identity_required"
  | "mixed_driver_lap" | "activity_identity_ambiguous" | "activity_owner_conflict"
  | "lap_identity_conflict" | "lap_owner_conflict" | "ineligible_lap";

/** Only stable public reasons leave the worker; source paths/parser exceptions do not. */
export class OnlineRecordingError extends Error {
  constructor(readonly code: OnlineRecordingErrorCode) {
    super(code);
    this.name = "OnlineRecordingError";
  }
}

export function assertNativeOnlineFrame(frame: Buffer, gameId: UploadGame): void {
  let valid = false;
  if (gameId === "acc" || gameId === "ac-evo") {
    const expectedMagic = gameId === "acc" ? ACC_PACKED_MAGIC : ACEVO_PACKED_MAGIC;
    const triplet = frame.length >= 24 && frame.readUInt32LE(0) === expectedMagic ? unpackTriplet(frame) : null;
    valid = triplet !== null && triplet.physics.length > 0 && triplet.graphics.length > 0 &&
      triplet.staticData.length > 0 &&
      24 + triplet.physics.length + triplet.graphics.length + triplet.staticData.length === frame.length;
  } else if (gameId === "f1-2025") {
    valid = isF1NativePacket(frame);
  } else if (gameId === "iracing") {
    valid = frame.length >= 12 && frame.readUInt32LE(0) === IRACING_SOURCE_MAGIC;
  } else if (gameId === "lmu") {
    try { valid = decodeLMUSourceFrame(frame) !== null; }
    catch { valid = false; }
  }
  if (!valid) throw new OnlineRecordingError("unsupported_recording_format");
}

/** Exact game-owned v1 layout, not a recursive similarly-named-channel filter. */
export function sanitizeF1ParserBootstrap(payload: Uint8Array): Buffer {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    const checkpoint = decoded as Record<string, unknown>;
    const keys = Object.keys(checkpoint);
    if (keys.length !== F1_CHECKPOINT_KEYS.length ||
        keys.some(key => !F1_CHECKPOINT_KEYS.some(known => known === key)) ||
        checkpoint.format !== "raceiq:f1-2025-parser" || checkpoint.version !== 1) throw new Error();
    // The native parser validates every required state group, participant, sector and UID.
    const game = getServerGame("f1-2025");
    if (!game.restoreParserCheckpoint) throw new Error();
    game.restoreParserCheckpoint(game.createParserState(), payload);
    checkpoint.carSetup = null;
    const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
    const sanitized = Buffer.from(json.stringify(checkpoint, (_key, value) =>
      typeof value === "number" && Object.is(value, -0) ? json.rawJSON("-0") : value));
    game.restoreParserCheckpoint(game.createParserState(), sanitized);
    return sanitized;
  } catch {
    throw new OnlineRecordingError("f1_sanitization_failed");
  }
}

/** Web compression disallows shared BufferSource views; ordinary capture chunks borrow bytes. */
function compressionChunk(bytes: Uint8Array, offset: number): Uint8Array<ArrayBuffer> {
  const length = Math.min(256 * 1024, bytes.length - offset);
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer, bytes.byteOffset + offset, length)
    : new Uint8Array(bytes.subarray(offset, offset + length));
}

async function decodeRecording(recording: Uint8Array): Promise<{ bytes: Buffer; compressed: boolean }> {
  if (!recording.byteLength || recording.byteLength > MAX_ONLINE_RECORDING_BYTES) {
    throw new OnlineRecordingError("recording_too_large");
  }
  const input = Buffer.from(recording.buffer, recording.byteOffset, recording.byteLength);
  const compressed = input[0] === 0x1f && input[1] === 0x8b;
  let bytes = input;
  if (compressed) {
    let sourceOffset = 0;
    const stream = new ReadableStream<BufferSource>({
      pull(controller) {
        if (sourceOffset >= input.length) { controller.close(); return; }
        controller.enqueue(compressionChunk(input, sourceOffset));
        sourceOffset += 256 * 1024;
      },
    }).pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > MAX_ONLINE_CAPTURE_BYTES) throw new OnlineRecordingError("recording_too_large");
        chunks.push(Buffer.from(item.value.buffer, item.value.byteOffset, item.value.byteLength));
        await yieldToWorker();
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks, length);
  }
  if (bytes.length > MAX_ONLINE_CAPTURE_BYTES || bytes.length < 12 ||
      bytes.readUInt32LE(0) !== META_FRAME_MAGIC || bytes.readUInt32LE(4) !== 4) {
    throw new OnlineRecordingError("unsupported_recording_format");
  }
  return { bytes, compressed };
}

type CanonicalRecord = { offset: number; endOffset: number; frame?: Buffer; frameTimeMs?: number; bootstrap?: ParserBootstrapPayload | null };

/** Deliberately accepts only expanded native frames and the documented metadata grammar. */
async function* canonicalRecords(bytes: Buffer, gameId: UploadGame): AsyncGenerator<CanonicalRecord> {
  if (bytes.length < 12 || bytes.length > MAX_ONLINE_CAPTURE_BYTES ||
      bytes.readUInt32LE(0) !== META_FRAME_MAGIC || bytes.readUInt32LE(4) !== 4) {
    throw new OnlineRecordingError("unsupported_recording_format");
  }
  let offset = 12;
  let frames = 0;
  let context = false;
  let sawContext = false, contextFrames = 0;
  let f1ContextSession: bigint | undefined;
  const f1ContextPackets = new Set<number>();
  let bootstrapped = false;
  let anchored = false;
  let lastYieldOffset = 12;
  let recordsSinceYield = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (offset + 4 > bytes.length) throw new OnlineRecordingError("unsupported_recording_format");
    if (bytes.readUInt32LE(offset) === META_FRAME_MAGIC) {
      if (offset + 8 > bytes.length) throw new OnlineRecordingError("unsupported_recording_format");
      const length = bytes.readUInt32LE(offset + 4);
      if (length > MAX_RECORD_BYTES || length < 8 || offset + 8 + length > bytes.length) {
        throw new OnlineRecordingError("unsupported_recording_format");
      }
      const payload = bytes.subarray(offset + 8, offset + 8 + length);
      const anchor = decodeSessionClockAnchorPayload(payload);
      const bootstrap = anchor ? null : decodeParserBootstrapPayload(payload);
      if (anchor) {
        if (anchored || frames > 0) throw new OnlineRecordingError("unsupported_recording_format");
        anchored = true;
      } else if (bootstrap) {
        if (bootstrap.gameId !== gameId || bootstrap.formatVersion !== PARSER_BOOTSTRAP_VERSION ||
            context || sawContext || frames > 0 || bootstrapped) {
          throw new OnlineRecordingError("unsupported_recording_format");
        }
        if (gameId === "f1-2025") sanitizeF1ParserBootstrap(bootstrap.payload);
        bootstrapped = true;
      } else {
        const magic = payload.readUInt32LE(0), version = payload.readUInt32LE(4);
        if (length !== 8) throw new OnlineRecordingError("unsupported_recording_format");
        if (magic === SEGMENT_CONTEXT_MAGIC && version === SEGMENT_CONTEXT_VERSION && !context && !sawContext && frames === 0) {
          context = true;
          sawContext = true;
        }
        else if (magic === SEGMENT_CONTEXT_END_MAGIC && version === SEGMENT_CONTEXT_VERSION && context) context = false;
        else if (magic !== SEGMENT_BOUNDARY_MAGIC || version !== SEGMENT_BOUNDARY_VERSION || context || frames > 0) {
          throw new OnlineRecordingError("unsupported_recording_format");
        }
      }
      offset += 8 + length;
      yield { offset: start, endOffset: offset, bootstrap };
    } else {
      const prefix = readFramePrefix(bytes, offset);
      if (!prefix || !prefix.length || prefix.length > MAX_RECORD_BYTES ||
          offset + prefix.prefixBytes + prefix.length > bytes.length) {
        throw new OnlineRecordingError("unsupported_recording_format");
      }
      const frame = bytes.subarray(offset + prefix.prefixBytes, offset + prefix.prefixBytes + prefix.length);
      assertNativeOnlineFrame(frame, gameId);
      if (context) {
        contextFrames++;
        if ((gameId === "iracing" && contextFrames > 1) ||
            ((gameId === "ac-evo" || gameId === "lmu") && contextFrames > 2) || gameId === "acc") {
          throw new OnlineRecordingError("unsupported_recording_format");
        }
        if (gameId === "f1-2025") {
          const header = parseF1Header(frame);
          if ((f1ContextSession !== undefined && f1ContextSession !== header.sessionUID) ||
              f1ContextPackets.has(header.packetId)) throw new OnlineRecordingError("unsupported_recording_format");
          f1ContextSession = header.sessionUID;
          f1ContextPackets.add(header.packetId);
        }
      }
      if (++frames > MAX_ONLINE_CAPTURE_FRAMES) throw new OnlineRecordingError("recording_too_large");
      offset += prefix.prefixBytes + prefix.length;
      yield { offset: start, endOffset: offset, frame, frameTimeMs: prefix.frameTimeMs };
    }
    if (++recordsSinceYield >= 256 || offset - lastYieldOffset >= 1024 * 1024) {
      recordsSinceYield = 0;
      lastYieldOffset = offset;
      await yieldToWorker();
    }
  }
  if (context || !frames || frames !== bytes.readUInt32LE(8)) {
    throw new OnlineRecordingError("unsupported_recording_format");
  }
}

export function createNativeOnlineRecordingCodec(gameId: UploadGame): VerifiedRecordingCodec {
  return {
    recordingFormatId: "raceiq-session-native-v1",
    // No verified external setup format is selected by this native-session codec.
    supportsSetupAttachment: () => false,
    async isServiceCompatible(recording, requestedGame) {
      if (requestedGame !== gameId) return false;
      try {
        const { bytes } = await decodeRecording(recording);
        const game = getServerGame(gameId);
        let state = game.createParserState();
        let decodedNativePacket = false;
        for await (const record of canonicalRecords(bytes, gameId)) {
          if (record.bootstrap) {
            if (!game.restoreParserCheckpoint) return false;
            state = game.restoreParserCheckpoint(state, record.bootstrap.payload);
          } else if (record.frame) {
            const packet = game.tryParse(record.frame, state, record.frameTimeMs);
            if (gameId === "f1-2025" && packet && packet.carId !== "41") return false;
            if (packet?.gameId === gameId && packet.carId && packet.trackId) decodedNativePacket = true;
          }
        }
        return decodedNativePacket;
      } catch { return false; }
    },
    async stripF1SetupTelemetry(recording) {
      if (gameId !== "f1-2025") return null;
      try {
        const { bytes, compressed } = await decodeRecording(recording);
        const parts: Buffer[] = [encodeMetaFrame()];
        let frames = 0;
        for await (const record of canonicalRecords(bytes, gameId)) {
          if (record.frame && parseF1Header(record.frame).packetId === F1_PACKET_IDS.CAR_SETUP) continue;
          if (record.bootstrap) parts.push(encodeParserBootstrapFrame(gameId, sanitizeF1ParserBootstrap(record.bootstrap.payload)));
          else parts.push(bytes.subarray(record.offset, record.endOffset));
          if (record.frame) frames++;
        }
        parts[0] = encodeMetaFrame(frames);
        const sanitized = Buffer.concat(parts);
        const output = compressed ? await compressNativeOnlineRecording(sanitized) : sanitized;
        return output.length <= MAX_ONLINE_RECORDING_BYTES ? output : null;
      } catch { return null; }
    },
    async hasF1SetupTelemetry(recording) {
      if (gameId !== "f1-2025") return false;
      try {
        const { bytes } = await decodeRecording(recording);
        for await (const record of canonicalRecords(bytes, gameId)) {
          if (record.frame && parseF1Header(record.frame).packetId === F1_PACKET_IDS.CAR_SETUP) return true;
          if (record.bootstrap) {
            const checkpoint = JSON.parse(record.bootstrap.payload.toString("utf8")) as Record<string, unknown>;
            if (checkpoint.carSetup !== null) return true;
          }
        }
        return false;
      } catch { return true; }
    },
  };
}

/** Called only inside the dedicated Online worker, on the resolved lap artifact. */
export async function encodeNativeOnlineRecording(
  records: AsyncIterable<SessionCaptureRecord>, gameId: UploadGame,
): Promise<Buffer> {
  const parts: Buffer[] = [encodeMetaFrame()];
  let bytes = 12, frames = 0, batchBytes = 0, inputFrames = 0, inputRecords = 0;
  let anchored = false;
  for await (const record of records) {
    if (++inputRecords % 256 === 0) await yieldToWorker();
    let part: Buffer | undefined;
    if (record.kind === "frame") {
      assertNativeOnlineFrame(record.frame, gameId);
      if (++inputFrames > MAX_ONLINE_CAPTURE_FRAMES) throw new OnlineRecordingError("recording_too_large");
      if (gameId === "f1-2025" && parseF1Header(record.frame).packetId === F1_PACKET_IDS.CAR_SETUP) continue;
      frames++;
      const prefix = encodeFrameLength(record.frame.length, record.frameTimeMs);
      bytes += prefix.length + record.frame.length;
      batchBytes += prefix.length + record.frame.length;
      parts.push(prefix, record.frame);
    } else if (record.kind === "clock-anchor") {
      if (anchored || inputFrames > 0) throw new OnlineRecordingError("unsupported_recording_format");
      anchored = true;
      part = encodeSessionClockAnchor(record.frameTimeMs, record.utcTimeMs);
    } else if (record.kind === "parser-bootstrap") {
      if (record.gameId !== gameId || record.formatVersion !== PARSER_BOOTSTRAP_VERSION) {
        throw new OnlineRecordingError("unsupported_recording_format");
      }
      part = encodeParserBootstrapFrame(gameId, gameId === "f1-2025"
        ? sanitizeF1ParserBootstrap(record.payload) : record.payload);
    } else if (record.kind === "segment-context" || record.kind === "segment-context-end" || record.kind === "segment-boundary") {
      const magic = record.kind === "segment-context" ? SEGMENT_CONTEXT_MAGIC
        : record.kind === "segment-context-end" ? SEGMENT_CONTEXT_END_MAGIC : SEGMENT_BOUNDARY_MAGIC;
      part = Buffer.alloc(16);
      part.writeUInt32LE(META_FRAME_MAGIC, 0); part.writeUInt32LE(8, 4);
      part.writeUInt32LE(magic, 8); part.writeUInt32LE(1, 12);
    } else {
      throw new OnlineRecordingError("unsupported_recording_format");
    }
    bytes += part?.length ?? 0;
    batchBytes += part?.length ?? 0;
    if (bytes > MAX_ONLINE_CAPTURE_BYTES) throw new OnlineRecordingError("recording_too_large");
    if (part) parts.push(part);
    if (batchBytes >= 1024 * 1024 || frames % 256 === 0) {
      batchBytes = 0;
      await yieldToWorker();
    }
  }
  if (!frames) throw new OnlineRecordingError("unsupported_recording_format");
  parts[0] = encodeMetaFrame(frames);
  return Buffer.concat(parts, bytes);
}

/** Compression streams in bounded chunks; expanded bytes never leave the Online worker. */
export async function compressNativeOnlineRecording(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!bytes.length || bytes.length > MAX_ONLINE_CAPTURE_BYTES) throw new OnlineRecordingError("recording_too_large");
  let sourceOffset = 0;
  const stream = new ReadableStream<BufferSource>({
    pull(controller) {
      if (sourceOffset >= bytes.length) { controller.close(); return; }
      controller.enqueue(compressionChunk(bytes, sourceOffset));
      sourceOffset += 256 * 1024;
    },
  }).pipeThrough(new CompressionStream("gzip"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_ONLINE_RECORDING_BYTES) throw new OnlineRecordingError("recording_too_large");
      parts.push(item.value);
      await yieldToWorker();
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export interface NativeOnlineDriverContext {
  gameId: UploadGame;
  trackId: string;
  carId: string;
  sourceClockDomain: string;
  sourceLapStartMs: number;
  sourceLapEndMs: number;
  capturedBinding: GameIdentityBinding;
}

/** Replays real native source; portable Self declarations and restored caches are not actor proof. */
export async function assertNativeOnlineDriver(bytes: Buffer, context: NativeOnlineDriverContext): Promise<void> {
  const game = getServerGame(context.gameId);
  let state = game.createParserState();
  const bindings = nativeDriverBindings([context.capturedBinding]);
  if (bindings.length !== 1) throw new OnlineRecordingError("driver_identity_required");
  const tracker = new NativeAttributionTracker();
  let ownedPackets = 0;
  for await (const record of canonicalRecords(bytes, context.gameId)) {
    if (record.bootstrap) {
      if (!game.restoreParserCheckpoint) throw new OnlineRecordingError("unsupported_recording_format");
      state = game.restoreParserCheckpoint(state, record.bootstrap.payload);
      game.invalidateDriverEvidence?.(state);
      tracker.invalidate();
    } else if (record.frame) {
      const packet = game.tryParse(record.frame, state, record.frameTimeMs);
      if (packet) {
        tracker.observe(packet, bindings, record.frameTimeMs);
        const clock = getNativeSourceClock(packet, record.frameTimeMs);
        if (clock?.domain === context.sourceClockDomain &&
            clock.atMs >= context.sourceLapStartMs && clock.atMs < context.sourceLapEndMs) {
          if (packet.gameId !== context.gameId || packet.carId !== context.carId || packet.trackId !== context.trackId) {
            throw new OnlineRecordingError("lap_identity_conflict");
          }
          ownedPackets++;
        }
      }
    }
  }
  if (!ownedPackets || !isWholeLapSelf(tracker.stints, context.sourceLapStartMs, context.sourceLapEndMs, context.sourceClockDomain)) {
    throw new OnlineRecordingError("driver_identity_required");
  }
}
