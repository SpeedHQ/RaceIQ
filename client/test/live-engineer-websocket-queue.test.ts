import { expect, test } from "bun:test";
import { flushLiveEngineerOutbound } from "../src/hooks/useWebSocket";
import { useLiveEngineerStore } from "../src/stores/live-engineer";

const status = (deliveryId: string) => ({ type: "live-engineer-delivery-status" as const, protocolVersion: 2 as const, deliveryId, status: "completed" as const });
const reset = () => useLiveEngineerStore.setState({ outbound: [] });
const ids = () => useLiveEngineerStore.getState().outbound.map((x) => "deliveryId" in x ? x.deliveryId : "");
const open = () => (globalThis.WebSocket as typeof WebSocket).OPEN;

test("closed socket preserves outbound FIFO", () => {
  reset();
  useLiveEngineerStore.getState().enqueueControl(status("a"));
  const socket = { readyState: 3 as WebSocket["readyState"], send: () => { throw new Error("closed"); } };
  flushLiveEngineerOutbound(socket);
  expect(ids()).toEqual(["a"]);
});

test("reconnect flushes outbound FIFO and dequeues after each send", () => {
  reset();
  useLiveEngineerStore.getState().enqueueControl(status("a"));
  useLiveEngineerStore.getState().enqueueControl(status("b"));
  const sent: string[] = [];
  const socket = { readyState: open(), send: (message: string) => sent.push(JSON.parse(message).deliveryId) };
  flushLiveEngineerOutbound(socket);
  expect(sent).toEqual(["a", "b"]);
  expect(useLiveEngineerStore.getState().outbound).toHaveLength(0);
});

test("send failure retains current outbound head", () => {
  reset();
  useLiveEngineerStore.getState().enqueueControl(status("a"));
  useLiveEngineerStore.getState().enqueueControl(status("b"));
  const socket = { readyState: open(), send: () => { throw new Error("send failed"); } };
  flushLiveEngineerOutbound(socket);
  expect(ids()).toEqual(["a", "b"]);
});

test("socket closing after send retains current outbound head", () => {
  reset();
  useLiveEngineerStore.getState().enqueueControl(status("a"));
  const socket: { readyState: WebSocket["readyState"]; send: () => void } = { readyState: open(), send: () => { socket.readyState = 3; } };
  flushLiveEngineerOutbound(socket);
  expect(ids()).toEqual(["a"]);
});
