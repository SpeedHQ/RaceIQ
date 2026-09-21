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

export function encodeAccBroadcastCaptureRecord(batch: AccBroadcastCaptureBatch): Buffer {
  const payloadBytes = 20 + batch.events.reduce((sum, event) => sum + 17 + event.payload.length, 0);
  const payload = Buffer.allocUnsafe(payloadBytes);
  let at = 0;
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
  const envelope = Buffer.allocUnsafe(8 + payload.length);
  envelope.writeUInt32LE(META_FRAME_MAGIC, 0);
  envelope.writeUInt32LE(payload.length, 4);
  payload.copy(envelope, 8);
  return envelope;
}

export function decodeAccBroadcastCaptureRecord(bytes: Uint8Array): AccBroadcastCaptureBatch {
  const data = Buffer.from(bytes);
  if (data.length < 20 || data.readUInt32LE(0) !== ACC_BROADCAST_CAPTURE_MAGIC) throw new Error("invalid ACCB magic");
  if (data.readUInt32LE(4) !== ACC_BROADCAST_CAPTURE_VERSION) throw new Error("unsupported ACCB version");
  const frameReceivedAtMs = data.readDoubleLE(8);
  const count = data.readUInt32LE(16);
  let at = 20;
  const events: AccBroadcastCaptureEvent[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 17 > data.length) throw new Error("truncated ACCB event");
    const sequence = data.readUInt32LE(at); at += 4;
    const receivedAtMs = data.readDoubleLE(at); at += 8;
    const kind = KIND_BY_CODE[data.readUInt8(at++)];
    const length = data.readUInt32LE(at); at += 4;
    if (!kind || at + length > data.length) throw new Error("invalid ACCB event");
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
  private overflowed = false;
  recordDatagram(payload: Uint8Array, receivedAtMs: number): { overflowed: boolean } { return this.record("datagram", Buffer.from(payload), receivedAtMs); }
  recordLifecycle(kind: Exclude<AccBroadcastCaptureEventKind, "datagram">, receivedAtMs: number): { overflowed: boolean } { return this.record(kind, Buffer.alloc(0), receivedAtMs); }
  prepare(frameReceivedAtMs: number): AccBroadcastCaptureCursor { return { sequence: this.nextSequence, frameReceivedAtMs }; }
  encode(cursor: AccBroadcastCaptureCursor): Buffer {
    const events = this.events.filter((event) => event.sequence < cursor.sequence);
    return encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: cursor.frameReceivedAtMs, events });
  }
  acknowledge(cursor: AccBroadcastCaptureCursor): void {
    const kept = this.events.filter((event) => event.sequence >= cursor.sequence);
    this.events = kept;
    this.pendingBytes = kept.reduce((sum, event) => sum + event.payload.length, 0);
    this.overflowed = false;
  }
  private record(kind: AccBroadcastCaptureEventKind, payload: Buffer, receivedAtMs: number): { overflowed: boolean } {
    const bytes = payload.length + 17;
    if (this.pendingBytes + bytes > ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES) {
      this.events = [{ sequence: this.nextSequence++, receivedAtMs, kind: "queue-overflow", payload: Buffer.alloc(0) }];
      this.pendingBytes = 17;
      this.overflowed = true;
      return { overflowed: true };
    }
    this.events.push({ sequence: this.nextSequence++, receivedAtMs, kind, payload });
    this.pendingBytes += bytes;
    return { overflowed: this.overflowed };
  }
}
export const accBroadcastCapture = new AccBroadcastCaptureBuffer();
