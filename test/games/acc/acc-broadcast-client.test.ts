import { expect, test } from "bun:test";
import { AccBroadcastClient } from "../../../server/games/acc/broadcast-client";
import { AccBroadcastState } from "../../../server/games/acc/broadcast-state";

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
