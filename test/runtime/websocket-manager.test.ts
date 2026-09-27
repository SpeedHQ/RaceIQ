import { describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { WebSocketManager, type WSData } from "../../server/runtime/websocket-manager";
import type { LiveProjection } from "../../server/telemetry/live-projector";
import type { LiveSectorData } from "../../shared/racing/live/types";

function socket(send: (value: string) => void = () => {}) {
  const sent: string[] = [];
  return { data: { createdAt: Date.now(), devTelemetrySubscribed: false } satisfies WSData, sent, send: (value: string) => { sent.push(value); send(value); }, close() {} } as unknown as ServerWebSocket<WSData> & { sent: string[] };
}

const schema = { type: "telemetry-schema", protocolVersion: 1, schemaId: "schema-1", simulator: "iracing", catalogVersion: "catalog", catalogHash: "hash", catalogSchemaVersion: "1", parserVersion: "parser", resolverVersion: "resolver", derivationVersion: "derivation", definitions: [] } as const satisfies NonNullable<LiveProjection["schema"]>;
const frame = { type: "telemetry-frame", protocolVersion: 1, schemaId: schema.schemaId, streamId: "stream-1", sessionId: 1, sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, receivedAtMs: 1, values: [], context: {} } as const satisfies NonNullable<LiveProjection["frame"]>;

describe("WebSocketManager controls", () => {
  test("malformed control is rejected without subscription", () => {
    const manager = new WebSocketManager(); const ws = socket();
    manager.handleMessage(ws, "not-json");
    expect(ws.data.devTelemetrySubscribed).toBe(false);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).error).toBe("invalid-message");
  });

  test("broadcasts source rate and sends schemas only when they change", () => {
    const manager = new WebSocketManager(); const ws = socket();
    manager.publishTelemetry({ schema, frame });
    manager.addClient(ws);
    expect(ws.sent.map((value) => JSON.parse(value).type)).toEqual(["telemetry-schema", "telemetry-frame"]);

    ws.sent.length = 0;
    manager.flushLatest();
    expect(ws.sent.map((value) => JSON.parse(value).type)).toEqual(["telemetry-frame"]);

    ws.sent.length = 0;
    manager.broadcastStatus({ udpPps: 0, telemetryPps: 60, isRaceOn: true, droppedPackets: 0, udpPort: 5301, detectedGame: { id: "iracing", name: "iRacing" }, currentSession: null });
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({ type: "status", telemetryPps: 60 });
    manager.removeClient(ws);
  });

  test("removes clients whose transport fails during status broadcast", () => {
    const manager = new WebSocketManager();
    const ws = socket(() => { throw new Error("socket closed"); });

    manager.addClient(ws);
    manager.broadcastStatus({ udpPps: 0, telemetryPps: 0, isRaceOn: false, droppedPackets: 0, udpPort: 5301, detectedGame: null, currentSession: null });

    expect(manager.connectedClients).toBe(0);
  });

  test("ignores duplicate disconnect callbacks", () => {
    const manager = new WebSocketManager();
    const ws = socket();

    manager.addClient(ws);
    manager.removeClient(ws);
    manager.removeClient(ws);

    expect(manager.connectedClients).toBe(0);
  });

  test("samples dev state only for explicit subscribers and releases demand on disconnect", () => {
    const manager = new WebSocketManager();
    const ordinary = socket();
    const debug = socket();
    const clock = spyOn(performance, "now").mockReturnValue(1000);
    try {
      expect(manager.wantsDevState).toBe(false);
      manager.addClient(ordinary);
      manager.addClient(debug);
      expect(manager.wantsDevState).toBe(false);
      manager.broadcastDevState({ packet: 0 });
      expect(ordinary.sent).toEqual([]);
      expect(debug.sent).toEqual([]);

      manager.handleMessage(debug, JSON.stringify({ type: "subscribe", channel: "dev-state" }));
      expect(JSON.parse(debug.sent.pop()!)).toEqual({ type: "subscription", channel: "dev-state", subscribed: true });
      expect(manager.wantsDevState).toBe(true);
      manager.broadcastDevState({ packet: 1 });
      expect(manager.wantsDevState).toBe(false);
      clock.mockReturnValue(1249);
      manager.broadcastDevState({ packet: 2 });
      expect(manager.wantsDevState).toBe(false);
      clock.mockReturnValue(1250);
      expect(manager.wantsDevState).toBe(true);
      manager.broadcastDevState({ packet: 3 });
      expect(ordinary.sent).toEqual([]);
      expect(debug.sent.map((value) => JSON.parse(value))).toEqual([{ type: "dev-state", packet: 1 }, { type: "dev-state", packet: 3 }]);

      manager.handleMessage(debug, JSON.stringify({ type: "unsubscribe", channel: "dev-state" }));
      clock.mockReturnValue(1500);
      expect(manager.wantsDevState).toBe(false);
      manager.handleMessage(debug, JSON.stringify({ type: "subscribe", channel: "dev-state" }));
      expect(manager.wantsDevState).toBe(true);
      manager.removeClient(debug);
      expect(manager.wantsDevState).toBe(false);
    } finally {
      manager.removeClient(ordinary);
      manager.removeClient(debug);
      clock.mockRestore();
    }
  });

  test("drops failed dev subscribers without leaving snapshot demand", () => {
    const manager = new WebSocketManager();
    const ws = socket((value) => { if (JSON.parse(value).type === "dev-state") throw new Error("socket closed"); });
    const clock = spyOn(performance, "now").mockReturnValue(1000);
    try {
      manager.addClient(ws);
      manager.handleMessage(ws, JSON.stringify({ type: "subscribe", channel: "dev-state" }));
      manager.broadcastDevState({ packet: 1 });
      clock.mockReturnValue(2000);
      expect(manager.connectedClients).toBe(0);
      expect(manager.wantsDevState).toBe(false);
    } finally {
      manager.removeClient(ws);
      clock.mockRestore();
    }
  });

  test("coalesces unsent frames and serializes each latest frame once across clients", () => {
    const manager = new WebSocketManager();
    const first = socket();
    const second = socket();
    const stringify = spyOn(JSON, "stringify");
    try {
      manager.publishTelemetry({ schema, frame });
      manager.publishTelemetry({ frame: { ...frame, sequence: 2 } });
      manager.flushLatest();
      expect(stringify.mock.calls.filter(([value]) => value?.type === "telemetry-frame")).toHaveLength(0);
      manager.addClient(first);
      expect(first.sent.map((value) => JSON.parse(value))).toEqual([schema, { ...frame, sequence: 2 }]);
      manager.addClient(second);
      manager.flushLatest();
      expect(stringify.mock.calls.filter(([value]) => value?.type === "telemetry-frame")).toHaveLength(1);

      first.sent.length = 0;
      second.sent.length = 0;
      manager.publishTelemetry({ frame: { ...frame, sequence: 3 } });
      manager.publishTelemetry({ frame: { ...frame, sequence: 4 } });
      manager.flushLatest();
      expect(first.sent.map((value) => JSON.parse(value))).toEqual([{ ...frame, sequence: 4 }]);
      expect(second.sent).toEqual(first.sent);
      expect(stringify.mock.calls.filter(([value]) => value?.type === "telemetry-frame")).toHaveLength(2);
    } finally {
      manager.removeClient(first);
      manager.removeClient(second);
      stringify.mockRestore();
    }
  });

  test("sends the latest schema before its frame to existing and connecting clients", () => {
    const manager = new WebSocketManager();
    const existing = socket();
    const connecting = socket();
    try {
      manager.publishTelemetry({ schema, frame });
      manager.addClient(existing);
      existing.sent.length = 0;
      const nextSchema = { ...schema, schemaId: "schema-2", simulator: "acc" as const };
      const nextFrame = { ...frame, schemaId: nextSchema.schemaId, streamId: "stream-2", sequence: 0 };
      manager.publishTelemetry({ schema: nextSchema, frame: nextFrame });
      manager.addClient(connecting);
      manager.flushLatest();
      expect(existing.sent.map((value) => JSON.parse(value))).toEqual([nextSchema, nextFrame]);
      expect(connecting.sent.slice(0, 2).map((value) => JSON.parse(value))).toEqual([nextSchema, nextFrame]);
    } finally {
      manager.removeClient(existing);
      manager.removeClient(connecting);
    }
  });

  test("detaches mutable race context before deferred publication", () => {
    const manager = new WebSocketManager();
    const ws = socket();
    const sectors: LiveSectorData = { sectorCount: 3, currentSector: 1, currentSectorTime: 10, currentTimes: [10], lastTimes: [20], bestTimes: [19], lastLapTime: 60, bestLapTime: 59, estimatedLap: 61, deltaToBest: 2, deltaToLast: 1 };
    try {
      manager.publishTelemetry({ schema, frame: { ...frame, context: { sectors } } });
      sectors.currentSector = 2;
      sectors.currentTimes[0] = 99;
      manager.addClient(ws);
      const received = JSON.parse(ws.sent[1]);
      expect(received.context.sectors.currentSector).toBe(1);
      expect(received.context.sectors.currentTimes).toEqual([10]);
    } finally {
      manager.removeClient(ws);
    }
  });

  test("does not replay a disconnected stream's pending schema after reconnect", () => {
    const manager = new WebSocketManager();
    const previous = socket();
    const reconnected = socket();
    try {
      manager.addClient(previous);
      manager.publishTelemetry({ schema, frame });
      manager.removeClient(previous);
      const nextSchema = { ...schema, schemaId: "schema-2", simulator: "acc" as const };
      const nextFrame = { ...frame, schemaId: nextSchema.schemaId, streamId: "stream-2", sequence: 0 };
      manager.publishTelemetry({ schema: nextSchema, frame: nextFrame });
      manager.addClient(reconnected);
      manager.flushLatest();
      expect(reconnected.sent.map((value) => JSON.parse(value))).toEqual([nextSchema, nextFrame, nextFrame]);
    } finally {
      manager.removeClient(previous);
      manager.removeClient(reconnected);
    }
  });
});
