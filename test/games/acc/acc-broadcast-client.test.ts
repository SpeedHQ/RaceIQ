import { expect, test } from "bun:test";
import { AccBroadcastClient } from "../../../server/games/acc/broadcast-client";
import { AccBroadcastState } from "../../../server/games/acc/broadcast-state";
import { ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES, AccBroadcastCaptureBuffer, decodeAccBroadcastCaptureRecord } from "../../../server/games/acc/broadcast-capture";
import { parseAccBroadcastMessage } from "../../../server/games/acc/broadcast-protocol";

const realtimeCarUpdate = (carIndex: number): Buffer => {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint8(offset++, 3);
  view.setUint16(offset, carIndex, true); offset += 2;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint8(offset++, 1);
  view.setUint8(offset++, 4);
  for (const value of [0, 0, 0]) { view.setFloat32(offset, value, true); offset += 4; }
  view.setUint8(offset++, 1);
  for (const value of [100, 1, 1, 0]) { view.setUint16(offset, value, true); offset += 2; }
  view.setFloat32(offset, 0.5, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setInt32(offset, 0, true); offset += 4;
  for (const lapTime of [90_000, 90_000, 30_000]) {
    view.setInt32(offset, lapTime, true); offset += 4;
    view.setUint16(offset, carIndex, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    for (let i = 0; i < 5; i += 1) view.setUint8(offset++, 0);
  }
  return Buffer.from(bytes);
};

function completeGridDatagrams(): Buffer[] {
  const session = Buffer.alloc(48); // SDK v4 header, time/weather, empty best lap.
  session[0] = 2;
  session.writeUInt16LE(2, 3);
  session[5] = 10;
  session[6] = 5;
  session.writeInt32LE(7, 15);
  session.writeInt32LE(0x7fffffff, 35);
  const identity = Buffer.alloc(30);
  identity[0] = 6;
  identity.writeUInt16LE(7, 1);
  identity[3] = 1;
  identity.writeInt32LE(7, 6);
  identity[14] = 1;
  identity.writeUInt16LE(6, 17);
  identity.write("Driver", 19);
  return [session, Buffer.from([4, 42, 0, 0, 0, 1, 0, 7, 0]), identity, realtimeCarUpdate(7)];
}

test("registers ACC broadcast client and applies inbound messages", async () => {
  const sent: Uint8Array[] = [];
  let onMessage: ((message: Buffer) => void) | undefined;
  let closed = false;
  const socket = {
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: (message: Uint8Array) => sent.push(message),
    on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
    close: (callback?: () => void) => { closed = true; callback?.(); },
  };
  const state = new AccBroadcastState();
  const client = new AccBroadcastClient({ state, socketFactory: () => socket });
  await client.start();
  await client.start();
  expect(sent).toHaveLength(2);
  expect(sent[0]?.[0]).toBe(1);
  onMessage?.(Buffer.from([255]));
  await client.stop();
  expect(closed).toBe(true);
});
test("requests ACC entry list after successful registration", async () => {
  const sent: Uint8Array[] = [];
  let onMessage: ((message: Buffer) => void) | undefined;
  const socket = {
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: (message: Uint8Array) => sent.push(message),
    on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
    close: (callback?: () => void) => callback?.(),
  };
  const client = new AccBroadcastClient({ state: new AccBroadcastState(), socketFactory: () => socket });
  await client.start();
  const result = new Uint8Array([1, 42, 0, 0, 0, 1, 0, 0, 0]);
  onMessage?.(Buffer.from(result));
  expect(sent.some((datagram) => datagram[0] === 10 && new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength).getInt32(1, true) === 42)).toBe(true);
  await client.stop();
});

test("re-requests ACC entry list once when realtime data references an unknown car", async () => {
  const sent: Uint8Array[] = [];
  let onMessage: ((message: Buffer) => void) | undefined;
  let now = 0;
  const socket = {
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: (message: Uint8Array) => sent.push(message),
    on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
    close: (callback?: () => void) => callback?.(),
  };
  const client = new AccBroadcastClient({ state: new AccBroadcastState(), socketFactory: () => socket, now: () => now } as never);
  await client.start();
  onMessage?.(Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]));
  const requests = () => sent.filter((datagram) => datagram[0] === 10).length;
  expect(requests()).toBe(1);
  now = 2_000;
  onMessage?.(realtimeCarUpdate(7));
  onMessage?.(realtimeCarUpdate(7));
  expect(requests()).toBe(2);
  await client.stop();
});

