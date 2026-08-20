import { describe, expect, test } from "bun:test";
import { LiveTelemetryProjector } from "../../server/telemetry/live-projector";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const packet = (gameId: string, speed = 12): TelemetryPacket => ({ gameId, TimestampMS: 1000, Speed: speed } as TelemetryPacket);

describe("LiveTelemetryProjector", () => {
  test("lifecycle emits schema once and increments sequence", () => {
    const projector = new LiveTelemetryProjector();
    const first = projector.project({ packet: packet("acc"), sessionId: 7, receivedAtMs: 1100 });
    const second = projector.project({ packet: packet("acc", 13), sessionId: 7, receivedAtMs: 1200 });
    expect(first.schema).toBeDefined();
    expect(first.frame?.sequence).toBe(0);
    expect(second.schema).toBeUndefined();
    expect(second.frame?.sequence).toBe(1);
    expect(second.frame?.streamId).toBe(first.frame?.streamId);
    expect(first.schema?.definitions.every((definition) => Array.isArray(definition.limitations) && definition.limitations.every((limitation) => typeof limitation === "string"))).toBe(true);
  });

  test("game/session mutation starts fresh stream", () => {
    const projector = new LiveTelemetryProjector();
    const first = projector.project({ packet: packet("acc"), sessionId: 1, receivedAtMs: 1000 });
    const changed = projector.project({ packet: packet("f1-2025"), sessionId: 2, receivedAtMs: 1000 });
    expect(changed.schema).toBeDefined();
    expect(changed.frame?.sequence).toBe(0);
    expect(changed.frame?.streamId).not.toBe(first.frame?.streamId);
  });

  test("unsupported values become null with explicit state", () => {
    const projector = new LiveTelemetryProjector();
    const result = projector.project({ packet: packet("acc"), sessionId: 1, receivedAtMs: 1000 });
    expect(result.frame?.values.every((value) => value === null || typeof value !== "bigint")).toBe(true);
  });

  test("publishes Forza tire temperatures in canonical Celsius", () => {
    const projector = new LiveTelemetryProjector();
    const result = projector.project({
      packet: {
        ...packet("fm-2023"),
        TireTempFL: 212,
        TireTempFR: 194,
        TireTempRL: 176,
        TireTempRR: 158,
      },
      sessionId: 1,
      receivedAtMs: 1_000,
    });
    if (!result.schema || !result.frame) throw new Error("first projection must include schema and frame");
    const index = result.schema.definitions.findIndex(
      (definition) => definition.semanticId === "tire.temperature.average",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(result.schema.definitions[index].unit).toBe("°C");
    expect(result.frame.values[index]).toEqual([100, 90, 80, 70]);
  });

  test("steady frame payload stays compact", () => {
    const projector = new LiveTelemetryProjector();
    const result = projector.project({ packet: packet("acc"), sessionId: 1, receivedAtMs: 1000 });
    const wire = JSON.stringify(result.frame);
    const native = JSON.stringify(packet("acc"));
    expect(wire.length).toBeLessThan(native.length + 5000);
  });
});
