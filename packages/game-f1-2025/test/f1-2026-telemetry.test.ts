import { expect, test } from "bun:test";
import { f1Parser } from "../src/game-parser";
import { F1StateAccumulator } from "../src/f1-state";
import { decodeGenericSparseFrame, encodeGenericSparseFrame, genericFrameIdentity } from "@raceiq/capture-formats/session/generic-sparse";

// Synthetic wire data, NOT a real game recording. Offsets from EA's attached
// "2026 Season Pack Telemetry Output Structures (1).txt"; see the audit doc.
function frame(id: number, size: number, format = 2026, player = 23): Buffer {
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(format, 0);
  buf[2] = format % 100;
  buf[5] = 1;
  buf[6] = id;
  buf.writeBigUInt64LE(42n, 7);
  buf.writeFloatLE(12, 15);
  buf[27] = player;
  buf[28] = 255;
  return buf;
}

function baseFrames(): Buffer[] {
  const session = frame(1, 926);
  session[29 + 6] = 18;
  session[29 + 7] = 0;
  const motion = frame(0, 1325);
  const m = 29 + 23 * 54;
  motion.writeFloatLE(321, m);
  motion.writeInt16LE(-1250, m + 36);
  motion.writeInt16LE(2500, m + 38);
  motion.writeInt16LE(1000, m + 40);
  motion.writeFloatLE(0.25, m + 42);
  const lap = frame(2, 1399);
  const l = 29 + 23 * 57;
  lap.writeUInt32LE(62_500, l + 4);
  lap[l + 33] = 2;
  const telemetry = frame(6, 1448);
  const t = 29 + 23 * 59;
  telemetry.writeUInt16LE(288, t);
  telemetry.writeFloatLE(0.75, t + 2);
  telemetry[t + 38] = 106;
  telemetry.writeFloatLE(23.5, t + 39);
  telemetry.writeFloatLE(24.5, t + 47);
  telemetry[t + 57] = 7;
  telemetry[1447] = 6;
  return [session, motion, lap, telemetry];
}

test("2026 wire telemetry decodes car 24 without treating it as a 2025 packet", () => {
  const state = f1Parser.createParserState();
  let packet = null;
  for (const buf of baseFrames()) {
    expect(f1Parser.canHandle(buf)).toBe(true);
    packet = f1Parser.tryParse(buf, state);
  }
  expect(packet).toMatchObject({
    gameId: "f1-2025", // DLC is the same installed game, not a history migration.
    Speed: 80,
    CurrentLap: 62.5,
    PositionX: -321,
    Yaw: -0.25,
    AccelerationX: 1.25 * 9.81,
    AccelerationZ: 2.5 * 9.81,
    f1: {
      packetFormat: 2026,
      engineTemperature: 106,
      tyrePressureRL: 23.5,
      tyrePressureFL: 24.5,
      surfaceTypeFL: 7,
      suggestedGear: 6,
    },
  });
});

test("2026 grid keeps 16-bit participant identities and the new ERS harvest limit", () => {
  const state = f1Parser.createParserState();
  for (const buf of baseFrames()) f1Parser.tryParse(buf, state);
  const participants = frame(4, 1470);
  participants[29] = 24;
  for (let i = 0; i < 24; i++) {
    const o = 30 + i * 60;
    participants.writeUInt16LE(300 + i, o + 1);
    participants.writeUInt16LE(600 + i, o + 5);
    participants.write(`Driver ${i}`, o + 10, 32, "utf8");
  }
  f1Parser.tryParse(participants, state);
  const status = frame(7, 1445);
  const s = 29 + 23 * 59;
  status[s + 26] = 16;
  status.writeFloatLE(8_000_000, s + 50);
  status.writeFloatLE(3_000_000, s + 54);
  const packet = f1Parser.tryParse(status, state);
  expect(packet?.carId).toBe("623");
  expect(packet?.f1?.grid).toHaveLength(24);
  expect(packet?.f1?.grid[23]).toMatchObject({ driverId: 323, teamId: 623, name: "Driver 23", tyreCompound: "soft" });
  expect(packet?.f1).toMatchObject({ ersHarvestLimitPerLap: 8_000_000, ersDeployedThisLap: 3_000_000 });
});

