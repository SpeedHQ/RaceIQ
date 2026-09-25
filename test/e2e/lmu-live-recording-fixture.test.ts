import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { LMU_TELEMETRY, LMU_WHEEL, LMU_WHEEL_SIZE } from "../../server/games/lmu/layout";
import { decodeLMUSourceFrame } from "../../server/games/lmu/source-frame";
import { normalizeLMUSourceFrame } from "../../server/games/lmu/normalizer";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { combineRecordingParts, type CombinedRecording } from "../../scripts/lib/combine-recording-parts";
import { lmuAdapter } from "../../shared/games/lmu";
import { analyseSemanticIds } from "../../shared/games/metric-contracts";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
const FIXTURE_PARTS = [
  "test/artifacts/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz.part1",
  "test/artifacts/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz.part2",
];
const HEADER_SIZE = 16;
const FRAME_HEADER_SIZE = 5;
const SAMPLE_INDICES = [0, 500, 5_000, 10_000, 20_000, 30_000, 40_000];

type Sample = {
  packet: TelemetryPacket;
  nativeWear: number[];
  nativeDelta: number;
};

async function readSamples(combinedPath: string): Promise<Sample[]> {
  const stream = createReadStream(combinedPath).pipe(createGunzip());

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
let combinedFixture: CombinedRecording | null = null;

beforeAll(async () => {
  combinedFixture = await combineRecordingParts(FIXTURE_PARTS);
  samples = await readSamples(combinedFixture.path);
}, 600_000);


afterAll(async () => {
  combinedFixture?.cleanup();
  await stopMaintenanceTasks();
});

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
  test("normalizes slip from patch motion against ground velocity", () => {
    const straightAt20k = samples[4]!.packet;
    const straightAt30k = samples[5]!.packet;
    const cornerAt10k = samples[3]!.packet;
    const angles20k = [
      straightAt20k.TireSlipAngleFL,
      straightAt20k.TireSlipAngleFR,
      straightAt20k.TireSlipAngleRL,
      straightAt20k.TireSlipAngleRR,
    ];
    const angles30k = [
      straightAt30k.TireSlipAngleFL,
      straightAt30k.TireSlipAngleFR,
      straightAt30k.TireSlipAngleRL,
      straightAt30k.TireSlipAngleRR,
    ];
    const ratios30k = [
      straightAt30k.TireSlipRatioFL,
      straightAt30k.TireSlipRatioFR,
      straightAt30k.TireSlipRatioRL,
      straightAt30k.TireSlipRatioRR,
    ];

    expect(straightAt20k.Speed).toBeCloseTo(61.4, 0);
    expect(Math.abs((straightAt20k.TireSlipAngleRR! * 180) / Math.PI)).toBeLessThan(0.2);
    expect(angles20k.every((angle) => Math.abs((angle! * 180) / Math.PI) < 5)).toBe(true);
    expect(angles30k.every((angle) => Math.abs((angle! * 180) / Math.PI) < 5)).toBe(true);
    expect(ratios30k.every((ratio) => Math.abs(ratio!) < 0.1)).toBe(true);
    expect(Math.abs((cornerAt10k.TireSlipAngleFL! * 180) / Math.PI)).toBeGreaterThan(1);
    expect((cornerAt10k.TireSlipAngleFL! * 180) / Math.PI).toBeCloseTo(-6.4, 0);
  });

  test("exposes recorded tire layers to Analyse without inventing core", () => {
    const ids = analyseSemanticIds(lmuAdapter);
    const layers = [
      "tire.temperature.surface.inner",
      "tire.temperature.surface.middle",
      "tire.temperature.surface.outer",
      "tire.temperature.carcass.representative",
    ] as const;
    for (const id of layers) expect(ids).toContain(id);
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
      simulator: "lmu",
      requested: [...layers, "tire.temperature.core"].map((semanticId) => ({ semanticId })),
    });
    const frame = resolver.createFrameView(samples[3]!.packet, {
      timestamp: { domain: "session", milliseconds: 1_000 },
      updateSequence: 1n,
    });
    for (const id of layers) {
      const resolved = frame.resolveValue<readonly number[]>(resolver.slot(id));
      expect(resolved.state).toBe("ok");
      expect(resolved.value?.every((temperature) => Number.isFinite(temperature) && temperature > -100 && temperature < 300)).toBe(true);
    }
    expect(frame.resolveValue(resolver.slot("tire.temperature.core")).state).toBe("missing");
  });

  test("retains game's delta-to-best channel", () => {
    for (const { packet, nativeDelta } of samples) {
      expect(packet.lmu?.deltaBest).toBeCloseTo(nativeDelta, 12);
    }
    expect(samples.some(({ nativeDelta }) => Math.abs(nativeDelta) > 0.01)).toBe(true);
  });
});
