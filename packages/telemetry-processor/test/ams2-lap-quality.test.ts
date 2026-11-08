import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { assessLapRecording } from "@raceiq/telemetry-core/processor/lap-policy";

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
  const gridPackets = (count = 100, lapDistance = 5000) => makePackets(count, {
    endX: 200, lapDistance,
  }).map(p => ({ ...p, gameId: "ams2" as const, LapNumber: 1,
    ams2: { carName: "Test car", trackName: "Test track", trackLengthM: 5000,
      lapDistanceM: 0, sessionType: "race", lapInvalidated: false, inPits: false } }));

  test("allows a captured AMS2 grid start to finish away from its starting position", () => {
    expect(assessLapRecording(gridPackets(), 90)).toEqual({ valid: true, reason: null });
  });

  test("still checks closure for later laps, mid-race capture, other sessions and games", () => {
    for (const kind of ["later", "mid-race", "practice", "other-game"] as const) {
      const packets = gridPackets();
      if (kind === "later") packets.forEach(p => { p.LapNumber = 2; });
      if (kind === "mid-race") packets[0].CurrentLap = 10;
      if (kind === "practice") packets.forEach(p => { p.ams2.sessionType = "practice"; });
      const input: TelemetryPacket[] = packets;
      if (kind === "other-game") input.forEach(p => { p.gameId = "fm-2023"; });
      expect(assessLapRecording(input, 90).reason).toBe("start/end positions too far apart");
    }
  });

  test("grid-start exception retains packet count, distance and timing checks", () => {
    expect(assessLapRecording(gridPackets(10), 90).reason).toBe("too few telemetry packets");
    expect(assessLapRecording(gridPackets(100, 50), 90).reason).toBe("telemetry distance too short");
    expect(assessLapRecording(gridPackets(), 95).reason).toBe("telemetry lap time mismatch");
  });
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
    // A 21m closure gap exceeds the strict 20m maximum.
    const packets = makePackets(100, {
      lapTime: 90,
      startX: 0,
      startZ: 0,
      endX: 21,
      endZ: 0,
    });
    const result = assessLapRecording(packets, 90);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("start/end positions too far apart");
  });

  test("20m position gap passes", () => {
    const packets = makePackets(100, {
      lapTime: 90,
      startX: 0,
      startZ: 0,
      endX: 20,
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
