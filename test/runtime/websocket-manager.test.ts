import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { WebSocketManager, type WSData } from "../../server/runtime/websocket-manager";
import type { LiveProjection } from "../../server/telemetry/live-projector";

function socket() {
  const sent: string[] = [];
  return { data: { createdAt: Date.now(), devTelemetrySubscribed: false } satisfies WSData, sent, send: (value: string) => { sent.push(value); }, close() {} } as unknown as ServerWebSocket<WSData> & { sent: string[] };
}

const schema = { type: "telemetry-schema", protocolVersion: 1, schemaId: "schema-1", simulator: "iracing", catalogVersion: "catalog", catalogHash: "hash", catalogSchemaVersion: "1", parserVersion: "parser", resolverVersion: "resolver", derivationVersion: "derivation", definitions: [] } as const satisfies NonNullable<LiveProjection["schema"]>;
const frame = { type: "telemetry-frame", protocolVersion: 1, schemaId: schema.schemaId, streamId: "stream-1", sessionId: 1, sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, receivedAtMs: 1, values: [], context: {} } as const satisfies NonNullable<LiveProjection["frame"]>;
const semanticFrame = { simulator: "iracing", sessionId: 1, streamId: "stream-1", sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, ids: [], values: [] } as const satisfies NonNullable<LiveProjection["semanticFrame"]>;

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
    manager.publishTelemetry({ schema, frame, semanticFrame });
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
});
