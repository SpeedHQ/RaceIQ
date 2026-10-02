import { describe, test, expect } from "bun:test";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { parsePacket } from "../../../server/games/packet-dispatch";

// Register game adapters before tests run
initGameAdapters();
initServerGameAdapters();

/**
 * Build a mock 331-byte Forza "Dash" packet with known values.
 *
 * Forza packet layout:
 *   Offsets 0-231:   "Sled" base data
 *   Offsets 232-310: "Dash" extended data
 *   Offsets 311-330: Extra (tire wear, track ordinal)
 */
function buildMockPacket(): Buffer {
  const buf = Buffer.alloc(331, 0);

  // === Sled section (0-231) ===
  buf.writeInt32LE(1, 0);           // IsRaceOn = 1
  buf.writeUInt32LE(12345, 4);      // TimestampMS
  buf.writeFloatLE(8500, 8);        // EngineMaxRpm
  buf.writeFloatLE(800, 12);        // EngineIdleRpm
  buf.writeFloatLE(6000, 16);       // CurrentEngineRpm
  buf.writeFloatLE(10.5, 32);       // VelocityX
  buf.writeFloatLE(0.1, 36);        // VelocityY
  buf.writeFloatLE(25.3, 40);       // VelocityZ
  buf.writeInt32LE(342, 212);       // CarOrdinal
  buf.writeInt32LE(4, 216);         // CarClass
  buf.writeInt32LE(812, 220);       // CarPerformanceIndex
  buf.writeInt32LE(1, 224);         // DrivetrainType (RWD)
  buf.writeInt32LE(8, 228);         // NumCylinders

  // === Dash section (232+) ===
  buf.writeFloatLE(256, 256);       // TireTempFL = 200 (at offset 256)
  buf.writeFloatLE(200, 256);       // TireTempFL
  buf.writeFloatLE(205, 260);       // TireTempFR
  buf.writeFloatLE(210, 264);       // TireTempRL
  buf.writeFloatLE(215, 268);       // TireTempRR
  buf.writeFloatLE(1.2, 272);       // Boost
  buf.writeFloatLE(0.75, 276);      // Fuel
  buf.writeFloatLE(1234.5, 280);    // DistanceTraveled
  buf.writeFloatLE(83.456, 284);    // BestLap
  buf.writeFloatLE(85.123, 288);    // LastLap
  buf.writeFloatLE(42.5, 292);      // CurrentLap
  buf.writeFloatLE(300.0, 296);     // CurrentRaceTime
  buf.writeUInt16LE(3, 300);        // LapNumber
  buf.writeUInt8(1, 302);           // RacePosition
  buf.writeUInt8(200, 303);         // Accel
  buf.writeUInt8(0, 304);           // Brake
  buf.writeUInt8(4, 307);           // Gear
  buf.writeInt8(5, 308);            // Steer
  buf.writeInt8(-50, 309);          // NormDrivingLine
  buf.writeInt8(-100, 310);         // NormAIBrakeDiff

  // === Extra section (311+) ===
  buf.writeFloatLE(0.92, 311);      // TireWearFL
  buf.writeFloatLE(0.89, 315);      // TireWearFR
  buf.writeFloatLE(0.85, 319);      // TireWearRL
  buf.writeFloatLE(0.88, 323);      // TireWearRR
  buf.writeInt32LE(100, 327);       // TrackOrdinal

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
    expect(p!.Steer).toBe(5);
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
    const p = parsePacket(buf);
    expect(p).not.toBeNull();
    expect(p!.NormDrivingLine).toBe(-50);
    expect(p!.NormAIBrakeDiff).toBe(-100);
  });

  test("reads tire wear and suspension travel", () => {
    const buf = buildMockPacket();
    // Tire wear is already set in buildMockPacket
    // Suspension travel at sled offsets 196-208
    buf.writeFloatLE(0.12, 196);    // SuspensionTravelMFL
    buf.writeFloatLE(0.11, 200);    // SuspensionTravelMFR

    const p = parsePacket(buf);
    expect(p).not.toBeNull();
    expect(p!.TireWearFL).toBeCloseTo(0.92);
    expect(p!.TireWearFR).toBeCloseTo(0.89);
    expect(p!.SuspensionTravelMFL).toBeCloseTo(0.12);
    expect(p!.SuspensionTravelMFR).toBeCloseTo(0.11);
  });
});