test("does not request ACC entry list after failed registration", async () => {
  const sent: Uint8Array[] = [];
  let onMessage: ((message: Buffer) => void) | undefined;
  const socket = {
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: (message: Uint8Array) => sent.push(message),
    on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
    close: (callback?: () => void) => callback?.(),
  };
  const client = new AccBroadcastClient({ state: new AccBroadcastState(), socketFactory: () => socket });
  await client.start();
  onMessage?.(Buffer.from([1, 42, 0, 0, 0, 0, 0, 0, 0]));
  expect(sent).toHaveLength(1);
  await client.stop();
});

test("malformed and overflow evidence request throttled recovery and retain raw capture", async () => {
  const sent: Uint8Array[] = [];
  let onMessage: ((message: Buffer) => void) | undefined;
  let now = 0;
  const socket = {
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: (message: Uint8Array) => sent.push(message),
    on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
    close: (callback?: () => void) => callback?.(),
  };
  const state = new AccBroadcastState({ now: () => now });
  const capture = new AccBroadcastCaptureBuffer();
  const client = new AccBroadcastClient({ state, capture, socketFactory: () => socket, now: () => now });
  await client.start();
  onMessage?.(Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]));
  now = 1_001;
  onMessage?.(Buffer.from([255]));
  onMessage?.(Buffer.from([255]));
  expect(state.snapshot().source.reasonCode).toBe("malformed-datagram");
  expect(sent.filter((datagram) => datagram[0] === 10)).toHaveLength(2);
  const malformed = capture.prepare(now);
  expect(decodeAccBroadcastCaptureRecord(capture.encode(malformed).subarray(8)).events.map((event) => event.payload)).toEqual([
    Buffer.alloc(0), Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]), Buffer.from([255]), Buffer.from([255]),
  ]);
  capture.acknowledge(malformed);
  capture.recordDatagram(Buffer.alloc(ACC_BROADCAST_CAPTURE_MAX_PENDING_BYTES - 17), now);
  now = 2_002;
  onMessage?.(realtimeCarUpdate(7));
  expect(state.snapshot().source.reasonCode).toBe("capture-overflow");
  expect(sent.filter((datagram) => datagram[0] === 10)).toHaveLength(3);
  const overflow = decodeAccBroadcastCaptureRecord(capture.encode(capture.prepare(now)).subarray(8));
  expect(overflow.events.map((event) => event.kind)).toEqual(["queue-overflow", "socket-close"]);
  await client.start(); // Native supervisor calls start every poll while ACC runs.
  expect(sent.filter((datagram) => datagram[0] === 1)).toHaveLength(2);
  onMessage?.(Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]));
  expect(decodeAccBroadcastCaptureRecord(capture.encode(capture.prepare(now)).subarray(8)).events.map((event) => event.kind))
    .toEqual(["queue-overflow", "socket-close", "socket-open", "datagram"]);
  expect(state.snapshot().source.reasonCode).toBe("capture-overflow");
  for (const raw of completeGridDatagrams()) onMessage?.(raw);
  expect(state.snapshot().source.state).toBe("available");
  const replay = new AccBroadcastState({ now: () => now });
  for (const event of decodeAccBroadcastCaptureRecord(capture.encode(capture.prepare(now)).subarray(8)).events) {
    if (event.kind === "socket-open") replay.setSocketConnected(true);
    else if (event.kind === "socket-close") replay.setSocketConnected(false);
    else if (event.kind === "queue-overflow") replay.markMalformed("capture-overflow");
    else if (event.kind === "datagram") {
      const parsed = parseAccBroadcastMessage(event.payload);
      if (parsed) replay.apply(parsed, event.receivedAtMs);
      else replay.markMalformed();
    }
  }
  expect(replay.snapshot()).toEqual(state.snapshot());
  await client.stop();
});

