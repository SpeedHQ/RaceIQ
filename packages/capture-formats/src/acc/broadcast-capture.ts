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
