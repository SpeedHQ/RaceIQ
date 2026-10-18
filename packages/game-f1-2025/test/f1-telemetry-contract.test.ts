import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompressIfGzipSync, encodeFrameLength, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { inspectDownsampleRecording, rewriteDownsampleRecording } from "@raceiq/capture-formats/session/downsample";
import { parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { f1Parser } from "../src/game-parser";
import { registerGame } from "@raceiq/shared/games/registry";
import { f1ServerAdapter } from "../src/index";
import { describe, expect, test } from "bun:test";
import { F1StateAccumulator } from "../src/f1-state";
import { analyzeLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/analyze";
import { processLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/process";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import {
  F1_HEADER_SIZE,
  type F1Header,
} from "@raceiq/capture-formats/f1-2025/f1-wire";

function header(packetId: number): F1Header {
  return {
    packetFormat: 2025,
    gameYear: 25,
    gameMajorVersion: 1,
    gameMinorVersion: 0,
    packetVersion: 1,
    packetId,
    sessionUID: 1n,
    sessionTime: 10,
    frameIdentifier: 1,
    overallFrameIdentifier: 1,
    playerCarIndex: 0,
    secondaryPlayerCarIndex: 255,
  };
}

function frame(data: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(F1_HEADER_SIZE), data]);
}

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
});
