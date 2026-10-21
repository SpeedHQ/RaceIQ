import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompressIfGzipSync, encodeFrameLength, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { inspectDownsampleRecording, rewriteDownsampleRecording } from "@raceiq/capture-downsampling";
import { parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { f1Parser } from "../src/game-parser";
import { registerGame } from "@raceiq/shared/games/registry";
import { f1ServerAdapter } from "../src/index";
import { describe, expect, test } from "bun:test";
import { F1StateAccumulator } from "../src/f1-state";
import { analyzeLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/analyze";
import { processLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/process";
import { classifyLapCategory } from "@raceiq/analysis-core/racing/laps/classification";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import {
  F1_HEADER_SIZE,
  F1_PACKET_IDS,
  type F1Header,
} from "@raceiq/capture-formats/f1-2025/f1-wire";

import { decodeF1Participants } from "../src/f1-packet-decoders";
import { f1ActorFromParticipant } from "@raceiq/game-f1-2025-metadata/driver-attribution";

test("F1 actor identity requires current human-controlled network participant", () => {
  expect(f1ActorFromParticipant("123", 0, 8, 12)).toEqual({
    gameId: "f1-2025",
    source: "f1-2025-udp-participant",
    actorId: "123:network:8",
    bindingScope: "session",
    sessionId: "123",
    clockDomain: "f1-2025-session:123",
    observedAtMs: 12_000,
  });
  expect(f1ActorFromParticipant("123", 1, 8, 12)).toBeNull();
  expect(f1ActorFromParticipant("123", 0, 255, 12)).toBeNull();
  expect(f1ActorFromParticipant("0", 0, 8, 12)).toBeNull();
  expect(f1ActorFromParticipant("123", 0, 8, Number.NaN)).toBeNull();
});
test("F1 participant decoder retains AI control and native network identity", () => {
  const packet = Buffer.alloc(1 + 57);
  packet[0] = 1;
  packet[1] = 0;
  packet[2] = 8;
  packet[3] = 42;
  packet[4] = 3;
  packet.write("Driver Name", 8, "utf8");
  expect(decodeF1Participants(packet)[0]).toEqual({
    aiControlled: 0,
    driverId: 8,
    networkId: 42,
    teamId: 3,
    name: "Driver Name",
  });
});
test("F1 actor freshness follows participant packet time and is lost across parser restore", () => {
  const accumulator = new F1StateAccumulator();
  accumulator.feed(header(F1_PACKET_IDS.MOTION), frame(Buffer.alloc(60)));
  accumulator.feed(header(F1_PACKET_IDS.SESSION), frame(Buffer.alloc(16)));
  accumulator.feed(header(F1_PACKET_IDS.LAP_DATA), frame(Buffer.alloc(57)));
  const participants = Buffer.alloc(1 + 57);
  participants[0] = 1;
  participants[1] = 0;
  participants[2] = 8;
  participants[3] = 42;
  participants[4] = 3;
  accumulator.feed({
    ...header(F1_PACKET_IDS.PARTICIPANTS),
    sessionTime: 10,
  }, frame(participants));

  const packetAt11 = accumulator.feed({
    ...header(F1_PACKET_IDS.CAR_TELEMETRY),
    sessionTime: 11,
  }, frame(Buffer.alloc(60)));
  accumulator.feed({ ...header(F1_PACKET_IDS.SESSION), sessionTime: 20 }, frame(Buffer.alloc(16)));
  const packetAt20 = accumulator.feed({
    ...header(F1_PACKET_IDS.CAR_TELEMETRY),
    sessionTime: 20,
  }, frame(Buffer.alloc(60)));
  expect(packetAt11?.driverActor?.observedAtMs).toBe(10_000);
  expect(packetAt20?.driverActor?.observedAtMs).toBe(10_000);

  const restored = new F1StateAccumulator();
  restored.restoreCheckpoint(accumulator.captureCheckpoint());
  const packetAfterRestore = restored.feed({
    ...header(F1_PACKET_IDS.CAR_TELEMETRY),
    sessionTime: 21,
  }, frame(Buffer.alloc(60)));
  expect(packetAfterRestore?.driverActor).toBeNull();
  restored.feed({ ...header(F1_PACKET_IDS.PARTICIPANTS), sessionTime: 21 }, frame(participants));
  expect(restored.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 21 }, frame(Buffer.alloc(60)))?.driverActor).toBeNull();
  restored.feed({ ...header(F1_PACKET_IDS.SESSION), sessionTime: 21 }, frame(Buffer.alloc(16)));
  expect(restored.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 21.25 }, frame(Buffer.alloc(60)))?.driverActor?.observedAtMs).toBe(21_000);
});
test("offline local human role survives networkId 255 without inventing a persistent person", () => {
  const accumulator = new F1StateAccumulator();
  accumulator.feed(header(F1_PACKET_IDS.MOTION), frame(Buffer.alloc(60)));
  accumulator.feed(header(F1_PACKET_IDS.SESSION), frame(Buffer.alloc(16)));
  accumulator.feed(header(F1_PACKET_IDS.LAP_DATA), frame(Buffer.alloc(57)));
  const participants = Buffer.alloc(1 + 57 * 2);
  participants[0] = 2;
  participants[1] = 0;
  participants[3] = 255;
  participants[58] = 0;
  participants[60] = 255;
  participants.write("Same Name", 8, "utf8");
  participants.write("Same Name", 65, "utf8");
  accumulator.feed(header(F1_PACKET_IDS.PARTICIPANTS), frame(participants));
  const offline = accumulator.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 10.25 }, frame(Buffer.alloc(60)));
  expect(offline?.driverActor).toEqual({
    gameId: "f1-2025", source: "f1-2025-udp-local-controller", actorId: "1:local-player",
    bindingScope: "session", sessionId: "1", clockDomain: "f1-2025-session:1", observedAtMs: 10_000,
    evidenceExpiresAtMs: 11_000,
  });
  participants[1] = 1;
  accumulator.feed({ ...header(F1_PACKET_IDS.PARTICIPANTS), sessionTime: 11 }, frame(participants));
  const ai = accumulator.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 11.25 }, frame(Buffer.alloc(60)));
  expect(ai?.driverActor).toBeNull();
  accumulator.reset();
  accumulator.feed({ ...header(F1_PACKET_IDS.MOTION), sessionUID: 2n }, frame(Buffer.alloc(60)));
  accumulator.feed({ ...header(F1_PACKET_IDS.SESSION), sessionUID: 2n }, frame(Buffer.alloc(16)));
  accumulator.feed({ ...header(F1_PACKET_IDS.LAP_DATA), sessionUID: 2n }, frame(Buffer.alloc(57)));
  participants[1] = 0;
  accumulator.feed({ ...header(F1_PACKET_IDS.PARTICIPANTS), sessionUID: 2n }, frame(participants));
  const nextSession = accumulator.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionUID: 2n }, frame(Buffer.alloc(60)));
  expect(nextSession?.driverActor?.actorId).toBe("2:local-player");
});
test("native SESSION control gates reject paused, spectator, truncated and stale observations", () => {
  const accumulator = new F1StateAccumulator();
  accumulator.feed(header(F1_PACKET_IDS.MOTION), frame(Buffer.alloc(60)));
  accumulator.feed(header(F1_PACKET_IDS.LAP_DATA), frame(Buffer.alloc(57)));
  const participants = Buffer.alloc(58);
  participants[0] = 1;
  participants[3] = 7;
  accumulator.feed(header(F1_PACKET_IDS.PARTICIPANTS), frame(participants));
  accumulator.feed(header(F1_PACKET_IDS.SESSION), frame(Buffer.alloc(16)));
  expect(accumulator.feed(header(F1_PACKET_IDS.CAR_TELEMETRY), frame(Buffer.alloc(60)))?.driverActor?.actorId).toBe("1:network:7");
  for (const offset of [14, 15]) {
    const inactive = Buffer.alloc(16);
    inactive[offset] = 1;
    expect(accumulator.feed(header(F1_PACKET_IDS.SESSION), frame(inactive))?.driverActor).toBeNull();
  }
  expect(accumulator.feed(header(F1_PACKET_IDS.SESSION), frame(Buffer.alloc(9)))?.driverActor).toBeNull();
  accumulator.feed(header(F1_PACKET_IDS.SESSION), frame(Buffer.alloc(16)));
  expect(accumulator.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 11.001 }, frame(Buffer.alloc(60)))?.driverActor).toBeNull();
  accumulator.feed({ ...header(F1_PACKET_IDS.SESSION), sessionTime: 11.001 }, frame(Buffer.alloc(16)));
  expect(accumulator.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 11.25 }, frame(Buffer.alloc(60)))?.driverActor?.observedAtMs).toBe(10_000);
  accumulator.invalidateDriverEvidence();
  expect(accumulator.feed({ ...header(F1_PACKET_IDS.CAR_TELEMETRY), sessionTime: 11.25 }, frame(Buffer.alloc(60)))?.driverActor).toBeNull();
});

