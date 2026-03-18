import { describe, test, expect } from "bun:test";
import { parsePacket } from "../server/parser";

function buildMockPacket(overrides: Record<number, { type: string; value: number }> = {}): Buffer {
  const buf = Buffer.alloc(331, 0);

  // Default: IsRaceOn = 1
  buf.writeInt32LE(1, 0);
  // TimestampMS = 12345
  buf.writeUInt32LE(12345, 4);
  // EngineMaxRpm = 8500
  buf.writeFloatLE(8500, 8);
  // EngineIdleRpm = 800
  buf.writeFloatLE(800, 12);
  // CurrentEngineRpm = 6000
  buf.writeFloatLE(6000, 16);
  // VelocityX = 10.5
  buf.writeFloatLE(10.5, 32);
  // VelocityY = 0.1
  buf.writeFloatLE(0.1, 36);
  // VelocityZ = 25.3
  buf.writeFloatLE(25.3, 40);
  // TireTempFL = 200
  buf.writeFloatLE(200, 168);
  // TireTempFR = 205
  buf.writeFloatLE(205, 172);
  // TireTempRL = 210
  buf.writeFloatLE(210, 176);
  // TireTempRR = 215
  buf.writeFloatLE(215, 180);
  // Boost = 1.2
  buf.writeFloatLE(1.2, 184);
  // Fuel = 0.75
  buf.writeFloatLE(0.75, 188);
  // DistanceTraveled = 1234.5
  buf.writeFloatLE(1234.5, 192);
  // BestLap = 83.456
  buf.writeFloatLE(83.456, 196);
  // LastLap = 85.123
  buf.writeFloatLE(85.123, 200);
  // CurrentLap = 42.5
  buf.writeFloatLE(42.5, 204);
  // CurrentRaceTime = 300.0
  buf.writeFloatLE(300.0, 208);
  // LapNumber = 3
  buf.writeUInt16LE(3, 212);
  // RacePosition = 1
  buf.writeUInt8(1, 214);
  // Accel = 200
  buf.writeUInt8(200, 215);
  // Brake = 0
  buf.writeUInt8(0, 216);
  // Gear = 4
  buf.writeUInt8(4, 219);
  // Steer = 130 (slightly right)
  buf.writeUInt8(130, 220);
  // CarOrdinal = 342
  buf.writeInt32LE(342, 304);
  // CarClass = 4 (S class)
  buf.writeInt32LE(4, 308);
  // CarPerformanceIndex = 812
  buf.writeInt32LE(812, 312);
  // DrivetrainType = 1 (RWD)
  buf.writeInt32LE(1, 316);
  // NumCylinders = 8
  buf.writeInt32LE(8, 320);

  return buf;
}

describe("parsePacket", () => {
  test("parses a valid 331-byte packet correctly", () => {
    const buf = buildMockPacket();
    const p = parsePacket(buf);

    expect(p).not.toBeNull();
    expect(p!.IsRaceOn).toBe(1);
    expect(p!.TimestampMS).toBe(12345);
    expect(p!.EngineMaxRpm).toBeCloseTo(8500);
    expect(p!.EngineIdleRpm).toBeCloseTo(800);
    expect(p!.CurrentEngineRpm).toBeCloseTo(6000);
    expect(p!.VelocityX).toBeCloseTo(10.5);
    expect(p!.VelocityZ).toBeCloseTo(25.3);
    expect(p!.TireTempFL).toBeCloseTo(200);
    expect(p!.TireTempFR).toBeCloseTo(205);
    expect(p!.TireTempRL).toBeCloseTo(210);
    expect(p!.TireTempRR).toBeCloseTo(215);
    expect(p!.Boost).toBeCloseTo(1.2);
    expect(p!.Fuel).toBeCloseTo(0.75);
    expect(p!.DistanceTraveled).toBeCloseTo(1234.5);
    expect(p!.BestLap).toBeCloseTo(83.456, 2);
    expect(p!.LastLap).toBeCloseTo(85.123, 2);
    expect(p!.CurrentLap).toBeCloseTo(42.5);
    expect(p!.LapNumber).toBe(3);
    expect(p!.RacePosition).toBe(1);
    expect(p!.Accel).toBe(200);
    expect(p!.Brake).toBe(0);
    expect(p!.Gear).toBe(4);
    expect(p!.Steer).toBe(130);
    expect(p!.CarOrdinal).toBe(342);
    expect(p!.CarClass).toBe(4);
    expect(p!.CarPerformanceIndex).toBe(812);
    expect(p!.DrivetrainType).toBe(1);
    expect(p!.NumCylinders).toBe(8);
  });

  test("returns null for wrong packet length", () => {
    const buf = Buffer.alloc(100, 0);
    expect(parsePacket(buf)).toBeNull();
  });

  test("returns null when IsRaceOn is 0", () => {
    const buf = Buffer.alloc(331, 0);
    buf.writeInt32LE(0, 0); // IsRaceOn = 0
    expect(parsePacket(buf)).toBeNull();
  });

  test("reads signed fields correctly", () => {
    const buf = buildMockPacket();
    // NormDrivingLine at offset 221 (s8)
    buf.writeInt8(-50, 221);
    // NormAIBrakeDiff at offset 222 (s8)
    buf.writeInt8(-100, 222);

    const p = parsePacket(buf);
    expect(p).not.toBeNull();
    expect(p!.NormDrivingLine).toBe(-50);
    expect(p!.NormAIBrakeDiff).toBe(-100);
  });

  test("reads tire wear and suspension travel", () => {
    const buf = buildMockPacket();
    buf.writeFloatLE(0.92, 224); // TireWearFL
    buf.writeFloatLE(0.89, 228); // TireWearFR
    buf.writeFloatLE(0.12, 288); // SuspensionTravelMetersFL
    buf.writeFloatLE(0.11, 292); // SuspensionTravelMetersFR

    const p = parsePacket(buf);
    expect(p).not.toBeNull();
    expect(p!.TireWearFL).toBeCloseTo(0.92);
    expect(p!.TireWearFR).toBeCloseTo(0.89);
    expect(p!.SuspensionTravelMetersFL).toBeCloseTo(0.12);
    expect(p!.SuspensionTravelMetersFR).toBeCloseTo(0.11);
  });
});
