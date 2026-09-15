import { describe, expect, it } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LiveSectorData } from "../../shared/racing/live/types";
import { handleWebSocketMessage } from "../src/lib/websocket-messages";
import { devTelemetryStore, useDevTelemetryStore } from "../src/stores/dev-telemetry";
import { telemetryStore, useTelemetryStore } from "../src/stores/telemetry";
const schema = { type: "telemetry-schema", protocolVersion: 1, schemaId: "s", simulator: "acc", catalogVersion: "c", catalogHash: "h", catalogSchemaVersion: "1", parserVersion: "p", resolverVersion: "r", derivationVersion: "d", definitions: [] } as const;
const packet = { gameId: "acc", TimestampMS: 1 } as unknown as TelemetryPacket;
describe("websocket message router", () => {
  it("routes canonical schema/frame to production store", () => {
    telemetryStore.actions.clearTelemetry();
    handleWebSocketMessage(schema);
    expect(telemetryStore.get().telemetrySchema?.schemaId).toBe("s");
    expect(handleWebSocketMessage({ type: "telemetry-frame", protocolVersion: 1, schemaId: "s", streamId: "x", sessionId: null, sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, receivedAtMs: 1, values: [], context: { sectors: { sectorCount: 3, currentSector: 2, currentSectorTime: 30, currentTimes: [], lastTimes: [], bestTimes: [], lastLapTime: 94, bestLapTime: 92, estimatedLap: 93.5, deltaToBest: -0.523, deltaToLast: 0 } satisfies LiveSectorData } })).toBe(true);
    expect(telemetryStore.get().telemetryFrame?.sequence).toBe(1);
    expect(telemetryStore.get().sectors?.estimatedLap).toBe(93.5);
    expect(telemetryStore.get().sectors?.deltaToBest).toBe(-0.523);
    expect(handleWebSocketMessage({ type: "telemetry-frame", protocolVersion: 1, schemaId: "s", streamId: "x", sessionId: null, sequence: 2, observedAt: { domain: "session", milliseconds: 2 }, receivedAtMs: 2, values: [], context: {} })).toBe(true);
    expect(telemetryStore.get().sectors).toBeNull();
    expect(telemetryStore.get().telemetryFrame?.sequence).toBe(2);
  });
  it("keeps current live view when server repeats its schema", () => {
    telemetryStore.actions.clearTelemetry();
    handleWebSocketMessage(schema);
    handleWebSocketMessage({ type: "telemetry-frame", protocolVersion: 1, schemaId: "s", streamId: "x", sessionId: null, sequence: 1, observedAt: { domain: "session", milliseconds: 1 }, receivedAtMs: 1, values: [], context: {} });
    const frame = telemetryStore.get().telemetryFrame;
    const view = telemetryStore.get().telemetryView;
    handleWebSocketMessage(schema);
    expect(telemetryStore.get().telemetryFrame).toBe(frame);
    expect(telemetryStore.get().telemetryView).toBe(view);
  });
  it("routes dev packets only to isolated dev store and ignores legacy packets", () => {
    devTelemetryStore.actions.clear();
    telemetryStore.actions.clearTelemetry();
    handleWebSocketMessage({ gameId: "acc", TimestampMS: 1 });
    expect(devTelemetryStore.get().packet).toBeNull();
    handleWebSocketMessage({ type: "dev-telemetry", protocolVersion: 1, packet });
    expect(devTelemetryStore.get().packet).toEqual(packet);
    expect(telemetryStore.get().telemetryFrame).toBeNull();
  });
});