function header(packetId: number, sessionTime = 10, sessionUID = 1n): F1Header {
  return {
    packetFormat: 2025,
    gameYear: 25,
    gameMajorVersion: 1,
    gameMinorVersion: 0,
    packetVersion: 1,
    packetId,
    sessionUID,
    sessionTime,
    frameIdentifier: 1,
    overallFrameIdentifier: 1,
    playerCarIndex: 0,
    secondaryPlayerCarIndex: 255,
  };
}

function frame(data: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]);
}

function nativePacket(packetHeader: F1Header, data: Buffer): Buffer {
  const packet = frame(data);
  packet.writeUInt16LE(packetHeader.packetFormat, 0);
  packet.writeUInt8(packetHeader.gameYear, 2);
  packet.writeUInt8(packetHeader.gameMajorVersion, 3);
  packet.writeUInt8(packetHeader.gameMinorVersion, 4);
  packet.writeUInt8(packetHeader.packetVersion, 5);
  packet.writeUInt8(packetHeader.packetId, 6);
  packet.writeBigUInt64LE(packetHeader.sessionUID, 7);
  packet.writeFloatLE(packetHeader.sessionTime, 15);
  packet.writeUInt32LE(packetHeader.frameIdentifier, 19);
  packet.writeUInt32LE(packetHeader.overallFrameIdentifier, 23);
  packet.writeUInt8(packetHeader.playerCarIndex, 27);
  packet.writeUInt8(packetHeader.secondaryPlayerCarIndex, 28);
  return packet;
}

