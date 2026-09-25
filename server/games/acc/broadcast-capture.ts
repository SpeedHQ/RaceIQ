import { AccBroadcastState } from "./broadcast-state";
import { parseAccBroadcastMessage } from "./broadcast-protocol";

const META_FRAME_MAGIC = 0xffffffff;

export const ACC_BROADCAST_CAPTURE_MAGIC = 0x42434341;
export const ACC_BROADCAST_CAPTURE_VERSION = 1;
export const ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES = 8 * 1024 * 1024;

export type AccBroadcastCaptureEventKind = "datagram" | "socket-open" | "socket-close" | "socket-error" | "explicit-reset" | "queue-overflow";
export type AccBroadcastCaptureEvent = { sequence: number; receivedAtMs: number; kind: AccBroadcastCaptureEventKind; payload: Buffer };
export type AccBroadcastCaptureBatch = { frameReceivedAtMs: number; events: readonly AccBroadcastCaptureEvent[] };
export type AccBroadcastCaptureCursor = { sequence: number; frameReceivedAtMs: number };

const KIND: Record<AccBroadcastCaptureEventKind, number> = { datagram: 1, "socket-open": 2, "socket-close": 3, "socket-error": 4, "explicit-reset": 5, "queue-overflow": 6 };
const KIND_BY_CODE = Object.fromEntries(Object.entries(KIND).map(([name, code]) => [code, name])) as Record<number, AccBroadcastCaptureEventKind>;
const EMPTY_PAYLOAD = Buffer.alloc(0);

export function encodeAccBroadcastCaptureRecord(batch: AccBroadcastCaptureBatch): Buffer {
  const payloadBytes = 20 + batch.events.reduce((sum, event) => sum + 17 + event.payload.length, 0);
  const payload = Buffer.allocUnsafe(8 + payloadBytes);
  payload.writeUInt32LE(META_FRAME_MAGIC, 0);
  payload.writeUInt32LE(payloadBytes, 4);
  let at = 8;
  payload.writeUInt32LE(ACC_BROADCAST_CAPTURE_MAGIC, at); at += 4;
  payload.writeUInt32LE(ACC_BROADCAST_CAPTURE_VERSION, at); at += 4;
  payload.writeDoubleLE(batch.frameReceivedAtMs, at); at += 8;
  payload.writeUInt32LE(batch.events.length, at); at += 4;
  for (const event of batch.events) {
    payload.writeUInt32LE(event.sequence >>> 0, at); at += 4;
    payload.writeDoubleLE(event.receivedAtMs, at); at += 8;
    payload.writeUInt8(KIND[event.kind], at); at += 1;
    payload.writeUInt32LE(event.payload.length, at); at += 4;
    event.payload.copy(payload, at); at += event.payload.length;
  }
  return payload;
}

export function decodeAccBroadcastCaptureRecord(bytes: Uint8Array): AccBroadcastCaptureBatch {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 20 || data.readUInt32LE(0) !== ACC_BROADCAST_CAPTURE_MAGIC) throw new Error("invalid ACCB magic");
  if (data.readUInt32LE(4) !== ACC_BROADCAST_CAPTURE_VERSION) throw new Error("unsupported ACCB version");
  const frameReceivedAtMs = data.readDoubleLE(8);
  if (!Number.isFinite(frameReceivedAtMs) || frameReceivedAtMs < 0) throw new Error("invalid ACCB frame timestamp");
  const count = data.readUInt32LE(16);
  let at = 20;
  const events: AccBroadcastCaptureEvent[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 17 > data.length) throw new Error("truncated ACCB event");
    const sequence = data.readUInt32LE(at); at += 4;
    const receivedAtMs = data.readDoubleLE(at); at += 8;
    if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0 || receivedAtMs > frameReceivedAtMs) throw new Error("invalid ACCB event timestamp");
    const kind = KIND_BY_CODE[data.readUInt8(at++)];
    const length = data.readUInt32LE(at); at += 4;
    if (!kind || at + length > data.length || (kind !== "datagram" && length !== 0)) throw new Error("invalid ACCB event");
    events.push({ sequence, receivedAtMs, kind, payload: Buffer.from(data.subarray(at, at + length)) });
    at += length;
  }
  if (at !== data.length) throw new Error("trailing ACCB bytes");
  return { frameReceivedAtMs, events };
}

