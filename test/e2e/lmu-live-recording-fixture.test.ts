import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { LMU_TELEMETRY, LMU_WHEEL, LMU_WHEEL_SIZE } from "../../server/games/lmu/layout";
import { decodeLMUSourceFrame } from "../../server/games/lmu/source-frame";
import { normalizeLMUSourceFrame } from "../../server/games/lmu/normalizer";
import type { TelemetryPacket } from "../../shared/telemetry/types";
const FIXTURE = "test/artifacts/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz";
const HEADER_SIZE = 16;
const FRAME_HEADER_SIZE = 5;
const SAMPLE_INDICES = [0, 500, 5_000, 10_000, 20_000, 30_000, 40_000];

type Sample = {
  packet: TelemetryPacket;
  nativeWear: number[];
  nativeDelta: number;
};

async function readSamples(): Promise<Sample[]> {
  const stream = createReadStream(FIXTURE).pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const readExact = async (size: number): Promise<Buffer> => {
    while (buffered.length < size) {
      const next = await iterator.next();
      if (next.done) throw new Error(`LMU fixture ended before ${size} bytes`);
      buffered = Buffer.concat([buffered, next.value as Buffer]);
    }
    const result = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return result;
  };

  const dumpHeader = await readExact(HEADER_SIZE);
  expect(dumpHeader.subarray(0, 8).toString("ascii")).toBe("LMUQDMP\0");
  const firstFrameHeader = await readExact(FRAME_HEADER_SIZE);
  const frameSize = firstFrameHeader.readUInt32LE(1);
  const samples: Sample[] = [];
  for (let index = 0; index <= Math.max(...SAMPLE_INDICES); index++) {
    const frameHeader = index === 0 ? firstFrameHeader : await readExact(FRAME_HEADER_SIZE);
    expect(frameHeader.readUInt8(0)).toBe(0);
    expect(frameHeader.readUInt32LE(1)).toBe(frameSize);
    const frameBytes = await readExact(frameSize);
    if (!SAMPLE_INDICES.includes(index)) continue;
    const frame = decodeLMUSourceFrame(frameBytes);
    if (!frame) throw new Error(`LMU fixture frame ${index} failed to decode`);
    const packet = normalizeLMUSourceFrame(frame);
    const nativeWear = [0, 1, 2, 3].map((wheel) =>
      frame.telemetry.readDoubleLE(
        LMU_TELEMETRY.wheels + wheel * LMU_WHEEL_SIZE + LMU_WHEEL.wear,
      ),
    );
    samples.push({
      packet,
      nativeWear,
      nativeDelta: frame.telemetry.readDoubleLE(LMU_TELEMETRY.deltaBest),
    });
  }
  await iterator.return?.();
  return samples;
}

let samples: Sample[];

beforeAll(async () => {
  samples = await readSamples();
}, 600_000);


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