function nativeAccumulator(sessionTime = 0, sessionUID = 1n): F1StateAccumulator {
  const state = f1Parser.createParserState();
  const session = Buffer.alloc(9);
  session.writeUInt8(1, 6);
  for (const [id, bytes] of [
    [F1_PACKET_IDS.MOTION, Buffer.alloc(60)],
    [F1_PACKET_IDS.SESSION, session],
    [F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)],
    [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)],
  ] as const) {
    f1Parser.tryParse(nativePacket(header(id, sessionTime, sessionUID), bytes), state);
  }
  return state;
}

function parseNative(
  state: F1StateAccumulator,
  packetId: number,
  data: Buffer,
  sessionTime: number,
  sessionUID = 1n,
): TelemetryPacket | null {
  return f1Parser.tryParse(nativePacket(header(packetId, sessionTime, sessionUID), data), state);
}

test("native session packet decodes current F1 25 session IDs and preserves unknown values", () => {
  const sessionType = (code: number): string => {
    const state = nativeAccumulator();
    const session = Buffer.alloc(125);
    session.writeUInt8(code, 6);
    const packet = f1Parser.tryParse(nativePacket(header(F1_PACKET_IDS.SESSION), session), state);
    return packet?.f1?.sessionType ?? "missing";
  };

  expect(sessionType(10)).toBe("sprint-shootout-1");
  expect(sessionType(14)).toBe("one-shot-sprint-shootout");
  expect(sessionType(15)).toBe("race");
  expect(sessionType(16)).toBe("race-2");
  expect(sessionType(17)).toBe("race-3");
  expect(sessionType(18)).toBe("time-trial");
  expect(sessionType(19)).toBe("unknown");
});

function wireFrame(packetId: number, sessionTime: number, frameId: number, data: Buffer): Buffer {
  const buf = frame(data);
  buf.writeUInt16LE(2025, 0);
  buf[2] = 25;
  buf[3] = 1;
  buf[5] = 1;
  buf[6] = packetId;
  buf.writeBigUInt64LE(1n, 7);
  buf.writeFloatLE(sessionTime, 15);
  buf.writeUInt32LE(frameId, 19);
  buf.writeUInt32LE(frameId, 23);
  buf[27] = 0;
  buf[28] = 255;
  return buf;
}
test("F1 parser checkpoint encodes bigint identity and restores accumulated state", () => {
  const continuous = new F1StateAccumulator();
  continuous.feed(header(0), frame(Buffer.alloc(60)));
  continuous.feed(header(1), frame(Buffer.alloc(9)));
  continuous.feed(header(2), frame(Buffer.alloc(57)));
  const restored = new F1StateAccumulator();
  restored.restoreCheckpoint(continuous.captureCheckpoint());
  const status = Buffer.alloc(55);
  status.writeFloatLE(55, 5);
  const expected = continuous.feed(header(7), frame(status));
  const actual = restored.feed(header(7), frame(status));
  expect(actual).toEqual(expected);
  expect(() => restored.restoreCheckpoint(Buffer.from('{"format":"raceiq:f1-2025-parser","version":2}')))
    .toThrow("Invalid or unsupported F1-2025 parser checkpoint");
});

