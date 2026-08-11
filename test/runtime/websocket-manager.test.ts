import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { WebSocketManager, type WSData } from "../../server/runtime/websocket-manager";

function socket() {
  const sent: string[] = [];
  return { data: { createdAt: Date.now(), devTelemetrySubscribed: false } satisfies WSData, sent, send: (value: string) => { sent.push(value); }, close() {} } as unknown as ServerWebSocket<WSData> & { sent: string[] };
}

describe("WebSocketManager controls", () => {
  test("malformed control is rejected without subscription", () => {
    const manager = new WebSocketManager(); const ws = socket();
    manager.handleMessage(ws, "not-json");
    expect(ws.data.devTelemetrySubscribed).toBe(false);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).error).toBe("invalid-message");
  });
});
