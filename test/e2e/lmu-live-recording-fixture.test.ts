import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { open, type FileHandle } from "node:fs/promises";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { LMU_TELEMETRY, LMU_WHEEL, LMU_WHEEL_SIZE } from "../../server/games/lmu/layout";
import { decodeLMUSourceFrame } from "../../server/games/lmu/source-frame";
import { normalizeLMUSourceFrame } from "../../server/games/lmu/normalizer";
import type { TelemetryPacket } from "../../shared/telemetry/types";
const FIXTURE = "test/artifacts/laps/lmu-2026-09-22T21-18-23-218Z.bin";
const HEADER_SIZE = 16;
const FRAME_HEADER_SIZE = 5;
const SAMPLE_INDICES = [0, 500, 5_000, 10_000, 20_000, 30_000, 40_000];

type Sample = {
  packet: TelemetryPacket;
  nativeWear: number[];
  nativeDelta: number;
};

async function readSample(handle: FileHandle, frameSize: number, index: number): Promise<Sample> {
  const offset = HEADER_SIZE + index * (FRAME_HEADER_SIZE + frameSize);
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  await handle.read(header, 0, header.length, offset);
  expect(header.readUInt8(0)).toBe(0);
  expect(header.readUInt32LE(1)).toBe(frameSize);

  const frameBytes = Buffer.alloc(frameSize);
  await handle.read(frameBytes, 0, frameBytes.length, offset + FRAME_HEADER_SIZE);
  const frame = decodeLMUSourceFrame(frameBytes);
  if (!frame) throw new Error(`LMU fixture frame ${index} failed to decode`);
  const packet = normalizeLMUSourceFrame(frame);
  const nativeWear = [0, 1, 2, 3].map((wheel) =>
    frame.telemetry.readDoubleLE(
      LMU_TELEMETRY.wheels + wheel * LMU_WHEEL_SIZE + LMU_WHEEL.wear,
    ),
  );
  return {
    packet,
    nativeWear,
    nativeDelta: frame.telemetry.readDoubleLE(LMU_TELEMETRY.deltaBest),
  };
}

let samples: Sample[];

beforeAll(async () => {
  const handle = await open(FIXTURE, "r");
  try {
    const firstHeader = Buffer.alloc(FRAME_HEADER_SIZE);
    await handle.read(firstHeader, 0, firstHeader.length, HEADER_SIZE);
    const frameSize = firstHeader.readUInt32LE(1);
    samples = [];
    for (const index of SAMPLE_INDICES) {
      samples.push(await readSample(handle, frameSize, index));
    }
  } finally {
    await handle.close();
  }
});

afterAll(() => stopMaintenanceTasks());

describe("LMU live recording fixture", () => {
  test("preserves practice session identity", () => {
    expect(samples.map(({ packet }) => packet.lmu?.sessionType)).toEqual(
      SAMPLE_INDICES.map(() => "practice-1"),
    );
    expect(samples.map(({ packet }) => packet.lmu?.sessionTypeOrdinal)).toEqual(
      SAMPLE_INDICES.map(() => 1),
    );
  });

  test("normalizes LMU remaining health into consumed wear", () => {
    for (const { packet, nativeWear } of samples) {
      expect(packet.TireWearFL).toBeCloseTo(1 - nativeWear[0]!, 7);
      expect(packet.TireWearFR).toBeCloseTo(1 - nativeWear[1]!, 7);
      expect(packet.TireWearRL).toBeCloseTo(1 - nativeWear[2]!, 7);
      expect(packet.TireWearRR).toBeCloseTo(1 - nativeWear[3]!, 7);
    }
    expect(samples[0]!.packet.TireWearFL).toBeCloseTo(0, 7);
    expect(samples.at(-1)!.packet.TireWearFL).toBeGreaterThan(0.05);
  });

  test("retains game's delta-to-best channel", () => {
    for (const { packet, nativeDelta } of samples) {
      expect(packet.lmu?.deltaBest).toBeCloseTo(nativeDelta, 12);
    }
    expect(samples.some(({ nativeDelta }) => Math.abs(nativeDelta) > 0.01)).toBe(true);
  });
});