test("2026 active aero and overtake are distinct from legacy DRS", () => {
  const state = f1Parser.createParserState();
  for (const buf of baseFrames()) f1Parser.tryParse(buf, state);
  const extra = frame(16, 269);
  const o = 29 + 23 * 10;
  extra[o] = 1;
  extra[o + 1] = 1;
  extra.writeUInt16LE(120, o + 2);
  extra[o + 4] = 1;
  extra[o + 5] = 1;
  extra.writeUInt16LE(250, o + 6);
  extra[o + 8] = 1;
  const packet = f1Parser.tryParse(extra, state);
  expect(packet?.f1).toMatchObject({
    drsActivated: false,
    carTelemetry2: {
      activeAeroMode: 1, activeAeroAvailable: true, activeAeroActivationDistance: 120,
      overtakeAvailable: true, overtakeActive: true, overtakeActivationDistance: 250,
      regulations2026: true, drivingWrongWay: false,
    },
  });
});

test("indexed replay restores 2026 aero state and never mixes wire formats within one UID", () => {
  const state = f1Parser.createParserState();
  for (const buf of baseFrames()) f1Parser.tryParse(buf, state);
  const extra = frame(16, 269);
  extra[29 + 23 * 10] = 1;
  f1Parser.tryParse(extra, state);
  const restored = new F1StateAccumulator();
  restored.restoreCheckpoint(state.captureCheckpoint());
  const next = baseFrames()[3];
  const expected = f1Parser.tryParse(next, state);
  expect(f1Parser.tryParse(next, restored)).toEqual(expected);
  // Same game UID, switched output format/player: discard stale 2026 caches.
  const oldMotion = frame(0, 29 + 22 * 60, 2025, 0);
  expect(f1Parser.tryParse(oldMotion, restored)).toBeNull();
  for (const [id, size] of [[1, 29 + 9], [2, 29 + 57]] as const) {
    f1Parser.tryParse(frame(id, size, 2025, 0), restored);
  }
  const legacy = f1Parser.tryParse(frame(6, 29 + 60, 2025, 0), restored);
  expect(legacy).not.toBeNull();
  expect(legacy?.f1?.packetFormat).toBeUndefined();
  expect(legacy?.f1?.carTelemetry2).toBeUndefined();
});

test("unsupported or truncated 2026 datagrams cannot mutate a valid accumulated lap", () => {
  const state = f1Parser.createParserState();
  for (const buf of baseFrames()) f1Parser.tryParse(buf, state);
  const before = state.captureCheckpoint();
  const unknownVersion = frame(6, 1448);
  unknownVersion[5] = 2;
  for (const buf of [
    Buffer.alloc(0), Buffer.alloc(28), frame(0, 1325).subarray(0, 1324),
    frame(6, 1449), frame(6, 1448, 2026, 24), frame(6, 1448, 2027), unknownVersion,
  ]) {
    expect(f1Parser.tryParse(buf, state)).toBeNull();
    expect(state.captureCheckpoint()).toEqual(before);
  }
});

test("2026 raw capture uses lossless sparse storage without sharing 2025 checkpoints", () => {
  const original = baseFrames()[3];
  const next = Buffer.from(original);
  next.writeUInt32LE(2, 19);
  next.writeUInt16LE(300, 29 + 23 * 59);
  expect(genericFrameIdentity(original)).not.toBeNull();
  const sparse = encodeGenericSparseFrame(next, original, 1);
  expect(sparse.length).toBeLessThan(next.length);
  expect(decodeGenericSparseFrame(sparse, original)).toEqual(next);
  const legacy = Buffer.from(original);
  legacy.writeUInt16LE(2025);
  expect(genericFrameIdentity(legacy)).not.toBe(genericFrameIdentity(original));
  expect(() => encodeGenericSparseFrame(next, legacy, 1)).toThrow();
});

test("2026 session keeps strategy windows and native sector boundaries at their own offsets", () => {
  const state = f1Parser.createParserState();
  for (const buf of baseFrames()) f1Parser.tryParse(buf, state);
  const session = frame(1, 926);
  session[29 + 645] = 99; // Link identifier, not a pit window.
  session[29 + 653] = 14;
  session[29 + 654] = 18;
  session.writeFloatLE(1500, 29 + 716);
  session.writeFloatLE(3200, 29 + 720);
  expect(f1Parser.tryParse(session, state)?.f1).toMatchObject({
    pitStopWindowIdealLap: 14, pitStopWindowLatestLap: 18,
    sector2LapDistanceStart: 1500, sector3LapDistanceStart: 3200,
  });
});

