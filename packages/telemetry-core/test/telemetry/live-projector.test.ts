import { describe, expect, test } from "bun:test";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";


const packet = (gameId: string, speed = 12): TelemetryPacket => ({ gameId, TimestampMS: 1000, Speed: speed } as TelemetryPacket);
function lmuPacket(physicsSeconds: number, scoringSeconds: number, captureMs: number): TelemetryPacket {
  return {
    gameId: "lmu",
    TimestampMS: captureMs,
    BestLap: 91,
    LastLap: 95,
    DistanceTraveled: 1_000,
    lmu: {
      telemetryElapsedTime: physicsSeconds,
      scoringElapsedTime: scoringSeconds,
      engineRpm: 9_000,
      rainIntensity: 0,
    },
  } as TelemetryPacket;
}


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
  test("uses scoring snapshot time while native physics advances", () => {
    const projector = new LiveTelemetryProjector();
    const project = (physics: number, scoring: number, captureMs: number) =>
      projector.project({ packet: lmuPacket(physics, scoring, captureMs), sessionId: 4, receivedAtMs: captureMs });
    const first = project(10, 10, 1_800_000_000_000);
    const schema = first.schema!;
    const frame = first.frame!;
    const index = (semanticId: string) => schema.definitions.findIndex((definition) => definition.semanticId === semanticId);
    const freshness = (message: typeof frame, semanticId: string) => message.freshness?.[index(semanticId)] ?? "fresh";

    expect(frame.observedAt).toEqual({ domain: "session", milliseconds: 10_000 });
    expect(frame.receivedAtMs).toBe(1_800_000_000_000);
    expect(frame.values[index("weather.rain-intensity")]).toBe(0);
    expect(frame.values[index("engine.rpm")]).toBe(9_000);
    expect(freshness(project(10.5, 10, 1_800_000_000_500).frame!, "weather.rain-intensity")).toBe("fresh");
    const frozen = project(11.5, 10, 1_800_000_001_500).frame!;
    expect(freshness(frozen, "weather.rain-intensity")).toBe("stale");
    expect(freshness(frozen, "engine.rpm")).toBe("fresh");
    expect(frame.values[index("timing.best-lap")]).toBe(91);
    expect(frame.values[index("timing.last-lap")]).toBe(95);
    expect(frame.values[index("timing.distance-traveled")]).toBe(1_000);
    for (const semanticId of ["timing.best-lap", "timing.last-lap", "timing.distance-traveled"]) {
      expect(freshness(frozen, semanticId)).toBe("stale");
      expect(frozen.values[index(semanticId)]).toBeNull();
    }

    const advanced = project(12, 11, 1_800_000_002_000).frame!;
    expect(advanced.values[index("weather.rain-intensity")]).toBe(0);
    expect(freshness(advanced, "weather.rain-intensity")).toBe("fresh");
    expect(freshness(project(13.5, 11, 1_800_000_003_500).frame!, "weather.rain-intensity")).toBe("stale");
  });

  test("unknown and future scoring timestamps do not fabricate fresh weather observations", () => {
    const projector = new LiveTelemetryProjector();
    const schema = projector.project({ packet: lmuPacket(10, 10, 10_000), sessionId: 4, receivedAtMs: 10_000 }).schema!;
    const index = schema.definitions.findIndex((definition) => definition.semanticId === "weather.rain-intensity");
    const invalid = projector.project({ packet: lmuPacket(11, Number.NaN, 11_000), sessionId: 4, receivedAtMs: 11_000 }).frame!;
    expect(invalid.freshness?.[index] ?? "fresh").toBe("unknown");
    const future = projector.project({ packet: lmuPacket(12, 13, 12_000), sessionId: 4, receivedAtMs: 12_000 }).frame!;
    expect(future.freshness?.[index] ?? "fresh").toBe("unknown");
  });
});
