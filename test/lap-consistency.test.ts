import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { computeLapConsistencyDelta, LINE_SPREAD_THRESHOLD_M, INPUT_VAR_THRESHOLD } from "../server/lap-consistency";
import type { Corner } from "../server/corner-detection";

/**
 * `computeLapConsistencyDelta` is pure math over resampled lap paths — these
 * tests pin the racing-line spread / input-variance behaviour with hand-built
 * synthetic laps rather than real telemetry.
 */

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "f1-2025",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    PositionX: 0,
    PositionZ: 0,
    VelocityX: 0,
    VelocityY: 0,
    VelocityZ: 0,
    Gear: 1,
    Accel: 0,
    Brake: 0,
    ...overrides,
  } as TelemetryPacket;
}

// Straight-line lap along Z, 600m long, ~120 frames (5m / frame, 100ms cadence).
// Corner T1 spans distance 200..300; the rest of the lap is straight.
// Braking pattern: constant, contiguous braking window in the corner approach.
const LAP_LENGTH_M = 600;
const FRAME_COUNT = 121;
const STEP_M = LAP_LENGTH_M / (FRAME_COUNT - 1);
const CORNER_START = 200;
const CORNER_END = 300;

interface LapOptions {
  lateralOffsetInCorner?: number; // metres added to PositionX within the corner span
  brakeShiftM?: number; // shift the braking window earlier by this many metres
}

function buildLap(opts: LapOptions = {}): TelemetryPacket[] {
  const { lateralOffsetInCorner = 0, brakeShiftM = 0 } = opts;
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const distance = i * STEP_M;
    const inCorner = distance >= CORNER_START && distance <= CORNER_END;
    const x = inCorner ? lateralOffsetInCorner : 0;

    // Braking normally happens mid-corner (220..260), shiftable earlier while
    // staying inside the T1 corner span (200..300) so the corner's brakeVar
    // actually picks up the shift.
    const brakeWindowStart = 220 - brakeShiftM;
    const brakeWindowEnd = 260 - brakeShiftM;
    const braking = distance >= brakeWindowStart && distance <= brakeWindowEnd;

    packets.push(
      pkt({
        TimestampMS: i * 100,
        DistanceTraveled: distance,
        PositionX: x,
        PositionZ: distance,
        VelocityX: 0,
        VelocityZ: STEP_M / 0.1,
        Brake: braking ? 1 : 0,
        Accel: braking ? 0 : 1,
      }),
    );
  }
  return packets;
}

const corners: Corner[] = [
  { index: 1, label: "T1", distanceStart: CORNER_START, distanceEnd: CORNER_END },
  { index: 2, label: "T2", distanceStart: 400, distanceEnd: 500 },
];

describe("computeLapConsistencyDelta", () => {
  test("returns empty result with fewer than 2 laps or no corners", () => {
    const lap = buildLap();
    expect(computeLapConsistencyDelta([lap], corners)).toEqual({
      perCorner: [],
      overall: { lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false },
    });
    expect(computeLapConsistencyDelta([lap, lap], [])).toEqual({
      perCorner: [],
      overall: { lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false },
    });
  });

  test("two identical laps: near-zero spread/variance everywhere, lowTrust false", () => {
    const lapA = buildLap();
    const lapB = buildLap();
    const result = computeLapConsistencyDelta([lapA, lapB], corners);

    const t1 = result.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.lateralSpreadM).toBeCloseTo(0, 3);
    expect(t1.brakeVar).toBeCloseTo(0, 3);
    expect(t1.throttleVar).toBeCloseTo(0, 3);
    expect(t1.lowTrust).toBe(false);

    const t2 = result.perCorner.find((c) => c.corner === "T2")!;
    expect(t2.lowTrust).toBe(false);

    expect(result.overall.lowTrust).toBe(false);
  });

  test("lap offset laterally through T1 flags that corner's line, not T2", () => {
    const lapA = buildLap();
    const lapB = buildLap({ lateralOffsetInCorner: 4 });
    const result = computeLapConsistencyDelta([lapA, lapB], corners);

    const t1 = result.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.lateralSpreadM).toBeGreaterThan(LINE_SPREAD_THRESHOLD_M);
    expect(t1.lowTrust).toBe(true);

    const t2 = result.perCorner.find((c) => c.corner === "T2")!;
    expect(t2.lateralSpreadM).toBeCloseTo(0, 3);
    expect(t2.lowTrust).toBe(false);
  });

  test("lap braking ~20m earlier through T1 flags brakeVar for that corner", () => {
    const lapA = buildLap();
    const lapB = buildLap({ brakeShiftM: 20 });
    const result = computeLapConsistencyDelta([lapA, lapB], corners);

    const t1 = result.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.brakeVar).toBeGreaterThan(INPUT_VAR_THRESHOLD);
    expect(t1.lowTrust).toBe(true);
  });
});
