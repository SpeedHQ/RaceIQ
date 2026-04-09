import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { assessLapRecording } from "../server/lap-quality";

/** Build a minimal packet array for testing. */
function makePackets(
  count: number,
  opts: {
    startDist?: number;
    lapDistance?: number;
    lapTime?: number;
    startX?: number;
    startZ?: number;
    endX?: number;
    endZ?: number;
  } = {}
): TelemetryPacket[] {
  const {
    startDist = 5000,
    lapDistance = 5000,
    lapTime = 90,
    startX = 100,
    startZ = 200,
    endX = 105,
    endZ = 203,
  } = opts;

  const packets: Partial<TelemetryPacket>[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    packets.push({
      DistanceTraveled: startDist + frac * lapDistance,
      CurrentLap: frac * lapTime,
      PositionX: startX + frac * (endX - startX),
      PositionZ: startZ + frac * (endZ - startZ),
    });
  }
  return packets as TelemetryPacket[];
}

describe("assessLapRecording", () => {
  test("valid lap passes all checks", () => {
    const packets = makePackets(100, { lapTime: 90 });
    const result = assessLapRecording(packets, 90);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("too few packets", () => {
    const packets = makePackets(10, { lapTime: 90 });
    const result = assessLapRecording(packets, 90);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("too few telemetry packets");
  });

  test("distance too short", () => {
    const packets = makePackets(50, { lapDistance: 50 });
    const result = assessLapRecording(packets, 90);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("telemetry distance too short");
  });

  test("lap time mismatch", () => {
    const packets = makePackets(100, { lapTime: 90 });
    // Stored lap time is 95 but telemetry shows 90 — 5s difference > 2s threshold
    const result = assessLapRecording(packets, 95);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("telemetry lap time mismatch");
  });

  test("lap time within tolerance passes", () => {
    const packets = makePackets(100, { lapTime: 90 });
    // 1.5s difference is within 2s tolerance
    const result = assessLapRecording(packets, 91.5);
    expect(result.valid).toBe(true);
  });

  test("start/end positions too far apart", () => {
    // Gap of 1000m on a 5000m lap = 20% > 15% threshold
    const packets = makePackets(100, {
      lapTime: 90,
      startX: 0,
      startZ: 0,
      endX: 1000,
      endZ: 0,
    });
    const result = assessLapRecording(packets, 90);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("start/end positions too far apart");
  });

  test("small position gap on short lap passes (under 100m absolute)", () => {
    // Gap of 80m but that's 16% of 500m lap — over 15% but under 100m absolute
    const packets = makePackets(50, {
      lapDistance: 500,
      lapTime: 30,
      startX: 0,
      startZ: 0,
      endX: 80,
      endZ: 0,
    });
    const result = assessLapRecording(packets, 30);
    expect(result.valid).toBe(true);
  });

  test("moderate position gap passes (within tolerance)", () => {
    // Gap of 50m on 5000m lap = 1% — well within tolerance
    const packets = makePackets(100, {
      lapTime: 90,
      startX: 0,
      startZ: 0,
      endX: 50,
      endZ: 0,
    });
    const result = assessLapRecording(packets, 90);
    expect(result.valid).toBe(true);
  });

  test("cumulative DistanceTraveled does not affect validity", () => {
    // Simulates lap 3 of a session — startDist is large but lap is valid
    const packets = makePackets(100, {
      startDist: 15000,
      lapDistance: 5000,
      lapTime: 88,
    });
    const result = assessLapRecording(packets, 88);
    expect(result.valid).toBe(true);
  });
});
