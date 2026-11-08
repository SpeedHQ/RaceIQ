import type { Hash } from "node:crypto";
import {
  encodeFrameLength, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame, encodeSegmentContextFrame,
  iterateSessionCaptureRecords, type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import type { GameId, LapWindow } from "./contract";
import type { StreamingPositionSpool } from "./streaming-spool";

export type StreamingMemberKind = "lap" | "auxiliary";

export interface EncodedSourceEvent {
  readonly sequence: number;
  readonly kind: "frame" | "raw" | "segment-boundary";
  readonly sourceOffset: number;
  readonly sourceEndOffset: number;
  readonly bytes: Uint8Array;
  readonly frameTimeMs?: number;
}

/** Rebuild decoded source records from worker events without using sparse-storage offsets as ownership coordinates. */
export function decodeEncodedSourceEvent(event: EncodedSourceEvent): SessionCaptureRecord[] {
  if (event.kind === "frame") {
    const frame = Buffer.from(event.bytes);
    return [event.frameTimeMs === undefined
      ? { kind: "frame", offset: event.sourceOffset, endOffset: event.sourceEndOffset, frame }
      : { kind: "frame", offset: event.sourceOffset, endOffset: event.sourceEndOffset, frame, frameTimeMs: event.frameTimeMs }];
  }
  if (event.kind === "segment-boundary") return [{ kind: "segment-boundary", offset: event.sourceOffset, endOffset: event.sourceEndOffset }];
  const raw = Buffer.from(event.bytes);
  return [...iterateSessionCaptureRecords(raw, 0, { strict: true })].map((record) => ({
    ...record,
    offset: event.sourceOffset + record.offset,
    endOffset: event.sourceOffset + record.endOffset,
  }));
}

export function encodeStreamingFrame(encoder: SparseCaptureEncoder, frame: Buffer, offset: number, timestamp?: number): readonly [Buffer, Buffer] {
  const encoded = encoder.encode(frame, offset);
  return [encodeFrameLength(encoded.length, timestamp), encoded];
}

export function matchesNativeRecord(outputRecord: SessionCaptureRecord, sourceRecord: SessionCaptureRecord): boolean {
  if (outputRecord.kind !== sourceRecord.kind) return false;
  if (outputRecord.kind === "frame" && sourceRecord.kind === "frame") {
    return outputRecord.frame.equals(sourceRecord.frame) && outputRecord.frameTimeMs === sourceRecord.frameTimeMs;
  }
  if (outputRecord.kind === "parser-bootstrap" && sourceRecord.kind === "parser-bootstrap") {
    return outputRecord.gameId === sourceRecord.gameId && outputRecord.formatVersion === sourceRecord.formatVersion &&
      outputRecord.payload.equals(sourceRecord.payload);
  }
  return true;
}

// Hash.update consumes bytes synchronously; no async boundary exposes this scratch buffer.
const nativeDigestMetadata = Buffer.allocUnsafe(14);
export function updateNativeRecordDigest(hash: Hash, record: SessionCaptureRecord): void {
  if (record.kind === "frame") {
    nativeDigestMetadata[0] = 1;
    nativeDigestMetadata[1] = record.frameTimeMs === undefined ? 0 : 1;
    nativeDigestMetadata.writeUInt32LE(record.frame.byteLength, 2);
    nativeDigestMetadata.writeDoubleLE(record.frameTimeMs ?? 0, 6);
    hash.update(nativeDigestMetadata);
    hash.update(record.frame);
  } else {
    const marker = record.kind === "segment-boundary" ? encodeSegmentBoundaryFrame()
      : record.kind === "segment-context" ? encodeSegmentContextFrame()
      : record.kind === "segment-context-end" ? encodeSegmentContextEndFrame()
      : encodeParserBootstrapFrame(record.gameId, record.payload);
    hash.update(marker);
  }
}
export interface StreamingMemberDescriptor {
  readonly id: string;
  readonly kind: StreamingMemberKind;
  readonly lap?: LapWindow;
  readonly parserReplayVerified?: boolean;
  readonly parserReplayEvidence?: LiveParserReplayEvidence;
  readonly firstOrdinal: number;
  readonly sourceStart: number;
  readonly sourceByteStart: number;
  readonly sourceEnd: number;
  readonly sourceByteEnd: number;
  readonly recordCount: number;
  readonly ownedFrameCount: number;
  readonly trailingContextFrameCount: number;
  readonly nativeDigest: string;
  readonly trailingContextDigest?: string;
  readonly parserBootstrapHash?: string;
  readonly byteLength: number;
  readonly ownedFrameByteOffset?: number;
  readonly firstTimestamp?: number;
  readonly lastTimestamp?: number;
}
/** Staging is unpublished scratch storage. append() must apply backpressure; it must never touch the live archive. */
export interface StreamingMemberStage {
  append(bytes: Uint8Array): Promise<void>;
  readRecords(signal?: AbortSignal): AsyncIterable<SessionCaptureRecord>;
  close(): Promise<void>;
  /** Must independently decode production capture framing and compare native payload/timestamp presence and values. */
  verify(expected: StreamingMemberDescriptor, signal?: AbortSignal): Promise<void>;
  /** Called only after verify and host parser replay succeed; appends bytes exactly once. */
  commit(descriptor: StreamingMemberDescriptor, signal?: AbortSignal): Promise<unknown>;
  discard(): Promise<void>;
}
export interface LiveParserReplayEvidence {
  readonly sourceFrameCount: number;
  readonly parsedFrameCount: number;
  readonly nullFrameCount: number;
  readonly orderedTelemetryDigest: string;
}
export interface StreamingSplitterHost {
  createStage(kind: StreamingMemberKind, id: string): Promise<StreamingMemberStage>;
  createPositionSpool?(): Promise<StreamingPositionSpool>;
  /** Release unclaimed prepared resources; safe to call repeatedly. */
  dispose?(): Promise<void>;
  finalizeWindow?(lap: LapWindow): void;
  discardCandidate?(candidateId: string): void;
  /** Host-bound replay; receives opaque checkpoint and verified stage, never crosses worker protocol as a function. */
  replayParser?(stage: StreamingMemberStage, lap: LapWindow, evidence?: LiveParserReplayEvidence, signal?: AbortSignal): Promise<void>;
  replayEvidence?(lap: LapWindow): LiveParserReplayEvidence | undefined;
  readonly maxQueuedBytes: number;
  readonly maxUnresolvedBytes: number;
  readonly auxiliaryMemberBytes?: number;
}
export interface StreamingSplitterOptions {
  readonly gameId: GameId;
  readonly host: StreamingSplitterHost;
  readonly sourceRecord?: (record: SessionCaptureRecord) => void;
  readonly signal?: AbortSignal;
  readonly onCommitted?: (descriptor: StreamingMemberDescriptor, result: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

