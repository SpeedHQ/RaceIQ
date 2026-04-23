import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { parseAccBuffers } from "../server/games/acc/parser";
import { PHYSICS, GRAPHICS, STATIC } from "../server/games/acc/structs";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { parseRawLapFramesForTest } from "../server/db/queries";
import { stopMaintenanceTasks } from "../server/pipeline";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

/** Helper: create a minimal physics buffer with given values */
function makePhysicsBuf(overrides: Record<string, number> = {}): Buffer {
  const buf = Buffer.alloc(PHYSICS.SIZE);
  buf.writeFloatLE(overrides.gas ?? 0.8, PHYSICS.gas.offset);
  buf.writeFloatLE(overrides.brake ?? 0.0, PHYSICS.brake.offset);
  buf.writeFloatLE(overrides.fuel ?? 50.0, PHYSICS.fuel.offset);
  buf.writeInt32LE(overrides.gear ?? 4, PHYSICS.gear.offset);
  buf.writeInt32LE(overrides.rpms ?? 7500, PHYSICS.rpms.offset);
  buf.writeFloatLE(overrides.steerAngle ?? 0.1, PHYSICS.steerAngle.offset);
  buf.writeFloatLE(overrides.speedKmh ?? 180.0, PHYSICS.speedKmh.offset);
  buf.writeFloatLE(overrides.heading ?? 1.5, PHYSICS.heading.offset);
  buf.writeFloatLE(overrides.pitch ?? 0.02, PHYSICS.pitch.offset);
  buf.writeFloatLE(overrides.roll ?? 0.01, PHYSICS.roll.offset);
  buf.writeFloatLE(overrides.tc ?? 3, PHYSICS.tc.offset);
  buf.writeFloatLE(overrides.abs ?? 2, PHYSICS.abs.offset);
  buf.writeFloatLE(overrides.brakeBias ?? 0.58, PHYSICS.brakeBias.offset);
  // Tire temps
  buf.writeFloatLE(overrides.tyreTempFL ?? 85.0, PHYSICS.tyreTempFL.offset);
  buf.writeFloatLE(overrides.tyreTempFR ?? 86.0, PHYSICS.tyreTempFR.offset);
  buf.writeFloatLE(overrides.tyreTempRL ?? 90.0, PHYSICS.tyreTempRL.offset);
  buf.writeFloatLE(overrides.tyreTempRR ?? 91.0, PHYSICS.tyreTempRR.offset);
  // Tire core temps
  buf.writeFloatLE(85.0, PHYSICS.tyreCoreFL.offset);
  buf.writeFloatLE(86.0, PHYSICS.tyreCoreFR.offset);
  buf.writeFloatLE(90.0, PHYSICS.tyreCoreRL.offset);
  buf.writeFloatLE(91.0, PHYSICS.tyreCoreRR.offset);
  // Tire pressures (PSI)
  buf.writeFloatLE(27.5, PHYSICS.tyrePressureFL.offset);
  buf.writeFloatLE(27.6, PHYSICS.tyrePressureFR.offset);
  buf.writeFloatLE(27.3, PHYSICS.tyrePressureRL.offset);
  buf.writeFloatLE(27.4, PHYSICS.tyrePressureRR.offset);
  return buf;
}

/** Helper: create a minimal graphics buffer */
function makeGraphicsBuf(overrides: Record<string, number> = {}): Buffer {
  const buf = Buffer.alloc(GRAPHICS.SIZE);
  buf.writeInt32LE(overrides.status ?? 2, GRAPHICS.status.offset);
  buf.writeInt32LE(overrides.session ?? 0, GRAPHICS.session.offset);
  buf.writeInt32LE(overrides.completedLaps ?? 3, GRAPHICS.completedLaps.offset);
  buf.writeInt32LE(overrides.position ?? 1, GRAPHICS.position.offset);
  buf.writeInt32LE(overrides.iCurrentTime ?? 45000, GRAPHICS.iCurrentTime.offset);
  buf.writeInt32LE(overrides.iLastTime ?? 92345, GRAPHICS.iLastTime.offset);
  buf.writeInt32LE(overrides.iBestTime ?? 91234, GRAPHICS.iBestTime.offset);
  return buf;
}

/** Helper: create a minimal static buffer */
function makeStaticBuf(overrides: { carModel?: string; track?: string; maxRpm?: number } = {}): Buffer {
  const buf = Buffer.alloc(STATIC.SIZE);
  const carModel = overrides.carModel ?? "bmw_m4_gt3";
  buf.write(carModel, STATIC.carModel.offset, "utf16le");
  const track = overrides.track ?? "monza";
  buf.write(track, STATIC.track.offset, "utf16le");
  buf.writeInt32LE(overrides.maxRpm ?? 9000, STATIC.maxRpm.offset);
  return buf;
}

