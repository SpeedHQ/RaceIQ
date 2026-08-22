import { describe, expect, test } from "bun:test";
import { compareLaps, prepareComparisonAlignmentIndex } from "../../server/lap-analysis/comparison";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function packet(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 0,
    EngineMaxRpm: 9000,
    EngineIdleRpm: 1000,
    CurrentEngineRpm: 4000,
    AccelerationX: 0,
    AccelerationY: 0,
    AccelerationZ: 0,
    VelocityX: 10,
    VelocityY: 0,
    VelocityZ: 0,
    AngularVelocityX: 0,
    AngularVelocityY: 0,
    AngularVelocityZ: 0,
    Yaw: 0,
    Pitch: 0,
    Roll: 0,
    Fuel: 1,
    DistanceTraveled: 0,
    BestLap: 0,
    LastLap: 0,
    CurrentLap: 0,
    CurrentRaceTime: 0,
    LapNumber: 1,
    RacePosition: 1,
    Accel: 128,
    Brake: 0,
    Clutch: 0,
    HandBrake: 0,
    Gear: 3,
    Steer: 127,
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    TireTempFL: 80,
    TireTempFR: 80,
    TireTempRL: 80,
    TireTempRR: 80,
    PositionX: 0,
    PositionY: 0,
    PositionZ: 0,
    ...overrides,
  } as TelemetryPacket;
}

function lineLap({ detour = false, shortcut = false, timeOffset = 0 } = {}): TelemetryPacket[] {
  const points = shortcut
    ? Array.from({ length: 15 }, (_, index) => index * 5)
    : Array.from({ length: 21 }, (_, index) => index * 5);
  const out: TelemetryPacket[] = [];
  for (const x of points) {
    out.push(packet({
      TimestampMS: (x / 10) * 1000 + (x === 0 ? 0 : timeOffset),
      DistanceTraveled: x,
      PositionX: x,
      PositionZ: 0,
      Accel: x === 75 ? 200 : 128,
    }));
  }
  if (detour) {
    const insertAt = out.findIndex((p) => p.PositionX === 50) + 1;
    out.splice(
      insertAt,
      0,
      packet({ TimestampMS: 9000, DistanceTraveled: 70, PositionX: 55, PositionZ: 20, Accel: 255 }),
      packet({ TimestampMS: 10000, DistanceTraveled: 80, PositionX: 50, PositionZ: 0, Accel: 255 }),
      packet({ TimestampMS: 11000, DistanceTraveled: 90, PositionX: 60, PositionZ: 0, Accel: 255 }),
    );
    for (let i = insertAt + 3; i < out.length; i++) {
      out[i].DistanceTraveled += 40;
      out[i].TimestampMS += 4000;
    }
  }
  return out;
}