export class AccBroadcastCaptureBuffer {
  private events: AccBroadcastCaptureEvent[] = [];
  private pendingBytes = 0;
  private nextSequence = 0;
  private acknowledgedSequence = 0;
  private contextFrameReceivedAtMs = 0;
  private readonly contextState = new AccBroadcastState({ now: () => this.contextFrameReceivedAtMs });
  recordDatagram(payload: Uint8Array, receivedAtMs: number): { overflowed: boolean } { return this.record("datagram", payload, receivedAtMs); }
  recordLifecycle(kind: Exclude<AccBroadcastCaptureEventKind, "datagram">, receivedAtMs: number): { overflowed: boolean } { return this.record(kind, EMPTY_PAYLOAD, receivedAtMs); }
  prepare(frameReceivedAtMs: number): AccBroadcastCaptureCursor { return { sequence: this.nextSequence, frameReceivedAtMs }; }
  encode(cursor: AccBroadcastCaptureCursor): Buffer {
    const events = this.events.filter((event) => event.sequence < cursor.sequence);
    return encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events });
  }
  encodeSessionContext(cursor: AccBroadcastCaptureCursor): readonly Buffer[] {
    if (cursor.sequence < this.acknowledgedSequence) throw new RangeError("ACCB context cursor precedes acknowledged evidence");
    // Only acknowledged facts belong here. Pending events remain in the ordinary
    // prefix, with their original sequence continuity checked independently.
    const events = this.contextState.captureContext();
    const records: Buffer[] = [];
    let batch: AccBroadcastCaptureEvent[] = [];
    let bytes = 20;
    for (const event of events) {
      const eventBytes = 17 + event.payload.length;
      if (batch.length && bytes + eventBytes > ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES) {
        records.push(encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events: batch }));
        batch = [];
        bytes = 20;
      }
      batch.push(event);
      bytes += eventBytes;
    }
    if (batch.length) records.push(encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events: batch }));
    return records;
  }
  acknowledge(cursor: AccBroadcastCaptureCursor, playerCarIndex?: number): void {
    if (cursor.sequence < this.acknowledgedSequence) return;
    for (const event of this.events) {
      if (event.sequence >= cursor.sequence) break;
      switch (event.kind) {
        case "socket-open": this.contextState.setSocketConnected(true, event); break;
        case "socket-close":
        case "socket-error": this.contextState.setSocketConnected(false, event); break;
        case "explicit-reset": this.contextState.reset(event); break;
        case "queue-overflow": this.contextState.markMalformed("capture-overflow", event); break;
        case "datagram": {
          const message = parseAccBroadcastMessage(event.payload);
          if (message) this.contextState.apply(message, event.receivedAtMs, event);
          else this.contextState.markMalformed("malformed-datagram", event);
          break;
        }
      }
    }
    this.acknowledgedSequence = cursor.sequence;
    this.contextFrameReceivedAtMs = cursor.frameReceivedAtMs;
    if (playerCarIndex !== undefined) this.contextState.setPlayerCarIndex(playerCarIndex);
    this.contextState.sourceStatus();
    const kept = this.events.filter((event) => event.sequence >= cursor.sequence);
    this.events = kept;
    this.pendingBytes = kept.reduce((sum, event) => sum + 17 + event.payload.length, 0);
  }
  private record(kind: AccBroadcastCaptureEventKind, payload: Uint8Array, receivedAtMs: number): { overflowed: boolean } {
    const bytes = payload.length + 17;
    if (this.pendingBytes + bytes > ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES) {
      this.events = [];
      // Preserve the triggering socket transition so replay can recover without
      // inferring a connection from later realtime or registration datagrams.
      if (kind !== "datagram" && kind !== "queue-overflow") {
        this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind, payload: EMPTY_PAYLOAD });
      }
      this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind: "queue-overflow", payload: EMPTY_PAYLOAD });
      this.pendingBytes = this.events.length * 17;
      return { overflowed: true };
    }
    this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind, payload: kind === "datagram" ? Buffer.from(payload) : EMPTY_PAYLOAD });
    this.pendingBytes += bytes;
    return { overflowed: false };
  }
}
export const accBroadcastCapture = new AccBroadcastCaptureBuffer();