test("F1 checkpoint rejects malformed nested fields before changing accumulator", () => {
  const accumulator = new F1StateAccumulator();
  accumulator.feed(header(0), frame(Buffer.alloc(60)));
  const before = accumulator.captureCheckpoint();
  const checkpoint = JSON.parse(new TextDecoder().decode(before));
  checkpoint.participants = [{ driverId: 1, teamId: 2 }];
  checkpoint.driverHistory = [[0, {}]];
  expect(() => accumulator.restoreCheckpoint(Buffer.from(JSON.stringify(checkpoint))))
    .toThrow("Invalid or unsupported F1-2025 parser checkpoint");
  expect(accumulator.captureCheckpoint()).toEqual(before);
});
test("F1 checkpoint rejects malformed optional timestamps atomically", () => {
  const accumulator = nativeAccumulator(2);
  const baseline = accumulator.captureCheckpoint();
  for (const key of [
    "carStatusUpdatedAt", "sessionUpdatedAt", "seenStartLightsAt", "raceStartAt", "lastHeaderSessionTime",
  ]) {
    const malformed = JSON.parse(new TextDecoder().decode(baseline));
    malformed[key] = Number.NaN;
    expect(() => accumulator.restoreCheckpoint(Buffer.from(JSON.stringify(malformed))))
      .toThrow("Invalid or unsupported F1-2025 parser checkpoint");
    expect(accumulator.captureCheckpoint()).toEqual(baseline);
  }
});
test("F1 checkpoint preserves native start and freshness evidence; old v1 checkpoints remain readable", () => {
  const event = (code: string, lights?: number) => {
    const data = Buffer.alloc(lights === undefined ? 4 : 5);
    data.write(code, 0, 4, "ascii");
    if (lights !== undefined) data.writeUInt8(lights, 4);
    return data;
  };
  const state = nativeAccumulator(1);
  const status = parseNative(state, F1_PACKET_IDS.CAR_STATUS, Buffer.alloc(55), 2)!;
  const session = Buffer.alloc(125);
  session.writeUInt8(1, 6);
  const sessionPacket = parseNative(state, F1_PACKET_IDS.SESSION, session, 2)!;
  parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 3);
  const restored = new F1StateAccumulator();
  restored.restoreCheckpoint(state.captureCheckpoint());
  const afterLightsOut = parseNative(restored, F1_PACKET_IDS.EVENT, event("LGOT"), 4)!;
  expect(afterLightsOut.f1?.raceStartAt).toBe(4);
  expect(afterLightsOut.f1?.safetyCarStatusUpdatedAt).toBe(2);
  expect(status.f1?.vehicleFIAFlagsUpdatedAt).toBe(2);
  expect(sessionPacket.f1?.safetyCarStatusUpdatedAt).toBe(2);

  const oldCheckpoint = JSON.parse(new TextDecoder().decode(state.captureCheckpoint()));
  delete oldCheckpoint.carStatusUpdatedAt;
  delete oldCheckpoint.sessionUpdatedAt;
  delete oldCheckpoint.seenStartLightsAt;
  delete oldCheckpoint.raceStartAt;
  delete oldCheckpoint.lastHeaderSessionTime;
  const oldState = new F1StateAccumulator();
  expect(() => oldState.restoreCheckpoint(Buffer.from(JSON.stringify(oldCheckpoint)))).not.toThrow();
  const afterOldRestore = parseNative(oldState, F1_PACKET_IDS.EVENT, event("LGOT"), 4)!;
  expect(afterOldRestore.f1?.raceStartAt).toBeUndefined();
  expect(afterOldRestore.f1?.vehicleFIAFlagsUpdatedAt).toBeUndefined();
  expect(afterOldRestore.f1?.safetyCarStatusUpdatedAt).toBeUndefined();
  const rewindCheckpoint = JSON.parse(new TextDecoder().decode(state.captureCheckpoint()));
  rewindCheckpoint.lastHeaderSessionTime = 10;
  const rewindState = new F1StateAccumulator();
  rewindState.restoreCheckpoint(Buffer.from(JSON.stringify(rewindCheckpoint)));
  parseNative(rewindState, F1_PACKET_IDS.EVENT, event("STLG", 5), 11);
  const afterRewindRestore = parseNative(rewindState, F1_PACKET_IDS.EVENT, event("LGOT"), 1)!;
  expect(afterRewindRestore.f1?.raceStartAt).toBeUndefined();
});
describe("F1 telemetry contract", () => {
  test("downsample replay preserves F1 lap endpoint family state", async () => {
    const root = mkdtempSync(join(tmpdir(), "f1-downsample-replay-"));
    try {
      const sourceFrames: Buffer[] = [];
      const motionData = (position: number) => {
        const data = Buffer.alloc(60);
        data.writeFloatLE(position, 0);
        return data;
      };
      const telemetryData = (speed: number) => {
        const data = Buffer.alloc(60);
        data.writeUInt16LE(speed, 0);
        return data;
      };
      const motionExData = (angle: number) => {
        const data = Buffer.alloc(224);
        data.writeFloatLE(angle, 168);
        return data;
      };
      const add = (id: number, time: number, tick: number, data: Buffer) =>
        sourceFrames.push(wireFrame(id, time, tick, data));
      add(0, 0, 0, motionData(0));
      add(1, 0, 0, Buffer.alloc(9));
      add(2, 0, 0, Buffer.alloc(57));
      add(6, 0, 0, telemetryData(100));
      add(13, 0, 0, motionExData(0));
      for (let tick = 1; tick <= 11; tick++) {
        const time = tick * 0.011;
        add(0, time, tick, motionData(tick));
        add(6, time, tick, telemetryData(100 + tick));
        add(13, time, tick, motionExData(tick));
      }
      const source = {
        gameId: "f1-2025" as const,
        records: async function* () {
          let offset = 0;
          for (const frame of sourceFrames) {
            const endOffset = offset + encodeFrameLength(frame.length).length + frame.length;
            yield { kind: "frame" as const, offset, endOffset, frame };
            offset = endOffset;
          }
        },
        createTelemetryParser: () => {
          const state = f1Parser.createParserState();
          return {
            parse(frame: Buffer) {
              f1Parser.tryParse(frame, state);
              return f1Parser.canHandle(frame) && [0, 1, 2, 6, 13].includes(parseF1Header(frame).packetId);
            },
            reset() { state.reset(); },
          };
        },
        lapIndexes: [{ lapId: 1, rawByteOffset: 0, rawFrameCount: 35 }],
      };
      const outputPath = join(root, "replayed.bin");
      const inspection = await inspectDownsampleRecording(source);
      const result = await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });

      const replayState = f1Parser.createParserState();
      let endpoint: TelemetryPacket | null = null;
      const lap = result.lapIndexes[0]!;
      let replayedLapFrames = 0;
      for (const record of iterateSessionCaptureRecords(decompressIfGzipSync(readFileSync(outputPath)))) {
        if (record.kind !== "frame" || record.offset < lap.rawByteOffset) continue;
        const packet = f1Parser.tryParse(record.frame, replayState);
        if (packet) endpoint = packet;
        if (++replayedLapFrames === lap.rawFrameCount) break;
      }

      expect(endpoint?.PositionX).toBe(-10);
      expect(endpoint?.Speed).toBeCloseTo(110 / 3.6);
      expect(endpoint?.f1?.motionEx?.frontWheelsAngle).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("downsample seeds first retained F1 lap sample from its preceding telemetry state", async () => {
    const root = mkdtempSync(join(tmpdir(), "f1-downsample-lap-seed-"));
    try {
      const sourceFrames: Buffer[] = [];
      const telemetryData = (speed: number) => {
        const data = Buffer.alloc(60);
        data.writeUInt16LE(speed, 0);
        return data;
      };
      const add = (id: number, time: number, tick: number, data: Buffer) =>
        sourceFrames.push(wireFrame(id, time, tick, data));
      add(0, 0, 0, Buffer.alloc(60));
      add(1, 0, 0, Buffer.alloc(9));
      add(2, 0, 0, Buffer.alloc(57));
      add(6, 0, 0, telemetryData(100));
      add(6, 0.01, 1, telemetryData(200));
      add(2, 0.011, 2, Buffer.alloc(57));
      add(6, 0.02, 3, telemetryData(300));
      add(2, 0.021, 4, Buffer.alloc(57));
      add(6, 0.03, 5, telemetryData(400));
      add(2, 0.031, 6, Buffer.alloc(57));
      const lapOffset = sourceFrames.slice(0, 5).reduce((offset, value) =>
        offset + encodeFrameLength(value.length).length + value.length, 0);
      const source = {
        gameId: "f1-2025" as const,
        records: async function* () {
          let offset = 0;
          for (const frame of sourceFrames) {
            const endOffset = offset + encodeFrameLength(frame.length).length + frame.length;
            yield { kind: "frame" as const, offset, endOffset, frame };
            offset = endOffset;
          }
        },
        createTelemetryParser: () => {
          const state = f1Parser.createParserState();
          return {
            parse(frame: Buffer) {
              f1Parser.tryParse(frame, state);
              return f1Parser.canHandle(frame);
            },
            reset() { state.reset(); },
          };
        },
        lapIndexes: [{ lapId: 1, rawByteOffset: lapOffset, rawFrameCount: 5 }],
      };
      const outputPath = join(root, "replayed.bin");
      const inspection = await inspectDownsampleRecording(source);
      const result = await rewriteDownsampleRecording(source, inspection, { targetHz: 50, outputPath, gzip: false });
      const replayState = f1Parser.createParserState();
      const lap = result.lapIndexes[0]!;
      let firstSample: TelemetryPacket | null = null;
      for (const record of iterateSessionCaptureRecords(decompressIfGzipSync(readFileSync(outputPath)))) {
        if (record.kind !== "frame") continue;
        if (record.offset < lap.rawByteOffset) {
          f1Parser.primeParserState(record.frame, replayState);
          continue;
        }
        firstSample = f1Parser.tryParse(record.frame, replayState) ?? firstSample;
        if (firstSample) break;
      }
      expect(firstSample?.Speed).toBeCloseTo(200 / 3.6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("normalizes fuel to a fraction and preserves power in watts", () => {
    const accumulator = new F1StateAccumulator();

    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(2), frame(Buffer.alloc(57)));

    const carTelemetry = Buffer.alloc(60);
    carTelemetry.writeUInt8(90, 32);
    carTelemetry.writeUInt8(88, 36);
    accumulator.feed(header(6), frame(carTelemetry));

    const carStatus = Buffer.alloc(55);
    carStatus.writeFloatLE(55, 5);
    carStatus.writeFloatLE(110, 9);
    carStatus.writeFloatLE(500_000, 29);
    carStatus.writeFloatLE(120_000, 33);
    const packet = accumulator.feed(header(7), frame(carStatus));

    expect(packet).not.toBeNull();
    expect(packet!.Fuel).toBeCloseTo(0.5);
    expect(packet!.FuelCapacity).toBeCloseTo(110);
    expect(packet!.Power).toBeCloseTo(620_000);
    expect(packet!.TireTempFL).toBe(90);
    expect(packet!.TireCarcassTempFL).toBe(88);
  });

  test("reads player's raw lap-invalid flag into emitted telemetry", () => {
    const accumulator = new F1StateAccumulator();
    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(6), frame(Buffer.alloc(60)));
    const lapData = Buffer.alloc(57);
    for (const raw of [0, 1] as const) {
      lapData.writeUInt8(raw, 37);
      const packet = accumulator.feed(header(2), frame(lapData));
      expect(packet?.f1?.currentLapInvalid).toBe(raw);
    }
  });

  test("real multi-packet snapshots support sustained DRS and ERS observations", () => {
    registerGame(f1ServerAdapter);
    for (const drsActive of [false, true]) {
      const accumulator = new F1StateAccumulator();
      const motion = Buffer.alloc(60);
      accumulator.feed({ ...header(0), sessionTime: 0 }, frame(motion));
      accumulator.feed({ ...header(1), sessionTime: 0 }, frame(Buffer.alloc(9)));
      accumulator.feed({ ...header(2), sessionTime: 0 }, frame(Buffer.alloc(57)));
      accumulator.feed({ ...header(10), sessionTime: 0 }, frame(Buffer.alloc(46)));
      const telemetry = Buffer.alloc(60);
      telemetry.writeUInt16LE(216, 0);
      telemetry.writeFloatLE(1, 2);
      telemetry.writeInt8(6, 15);
      telemetry.writeUInt16LE(10_000, 16);
      telemetry.writeUInt8(drsActive ? 1 : 0, 18);
      const status = Buffer.alloc(55);
      status.writeUInt16LE(15_000, 17);
      status.writeFloatLE(50, 5);
      status.writeFloatLE(100, 9);
      status.writeInt8(1, 28);
      status.writeUInt8(2, 41);
      const packets: TelemetryPacket[] = [];
      for (let tick = 0; tick <= 80; tick++) {
        const time = tick / 20;
        status.writeUInt8(time >= 0.2 ? 1 : 0, 22);
        status.writeFloatLE(10 - time * 0.01, 13);
        status.writeFloatLE(Math.max(0, 100_000 * (1 - time)), 37);
        status.writeFloatLE(100_000 * Math.min(time, 1), 50);
        status.writeFloatLE(time >= 1 ? 1_000 : 120_000, 33);
        for (const [packetId, data] of [[6, telemetry], [7, status], [0, motion]] as const) {
          const packet = accumulator.feed({ ...header(packetId), sessionTime: time }, frame(data));
          if (packet) packets.push(packet);
        }
      }
      const insights = analyzeLap(processLap(packets, "f1-2025").packets, "f1-2025");
      expect(insights.some((insight) => insight.id === "driving-unused-drs")).toBe(!drsActive);
      expect(insights.some((insight) => insight.id === "mech-ers-depletion")).toBe(true);
    }
  });

  test("preserves authoritative final classification packet", () => {
    const accumulator = new F1StateAccumulator();
    accumulator.feed(header(0), frame(Buffer.alloc(60)));
    accumulator.feed(header(1), frame(Buffer.alloc(9)));
    accumulator.feed(header(2), frame(Buffer.alloc(57)));
    accumulator.feed(header(6), frame(Buffer.alloc(60)));

    const finalClassification = Buffer.alloc(1 + 22 * 46);
    finalClassification.writeUInt8(1, 0);
    finalClassification.writeUInt8(2, 1);
    finalClassification.writeUInt8(5, 3);
    finalClassification.writeUInt8(5, 6);
    finalClassification.writeUInt8(6, 7);
    finalClassification.writeUInt32LE(90_123, 8);
    const packet = accumulator.feed(header(8), frame(finalClassification));

    expect(packet?.RacePosition).toBe(2);
    expect(packet?.BestLap).toBeCloseTo(90.123);
    expect(packet?.f1?.gridPosition).toBe(5);
    expect(packet?.f1?.resultStatus).toBe(5);
    expect(packet?.f1?.resultReason).toBe(6);
    expect(packet?.f1?.resultSource).toBe("final-classification");
  });
  test("primes parser state without emitting a packet", () => {
    const accumulator = new F1StateAccumulator();
    const motion = frame(Buffer.alloc(60));
    const session = frame(Buffer.alloc(9));
    const lapData = frame(Buffer.alloc(57));
    accumulator.primeParserState(header(0), motion);
    accumulator.primeParserState(header(1), session);
    accumulator.primeParserState(header(2), lapData);
    expect(accumulator.feed(header(6), frame(Buffer.alloc(60)))).not.toBeNull();
  });
  // F1 25 UDP v3 semantics: FIA flag 3 is yellow; SafetyCar 1/2 are SC/VSC and 3 is formation (ADR0011).
  test("native FIA flags and safety-car status distinguish yellow, non-yellow, and formation", () => {
    const state = nativeAccumulator();
    const lapPackets: TelemetryPacket[] = [];
    for (const [time, flag] of [[1, 3], [2, 2], [3, 0]] as const) {
      const status = Buffer.alloc(55);
      status.writeInt8(flag, 28);
      const packet = parseNative(state, F1_PACKET_IDS.CAR_STATUS, status, time);
      if (packet) lapPackets.push(packet);
    }
    expect(lapPackets[0]?.f1?.vehicleFIAFlags).toBe(3);
    expect(classifyLapCategory(lapPackets, null, undefined, true)).toBe("caution");
    const freshSession = Buffer.alloc(125);
    freshSession.writeUInt8(1, 6);
    freshSession.writeUInt8(0, 124);
    const fresh = parseNative(state, F1_PACKET_IDS.SESSION, freshSession, 3)!;
    const clearLapPackets = [lapPackets[1]!, fresh];
    expect(classifyLapCategory(clearLapPackets, null, undefined, true)).toBe("pace");

    for (const [statusValue, expected] of [[1, "caution"], [2, "caution"], [3, null]] as const) {
      const stateForStatus = nativeAccumulator();
      const session = Buffer.alloc(125);
      session.writeUInt8(1, 6);
      session.writeUInt8(statusValue, 124);
      const first = parseNative(stateForStatus, F1_PACKET_IDS.SESSION, session, 1)!;
      const clearFlags = Buffer.alloc(55);
      const firstWithClearFlags = parseNative(stateForStatus, F1_PACKET_IDS.CAR_STATUS, clearFlags, 1)!;
      const later = parseNative(stateForStatus, F1_PACKET_IDS.SESSION, session, 2)!;
      expect(first.f1?.safetyCarStatus).toBe(statusValue);
      expect(classifyLapCategory([firstWithClearFlags, later], null, undefined, true)).toBe(expected);
    }

    const absentState = nativeAccumulator();
    const withoutEvidence = parseNative(absentState, F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60), 20)!;
    expect(withoutEvidence.f1?.vehicleFIAFlags).toBeUndefined();
    expect(withoutEvidence.f1?.vehicleFIAFlagsUpdatedAt).toBeUndefined();
    expect(withoutEvidence.f1?.safetyCarStatusUpdatedAt).toBe(0);
    expect(classifyLapCategory([withoutEvidence], null, undefined, true)).toBeNull();
  });

  test("a transient native yellow remains attributable to its lap after green", () => {
    const state = nativeAccumulator();
    const yellowStatus = Buffer.alloc(55);
    yellowStatus.writeInt8(3, 28);
    const yellow = parseNative(state, F1_PACKET_IDS.CAR_STATUS, yellowStatus, 10)!;
    const greenStatus = Buffer.alloc(55);
    greenStatus.writeInt8(0, 28);
    const green = parseNative(state, F1_PACKET_IDS.CAR_STATUS, greenStatus, 11)!;
    const greenSession = Buffer.alloc(125);
    greenSession.writeUInt8(1, 6);
    greenSession.writeUInt8(0, 124);
    const refreshedGreen = parseNative(state, F1_PACKET_IDS.SESSION, greenSession, 11)!;
    expect(refreshedGreen.f1?.vehicleFIAFlags).toBe(0);
    expect(refreshedGreen.f1?.vehicleFIAFlagsUpdatedAt).toBe(11);
    expect(classifyLapCategory([yellow, green], null, undefined, true)).toBe("caution");
    expect(classifyLapCategory([green, refreshedGreen], null, undefined, true)).toBe("pace");
    const nextLapStatus = parseNative(state, F1_PACKET_IDS.CAR_STATUS, greenStatus, 12)!;
    const nextLapSessionData = Buffer.alloc(125);
    nextLapSessionData.writeUInt8(1, 6);
    nextLapSessionData.writeUInt8(0, 124);
    const nextLapSession = parseNative(state, F1_PACKET_IDS.SESSION, nextLapSessionData, 12)!;
    expect(classifyLapCategory([nextLapStatus, nextLapSession], null, undefined, true)).toBe("pace");
  });

  test("standing start requires native STLG then LGOT and resets across state boundaries", () => {
    const state = nativeAccumulator(1);
    const event = (code: string, lights?: number) => {
      const data = Buffer.alloc(lights === undefined ? 4 : 5);
      data.write(code, 0, 4, "ascii");
      if (lights !== undefined) data.writeUInt8(lights, 4);
      return data;
    };
    const withoutLights = parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 2)!;
    expect(withoutLights.f1?.raceStartAt).toBeUndefined();
    const clearStatus = Buffer.alloc(55);
    const noStartFlag = parseNative(state, F1_PACKET_IDS.CAR_STATUS, clearStatus, 2)!;
    const clearSession = Buffer.alloc(125);
    clearSession.writeUInt8(1, 6);
    const noStartSession = parseNative(state, F1_PACKET_IDS.SESSION, clearSession, 2)!;
    const noStartLap = [noStartFlag, noStartSession];
    expect(classifyLapCategory(noStartLap, null, undefined, true)).toBe("pace");
    parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 3);
    const afterLights = parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 4)!;
    expect(afterLights.f1?.raceStartAt).toBe(4);
    expect(classifyLapCategory([afterLights], null, undefined, true)).toBe("grid_start");

    parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 5);
    const nextSession = Buffer.alloc(9);
    nextSession.writeUInt8(1, 6);
    for (const [packetId, data] of [
      [F1_PACKET_IDS.MOTION, Buffer.alloc(60)],
      [F1_PACKET_IDS.SESSION, nextSession],
      [F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)],
      [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)],
    ] as const) {
      parseNative(state, packetId, data, 5.5, 2n);
    }
    const unknownSession = parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 6, 2n)!;
    expect(unknownSession.f1?.raceStartAt).toBeUndefined();

    const rewound = nativeAccumulator(10);
    parseNative(rewound, F1_PACKET_IDS.EVENT, event("STLG", 5), 11);
    const rewindPacket = parseNative(rewound, F1_PACKET_IDS.EVENT, event("LGOT"), 1)!;
    expect(rewindPacket.f1?.raceStartAt).toBeUndefined();
    const reset = nativeAccumulator(1);
    parseNative(reset, F1_PACKET_IDS.EVENT, event("STLG", 5), 2);
    reset.reset();
    const resetSession = Buffer.alloc(9);
    resetSession.writeUInt8(1, 6);
    for (const [packetId, data] of [
      [F1_PACKET_IDS.MOTION, Buffer.alloc(60)],
      [F1_PACKET_IDS.SESSION, resetSession],
      [F1_PACKET_IDS.LAP_DATA, Buffer.alloc(57)],
      [F1_PACKET_IDS.CAR_TELEMETRY, Buffer.alloc(60)],
    ] as const) {
      parseNative(reset, packetId, data, 3);
    }
    const resetLightsOut = parseNative(reset, F1_PACKET_IDS.EVENT, event("LGOT"), 4)!;
    expect(resetLightsOut.f1?.raceStartAt).toBeUndefined();
  });
  test("lights-out at time zero classifies lap one, not later laps", () => {
    const state = nativeAccumulator();
    const event = (code: string, lights?: number) => {
      const data = Buffer.alloc(lights === undefined ? 4 : 5);
      data.write(code, 0, 4, "ascii");
      if (lights !== undefined) data.writeUInt8(lights, 4);
      return data;
    };
    parseNative(state, F1_PACKET_IDS.EVENT, event("STLG", 5), 0);
    parseNative(state, F1_PACKET_IDS.EVENT, event("LGOT"), 0);

    const firstLapData = Buffer.alloc(57);
    firstLapData.writeUInt8(1, 33);
    const firstLap = parseNative(state, F1_PACKET_IDS.LAP_DATA, firstLapData, 0.342)!;
    expect(firstLap.f1?.raceStartAt).toBe(0);
    expect(firstLap.LapNumber).toBe(1);
    expect(classifyLapCategory([firstLap], null, undefined, true)).toBe("grid_start");

    const clearStatus = parseNative(
      state,
      F1_PACKET_IDS.CAR_STATUS,
      Buffer.alloc(55),
      90,
    )!;
    const clearSessionData = Buffer.alloc(125);
    clearSessionData.writeUInt8(1, 6);
    const clearSession = parseNative(state, F1_PACKET_IDS.SESSION, clearSessionData, 90)!;
    expect(clearStatus.f1?.vehicleFIAFlagsUpdatedAt).toBe(90);
    expect(clearSession.f1?.safetyCarStatusUpdatedAt).toBe(90);
    const secondLapData = Buffer.alloc(57);
    secondLapData.writeUInt8(2, 33);
    const secondLap = parseNative(state, F1_PACKET_IDS.LAP_DATA, secondLapData, 90)!;
    expect(secondLap.f1?.raceStartAt).toBe(0);
    expect(secondLap.LapNumber).toBe(2);
    expect(secondLap.f1?.vehicleFIAFlagsUpdatedAt).toBe(90);
    expect(secondLap.f1?.safetyCarStatusUpdatedAt).toBe(90);
    expect(classifyLapCategory([secondLap], null, undefined, true)).toBe("pace");
  });
});