describe("ACC parser", () => {
  test("parseAccBuffers returns a valid TelemetryPacket", () => {
    const packet = parseAccBuffers(makePhysicsBuf(), makeGraphicsBuf(), makeStaticBuf());

    expect(packet).not.toBeNull();
    expect(packet!.gameId).toBe("acc");
    expect(packet!.CurrentEngineRpm).toBeCloseTo(7500);
    expect(packet!.Accel).toBeGreaterThan(0);
    expect(packet!.Brake).toBe(0);
    expect(packet!.Gear).toBe(3);
    expect(packet!.LapNumber).toBe(4);
    expect(packet!.RacePosition).toBe(1);
    expect(packet!.Yaw).toBeCloseTo(1.5);
  });

  test("parseAccBuffers populates ACC extended data", () => {
    const physics = makePhysicsBuf();
    const graphics = makeGraphicsBuf();
    // Write TC/ABS to graphics (integer settings)
    graphics.writeInt32LE(3, GRAPHICS.tcGraphics.offset);
    graphics.writeInt32LE(2, GRAPHICS.absGraphics.offset);

    const packet = parseAccBuffers(physics, graphics, makeStaticBuf());

    expect(packet!.acc).toBeDefined();
    expect(packet!.acc!.tc).toBe(3);
    expect(packet!.acc!.abs).toBe(2);
    expect(packet!.acc!.brakeBias).toBeCloseTo(0.58);
  });

  test("parseAccBuffers maps tire temps correctly", () => {
    const packet = parseAccBuffers(makePhysicsBuf(), makeGraphicsBuf(), makeStaticBuf());

    expect(packet!.TireTempFL).toBeCloseTo(85.0);
    expect(packet!.TireTempFR).toBeCloseTo(86.0);
    expect(packet!.TireTempRL).toBeCloseTo(90.0);
    expect(packet!.TireTempRR).toBeCloseTo(91.0);
  });

  test("parseAccBuffers maps tire pressures correctly", () => {
    const packet = parseAccBuffers(makePhysicsBuf(), makeGraphicsBuf(), makeStaticBuf());

    expect(packet!.TirePressureFrontLeft).toBeCloseTo(27.5);
    expect(packet!.TirePressureFrontRight).toBeCloseTo(27.6);
  });

  test("parseAccBuffers maps fuel correctly", () => {
    const packet = parseAccBuffers(
      makePhysicsBuf({ fuel: 25.5 }),
      makeGraphicsBuf(),
      makeStaticBuf()
    );
    expect(packet!.Fuel).toBeCloseTo(25.5);
  });

  test("parseAccBuffers maps lap times from ms to seconds", () => {
    const packet = parseAccBuffers(makePhysicsBuf(), makeGraphicsBuf(), makeStaticBuf());

    expect(packet!.CurrentLap).toBeCloseTo(45.0);
    expect(packet!.LastLap).toBeCloseTo(92.345);
    expect(packet!.BestLap).toBeCloseTo(91.234);
  });
});

const ACC_SESSION_BIN = "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz";

describe("parseRawLapFrames — coordinate normalization (standard-xyz)", () => {
  test("ACC PositionX/VelocityX/AccelerationX are X-flipped vs raw tryParse output", async () => {
    const raw = Buffer.from(gunzipSync(readFileSync(ACC_SESSION_BIN)));
    const startOffset = 8 + raw.readUInt32LE(4); // skip meta frame

    const serverGame = getServerGame("acc");
    const rawPackets: ReturnType<typeof serverGame.tryParse>[] = [];
    let off = startOffset;
    const N = 20;
    while (rawPackets.length < N && off + 4 <= raw.length) {
      const frameLen = raw.readUInt32LE(off);
      off += 4;
      if (off + frameLen > raw.length) break;
      const pkt = serverGame.tryParse(raw.subarray(off, off + frameLen), null);
      off += frameLen;
      if (pkt) rawPackets.push(pkt);
    }
    expect(rawPackets.length).toBe(N);

    const normalized = await parseRawLapFramesForTest(ACC_SESSION_BIN, startOffset, N, "acc");
    expect(normalized.length).toBe(N);

    for (let i = 0; i < N; i++) {
      const r = rawPackets[i]!;
      const n = normalized[i];
      expect(n.PositionX).toBeCloseTo(-r.PositionX, 4);
      expect(n.VelocityX).toBeCloseTo(-r.VelocityX, 4);
      expect(n.AccelerationX).toBeCloseTo(-r.AccelerationX, 4);
      expect(n.PositionY).toBeCloseTo(r.PositionY, 4);
      expect(n.PositionZ).toBeCloseTo(r.PositionZ, 4);
    }
  }, { timeout: 30000 });
});
