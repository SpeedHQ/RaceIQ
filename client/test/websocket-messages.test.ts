import { describe, expect, it } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { handleWebSocketMessage } from "../src/lib/websocket-messages";
import { useDevTelemetryStore } from "../src/stores/dev-telemetry";
import { useTelemetryStore } from "../src/stores/telemetry";

const schema = { type: "telemetry-schema", protocolVersion: 1, schemaId: "s", simulator: "acc", catalogVersion: "c", catalogHash: "h", catalogSchemaVersion: "1", parserVersion: "p", resolverVersion: "r", derivationVersion: "d", definitions: [] } as const;
const packet = { gameId: "acc", TimestampMS: 1 } as unknown as TelemetryPacket;
describe("websocket message router", () => {
  it("routes canonical schema/frame to production store", () => {
    useTelemetryStore.getState().clearTelemetry();
    handleWebSocketMessage(schema);
    expect(useTelemetryStore.getState().telemetrySchema?.schemaId).toBe("s");
    expect(handleWebSocketMessage({ type: "telemetry-frame", protocolVersion: 1, schemaId: "s", streamId: "x", sessionId: null, sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, receivedAtMs: 1, values: [] })).toBe(true);
    expect(useTelemetryStore.getState().telemetryFrame?.sequence).toBe(1);
  });
  it("keeps current live view when server repeats its schema", () => {
    useTelemetryStore.getState().clearTelemetry();
    handleWebSocketMessage(schema);
    handleWebSocketMessage({ type: "telemetry-frame", protocolVersion: 1, schemaId: "s", streamId: "x", sessionId: null, sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, receivedAtMs: 1, values: [] });
    const frame = useTelemetryStore.getState().telemetryFrame;
    const view = useTelemetryStore.getState().telemetryView;
    handleWebSocketMessage(schema);
    expect(useTelemetryStore.getState().telemetryFrame).toBe(frame);
    expect(useTelemetryStore.getState().telemetryView).toBe(view);
  });
  it("routes dev packets only to isolated dev store and ignores legacy packets", () => {
    useDevTelemetryStore.getState().clear();
    useTelemetryStore.getState().clearTelemetry();
    handleWebSocketMessage({ gameId: "acc", TimestampMS: 1 });
    expect(useDevTelemetryStore.getState().packet).toBeNull();
    handleWebSocketMessage({ type: "dev-telemetry", protocolVersion: 1, packet });
    expect(useDevTelemetryStore.getState().packet).toEqual(packet);
    expect(useTelemetryStore.getState().telemetryFrame).toBeNull();
  });
});