test("second recording replays acknowledged raw context without restarting the live socket", async () => {
  let now = 1_000;
  let onMessage: ((message: Buffer) => void) | undefined;
  let socketCount = 0;
  const state = new AccBroadcastState({ now: () => now });
  const capture = new AccBroadcastCaptureBuffer();
  const client = new AccBroadcastClient({ state, capture, now: () => now, socketFactory: () => {
    socketCount++;
    return {
      connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
      send: () => {},
      on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
      close: (callback?: () => void) => callback?.(),
    };
  } });
  await client.start();
  onMessage?.(Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]));
  for (const raw of completeGridDatagrams()) onMessage?.(raw);
  const first = capture.prepare(now);
  capture.encode(first);
  capture.acknowledge(first, 7);
  now = 1_100;
  onMessage?.(realtimeCarUpdate(7));
  const second = capture.prepare(now);
  const expected = state.snapshot();
  const prefix = capture.encode(second);
  onMessage?.(Buffer.from([255])); // Later UDP must not leak into the prepared context.
  const baseline = capture.encodeSessionContext(second);
  const replay = new AccBroadcastState({ now: () => second.frameReceivedAtMs });
  for (const record of [...baseline, prefix]) {
    for (const event of decodeAccBroadcastCaptureRecord(record.subarray(8)).events) {
      if (event.kind === "socket-open") replay.setSocketConnected(true);
      else if (event.kind === "socket-close" || event.kind === "socket-error") replay.setSocketConnected(false);
      else if (event.kind === "queue-overflow") replay.markMalformed("capture-overflow");
      else if (event.kind === "datagram") {
        const parsed = parseAccBroadcastMessage(event.payload);
        if (parsed) replay.apply(parsed, event.receivedAtMs);
        else replay.markMalformed();
      }
    }
  }
  replay.setPlayerCarIndex(7);
  expect(replay.snapshot()).toEqual(expected);
  expect(replay.snapshot().source.state).toBe("available");
  expect(socketCount).toBe(1);
  expect(decodeAccBroadcastCaptureRecord(prefix.subarray(8)).events.every((event) => event.kind === "datagram" && event.payload[0] === 3)).toBe(true);

  // Joined failure depends on the retained entry, not just the invalid car byte.
  capture.acknowledge(second, 7);
  const resetCursor = capture.prepare(now);
  capture.acknowledge(resetCursor, 7);
  for (const raw of completeGridDatagrams()) onMessage?.(raw);
  capture.acknowledge(capture.prepare(now), 7);
  const invalid = realtimeCarUpdate(7);
  invalid.writeUInt16LE(1, 3);
  invalid[5] = 2;
  onMessage?.(invalid);
  capture.acknowledge(capture.prepare(now), 7);
  const malformedReplay = new AccBroadcastState({ now: () => now });
  for (const record of capture.encodeSessionContext(capture.prepare(now))) {
    for (const event of decodeAccBroadcastCaptureRecord(record.subarray(8)).events) {
      if (event.kind === "socket-open") malformedReplay.setSocketConnected(true);
      else if (event.kind === "datagram") {
        const parsed = parseAccBroadcastMessage(event.payload);
        if (parsed) malformedReplay.apply(parsed, event.receivedAtMs);
        else malformedReplay.markMalformed();
      }
    }
  }
  expect(malformedReplay.snapshot().source).toEqual({ state: "malformed", reasonCode: "invalid-driver-index" });
  await client.stop();
});

test("old socket callbacks cannot mutate restarted source or enter its capture", async () => {
  const listeners: Record<string, ((message: Buffer) => void)>[] = [];
  const capture = new AccBroadcastCaptureBuffer();
  const state = new AccBroadcastState();
  const client = new AccBroadcastClient({ state, capture, socketFactory: () => {
    const handlers: Record<string, (message: Buffer) => void> = {};
    listeners.push(handlers);
    return {
      connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
      send: () => {},
      on: (event: string, listener: (message: Buffer) => void) => { handlers[event] = listener; },
      close: (callback?: () => void) => callback?.(),
    };
  } });
  await client.start();
  await client.stop();
  await client.start();
  listeners[1]!.message!(Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]));
  listeners[0]!.message!(Buffer.from([255]));
  listeners[0]!.close!(Buffer.alloc(0));
  expect(state.snapshot().source.reasonCode).toBe("no-session");
  const events = decodeAccBroadcastCaptureRecord(capture.encode(capture.prepare(Date.now())).subarray(8)).events;
  expect(events.map((event) => event.kind)).toEqual(["socket-open", "socket-close", "socket-open", "datagram"]);
  await client.stop();
});

test("socket errors clear registration and record lifecycle before shutdown", async () => {
  const handlers: Record<string, (message: Buffer) => void> = {};
  const capture = new AccBroadcastCaptureBuffer();
  const state = new AccBroadcastState();
  const client = new AccBroadcastClient({ state, capture, socketFactory: () => ({
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: () => {},
    on: (event: string, listener: (message: Buffer) => void) => { handlers[event] = listener; },
    close: (callback?: () => void) => callback?.(),
  }) });
  await client.start();
  handlers.message!(Buffer.from([1, 42, 0, 0, 0, 1, 0, 0, 0]));
  handlers.error!(Buffer.alloc(0));
  expect(state.snapshot().source.reasonCode).toBe("not-connected");
  expect(decodeAccBroadcastCaptureRecord(capture.encode(capture.prepare(Date.now())).subarray(8)).events.map((event) => event.kind))
    .toEqual(["socket-open", "datagram", "socket-error", "socket-close"]);
  await client.stop();
});
