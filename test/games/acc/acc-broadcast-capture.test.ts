import { expect, test } from "bun:test";
import {
  ACC_BROADCAST_CAPTURE_MAGIC,
  ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES,
  AccBroadcastCaptureBuffer,
  decodeAccBroadcastCaptureRecord,
  encodeAccBroadcastCaptureRecord,
} from "../../../server/games/acc/broadcast-capture";

const decode = (record: Buffer) => decodeAccBroadcastCaptureRecord(record.subarray(8));

test("encodes canonical ACCB envelope and ordered raw and lifecycle evidence", () => {
  const batch = {
    frameReceivedAtMs: 1002,
    events: [
      { sequence: 0, receivedAtMs: 1000, kind: "socket-open" as const, payload: Buffer.alloc(0) },
      { sequence: 1, receivedAtMs: 1001, kind: "datagram" as const, payload: Buffer.from([255, 7]) },
    ],
  };
  const record = encodeAccBroadcastCaptureRecord(batch);
  expect(record.readUInt32LE(0)).toBe(0xffffffff);
  expect(record.readUInt32LE(4)).toBe(record.length - 8);
  expect(record.readUInt32LE(8)).toBe(ACC_BROADCAST_CAPTURE_MAGIC);
  expect(record.readUInt32LE(12)).toBe(1);
  expect(record.readDoubleLE(16)).toBe(1002);
  expect(record.readUInt32LE(24)).toBe(2);
  expect(decode(record)).toEqual(batch);
});

test("prepare defers encoding, preserves cursor boundary and acknowledges only recorded events", () => {
  const capture = new AccBroadcastCaptureBuffer();
  const raw = Buffer.from([1, 2]);
  capture.recordDatagram(raw, 10);
  const first = capture.prepare(11);
  raw[0] = 9;
  capture.recordLifecycle("socket-close", 12);
  const encoded = capture.encode(first);
  expect(decode(encoded).events).toEqual([{ sequence: 0, receivedAtMs: 10, kind: "datagram", payload: Buffer.from([1, 2]) }]);
  expect(capture.encode(first)).toEqual(encoded); // Session rotation can persist the same cursor twice.
  capture.acknowledge(first);
  const next = capture.prepare(13);
  expect(decode(capture.encode(next)).events).toEqual([{ sequence: 1, receivedAtMs: 12, kind: "socket-close", payload: Buffer.alloc(0) }]);
  capture.acknowledge(next);
  expect(decode(capture.encode(capture.prepare(14)))).toEqual({ frameReceivedAtMs: 14, events: [] });
});

test("pending byte cap includes retained event headers after acknowledging an older cursor", () => {
  const capture = new AccBroadcastCaptureBuffer();
  capture.recordLifecycle("socket-open", 0);
  const old = capture.prepare(0);
  capture.recordLifecycle("socket-close", 1);
  capture.acknowledge(old);
  expect(capture.recordDatagram(Buffer.alloc(ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES - 34), 2).overflowed).toBe(false);
  expect(capture.recordLifecycle("socket-error", 3).overflowed).toBe(true);
  const marker = capture.prepare(3);
  expect(decode(capture.encode(marker)).events).toEqual([
    { sequence: 3, receivedAtMs: 3, kind: "socket-error", payload: Buffer.alloc(0) },
    { sequence: 4, receivedAtMs: 3, kind: "queue-overflow", payload: Buffer.alloc(0) },
  ]);
  expect(capture.recordDatagram(Buffer.from([1]), 4).overflowed).toBe(false);
  capture.acknowledge(marker);
  expect(decode(capture.encode(capture.prepare(5))).events).toEqual([{ sequence: 5, receivedAtMs: 4, kind: "datagram", payload: Buffer.from([1]) }]);
});

test("rejects malformed capture timestamps, lifecycle payloads and truncated layouts", () => {
  const base = encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 10, events: [
    { sequence: 1, receivedAtMs: 9, kind: "socket-open", payload: Buffer.alloc(0) },
  ] }).subarray(8);
  for (const invalid of [NaN, Infinity, -1]) {
    const frame = Buffer.from(base);
    frame.writeDoubleLE(invalid, 8);
    expect(() => decodeAccBroadcastCaptureRecord(frame)).toThrow();
    const event = Buffer.from(base);
    event.writeDoubleLE(invalid, 24);
    expect(() => decodeAccBroadcastCaptureRecord(event)).toThrow();
  }
  const futureEvent = Buffer.from(base);
  futureEvent.writeDoubleLE(11, 24);
  expect(() => decodeAccBroadcastCaptureRecord(futureEvent)).toThrow();
  const badLifecycle = encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 10, events: [
    { sequence: 1, receivedAtMs: 9, kind: "socket-close", payload: Buffer.from([1]) },
  ] });
  expect(() => decode(badLifecycle)).toThrow();
  const unknownKind = Buffer.from(base);
  unknownKind[32] = 99;
  expect(() => decodeAccBroadcastCaptureRecord(unknownKind)).toThrow();
  expect(() => decodeAccBroadcastCaptureRecord(base.subarray(0, base.length - 1))).toThrow();
  expect(() => decodeAccBroadcastCaptureRecord(Buffer.concat([base, Buffer.from([0])]))).toThrow();
});
