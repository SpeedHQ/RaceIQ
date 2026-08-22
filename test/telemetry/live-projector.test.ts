import { describe, expect, test } from "bun:test";
import { LiveTelemetryProjector } from "../../server/telemetry/live-projector";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const packet = (gameId: string, speed = 12): TelemetryPacket => ({ gameId, TimestampMS: 1000, Speed: speed }) as TelemetryPacket;

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

  test("steady frame payload stays compact", () => {
    const projector = new LiveTelemetryProjector();
    const result = projector.project({ packet: packet("acc"), sessionId: 1, receivedAtMs: 1000 });
    const wire = JSON.stringify(result.frame);
    const native = JSON.stringify(packet("acc"));
    expect(wire.length).toBeLessThan(native.length + 5000);
  });

  test("resets same-game source state before new session resolution", () => {
    const projector = new LiveTelemetryProjector();
    projector.project({ packet: packet("acc", 12), sessionId: 1, receivedAtMs: 1_100 });
    const changed = projector.project({
      packet: { gameId: "acc", TimestampMS: 2_000 } as TelemetryPacket,
      sessionId: 2,
      receivedAtMs: 2_100,
    });

    expect(changed.frame?.sequence).toBe(0);
    expect(changed.sample.values["motion.speed"]).toBeUndefined();
  });

  test("omits non-finite resolved values from semantic samples", () => {
    const projector = new LiveTelemetryProjector();
    const resolved = projector.resolve({ gameId: "acc", TimestampMS: 1_000, Speed: Number.NaN } as TelemetryPacket, 1_100, 1);

    expect(resolved.sample.values["motion.speed"]).toBeUndefined();
  });
});