describe("compare lap course alignment", () => {
  test("keeps crash lap inputs aligned to same on-track position", () => {
    const clean = lineLap();
    const crash = lineLap({ detour: true });
    const result = compareLaps(clean, crash, [], { lapAIsValid: true, lapBIsValid: true, trackLengthMeters: 100 });
    expect(result.distances.at(-1)).toBe(100);
    expect(result.lapA.sourceIndices).toHaveLength(result.distances.length);
    expect(result.lapB.sourceIndices).toHaveLength(result.distances.length);
    const idx = 75;
    expect(crash[result.lapB.sourceIndices[idx]].PositionX).toBeGreaterThanOrEqual(70);
    expect(crash[result.lapB.sourceIndices[idx]].PositionX).toBeLessThanOrEqual(80);
    expect(result.timeDelta[idx]).toBeLessThan(-3);
  });

  test("chooses clean reference when another lap takes shortcut", () => {
    const result = compareLaps(lineLap(), lineLap({ shortcut: true }), [], {
      lapAIsValid: true,
      lapBIsValid: true,
      trackLengthMeters: 100,
    });
    expect(result.distances.at(-1)).toBe(100);
  });

  test("keeps projected position monotonic through noisy samples", () => {
    const noisy = lineLap();
    noisy.splice(4, 0, packet({ TimestampMS: 3500, DistanceTraveled: 35, PositionX: 0, PositionZ: 0 }));
    noisy.splice(6, 0, packet({ TimestampMS: 5500, DistanceTraveled: 200, PositionX: 35, PositionZ: 0 }));
    const result = compareLaps(lineLap(), noisy, [], { trackLengthMeters: 100 });
    const positions = result.lapB.sourceIndices.map((i) => noisy[i].PositionX).filter((position) => position > 0);
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
  });

  test("uses iRacing lap fraction when world positions are unavailable", () => {
    const a = lineLap().map((p, i) => packet({ ...p, gameId: "iracing", PositionX: 0, PositionZ: 0, DistanceTraveled: i * 5, iracing: { lapDistancePct: i / 20 } as never }));
    const b = lineLap().map((p, i) => packet({ ...p, gameId: "iracing", PositionX: 0, PositionZ: 0, DistanceTraveled: i * 10, iracing: { lapDistancePct: i / 20 } as never }));
    const result = compareLaps(a, b, []);
    expect(result.distances.at(-1)).toBe(100);
    expect(result.lapA.throttle).toEqual(result.lapB.throttle);
  });

  test("preserves clean lap grid and elapsed delta", () => {
    const result = compareLaps(lineLap(), lineLap({ timeOffset: 500 }), []);
    expect(result.distances).toHaveLength(101);
    expect(result.timeDelta.at(-1)).toBeCloseTo(-0.5, 3);
  });
  test("interpolates yaw and aligns every trace array to the distance grid", () => {
    const result = compareLaps(
      lineLap().map((p) => packet({ ...p, Yaw: p.PositionX })),
      lineLap().map((p) => packet({ ...p, Yaw: p.PositionX * 2 })),
      [],
    );
    expect(result.lapA.yaw[5]).toBeCloseTo(result.lapA.posX[5], 6);
    expect(result.lapB.yaw[5]).toBeCloseTo(result.lapB.posX[5] * 2, 6);
    for (const trace of [result.lapA, result.lapB]) {
      for (const values of Object.values(trace)) expect(values).toHaveLength(result.distances.length);
    }
  });
  test("supports finer bounded alignment grids", () => {
    const result = compareLaps(lineLap(), lineLap(), [], { gridStepMeters: 0.5, distanceRange: { start: 10, end: 20 } });
    expect(result.distances[0]).toBe(10);
    expect(result.distances.at(-1)).toBe(20);
    expect(result.distances).toHaveLength(21);
    expect(result.lapA.yaw).toHaveLength(result.distances.length);
  });
  test("preserves bounded projection parity at inclusive segment boundaries", () => {
    const lapA = lineLap();
    const lapB = lineLap().map((sample, index) => packet({
      ...sample,
      PositionX: index === 5 ? 20 : index === 6 ? 20 : sample.PositionX,
      DistanceTraveled: index * 5,
    }));
    const options = { trackLengthMeters: 100, gridStepMeters: 5, distanceRange: { start: 20, end: 70 } };
    const prepared = prepareComparisonAlignmentIndex(lapA, lapB, options);
    const internal = compareLaps(lapA, lapB, [], options);
    const reused = compareLaps(lapA, lapB, [], { ...options, alignmentIndex: prepared });
    expect(reused).toEqual(internal);
    expect(reused.lapA.sourceIndices[0]).toBeGreaterThan(0);
    expect(reused.lapB.sourceIndices[0]).toBeGreaterThan(0);
    for (const sourceIndices of [reused.lapA.sourceIndices, reused.lapB.sourceIndices]) {
      for (let index = 1; index < sourceIndices.length; index++) {
        expect(sourceIndices[index]).toBeGreaterThanOrEqual(sourceIndices[index - 1]);
      }
    }
  });

  test("caps oversized fine grids at 50,000 points", () => {
    const result = compareLaps(lineLap(), lineLap(), [], { gridStepMeters: 0.001 });
    expect(result.distances.length).toBeLessThanOrEqual(50_000);
  });
});
