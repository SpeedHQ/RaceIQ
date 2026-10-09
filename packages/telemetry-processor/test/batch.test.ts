import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { processTelemetryBatch, type TelemetryBatchFrame, type TelemetryBatchInput } from "../src/batch";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { ACEVO_PACKED_MAGIC, ACC_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";
function forzaFrame(lap: number, currentLap: number, lastLap: number, distance: number): Buffer {
  const data = Buffer.alloc(331);
  data.writeInt32LE(1, 0);
  data.writeUInt32LE((lap * 1000 + Math.trunc(currentLap * 10)) >>> 0, 4);
  data.writeFloatLE(currentLap, 292);
  data.writeFloatLE(lastLap, 288);
  data.writeFloatLE(0, 284);
  data.writeFloatLE(distance, 280);
  data.writeFloatLE(0, 232);
  data.writeFloatLE(0, 240);
  data.writeInt32LE(7, 212);
  data.writeInt32LE(3, 327);
  data.writeUInt16LE(lap, 300);
  return data;
}
function lapFrames(startOffset = 100): TelemetryBatchFrame[] {
  const frames = Array.from({ length: 35 }, (_, i) => ({ data: forzaFrame(1, i, 0, i * 100), rawByteOffset: startOffset + i * 335 }));
  frames.push({ data: forzaFrame(2, 0, 34, 3500), rawByteOffset: startOffset + 35 * 335 });
  return frames;
}
function udpFixtureFrames(path: string): TelemetryBatchFrame[] {
  const bytes = gunzipSync(readFileSync(path));
  const frames: TelemetryBatchFrame[] = [];
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset);
    const frameOffset = offset + 4;
    if (length === 0 || frameOffset + length > bytes.length) break;
    frames.push({ data: bytes.subarray(frameOffset, frameOffset + length), rawByteOffset: frameOffset });
    offset = frameOffset + length;
  }
  return frames;
}

function kunosFixtureFrames(path: string, withOffsets: boolean, magic = ACC_PACKED_MAGIC): TelemetryBatchFrame[] {
  return readKunosFrames(path).map((frame, index) => ({
    data: packTriplet(magic, 1, 1, frame.physics, frame.graphics, frame.staticData),
    ...(withOffsets ? { rawByteOffset: index * 100 } : {}),
  }));
}

function sessionFixtureInputs(path: string): TelemetryBatchInput[] {
  const bytes = gunzipSync(readFileSync(path));
  return [...iterateSessionCaptureRecords(bytes)].map(record => {
    if (record.kind === "frame") return { data: record.frame, rawByteOffset: record.offset, ...(record.frameTimeMs === undefined ? {} : { frameTimeMs: record.frameTimeMs }) };
    if (record.kind === "segment-boundary") return { type: "segment-boundary" };
    if (record.kind === "segment-context") return { type: "segment-context" };
    return { type: "segment-context-end" };
  });
}

describe("processTelemetryBatch", () => {
  test("parses committed FM race capture through session and lap transitions", async () => {
    const frames = udpFixtureFrames(resolve(import.meta.dir, "../../../test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"));
    expect(frames).toHaveLength(11_912);
    const result = await processTelemetryBatch("fm-2023", frames);
    expect(result.sessions.map(({ sessionKey, carOrdinal, trackOrdinal }) => ({ sessionKey, carOrdinal, trackOrdinal }))).toEqual([
      { sessionKey: 1, carOrdinal: 3631, trackOrdinal: 5 },
      { sessionKey: 2, carOrdinal: 3631, trackOrdinal: 5 },
    ]);
    expect(result.laps.map(({ sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset }) => ({
      sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset,
    }))).toEqual([
      { sessionKey: 1, lapNumber: 0, lapTime: 13_207.646484375, valid: false, invalidReason: "incomplete at end of input", frameCount: 2, complete: false, byteOffset: 78_729 },
      { sessionKey: 2, lapNumber: 0, lapTime: 53.954795837402344, valid: true, invalidReason: null, frameCount: 4_704, complete: true, byteOffset: 1_116_559 },
      { sessionKey: 2, lapNumber: 1, lapTime: 51.28666687011719, valid: true, invalidReason: null, frameCount: 3_077, complete: true, byteOffset: 2_692_399 },
      { sessionKey: 2, lapNumber: 2, lapTime: 10.968429565429688, valid: false, invalidReason: "incomplete at end of input", frameCount: 654, complete: false, byteOffset: 3_723_194 },
    ]);
  });

  test("emits parsed lap at ordinal boundary with real offset and frame count", async () => {
    const result = await processTelemetryBatch("fm-2023", lapFrames());
    expect(result.sessions).toHaveLength(1);
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]).toMatchObject({ lapNumber: 1, lapTime: 34, byteOffset: 100, frameCount: 35, complete: true, sectors: null });
    expect(result.laps[0]!.packets).toHaveLength(35);
  });

  test("finalizes ACC capture silently at EOF and preserves only supplied offsets", async () => {
    const path = resolve(import.meta.dir, "../../../test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz");
    const withOffsets = await processTelemetryBatch("acc", kunosFixtureFrames(path, true));
    const withoutOffsets = await processTelemetryBatch("acc", kunosFixtureFrames(path, false));
    expect(withOffsets.sessions).toHaveLength(1);
    expect(withOffsets.laps.length).toBeGreaterThan(0);
    expect(withOffsets.laps.at(-1)).toMatchObject({ complete: false, valid: false, byteOffset: expect.any(Number) });
    expect(withoutOffsets.laps.at(-1)).toMatchObject({ complete: false, valid: false, byteOffset: null, frameCount: 0 });
  });

  test("processes complete AC Evo capture with its own packet magic and policy", async () => {
    const path = resolve(import.meta.dir, "../../../test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz");
    const result = await processTelemetryBatch("ac-evo", kunosFixtureFrames(path, true, ACEVO_PACKED_MAGIC));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ gameId: "ac-evo", carOrdinal: 59, trackOrdinal: -1 });
    expect(result.laps.map(({ lapNumber, lapTime, complete, invalidReason, byteOffset, frameCount }) => ({
      lapNumber, lapTime, complete, invalidReason, byteOffset, frameCount,
    }))).toEqual([
      { lapNumber: 1, lapTime: 92.421, complete: true, invalidReason: "outlap", byteOffset: 17_100, frameCount: 6_865 },
      { lapNumber: 2, lapTime: 101.358, complete: true, invalidReason: "track limits", byteOffset: 703_500, frameCount: 6_435 },
      { lapNumber: 3, lapTime: 109.441, complete: false, invalidReason: "incomplete at end of input", byteOffset: 1_346_900, frameCount: 6_938 },
    ]);
  });
  test("finalizes incomplete ordinal lap at EOF and preserves absent offsets", async () => {
    const withOffsets = await processTelemetryBatch("fm-2023", lapFrames().slice(0, 35));
    expect(withOffsets.laps).toHaveLength(1);
    expect(withOffsets.laps[0]).toMatchObject({ lapNumber: 1, byteOffset: 100, frameCount: 35, complete: false, valid: false });
    const withoutOffsets = await processTelemetryBatch("fm-2023", lapFrames().slice(0, 35).map(({ data }) => ({ data })));
    expect(withoutOffsets.laps[0]).toMatchObject({ byteOffset: null, frameCount: 0, complete: false });
  });

  test("trims running-start packets before ordinal EOF emission", async () => {
    const frames = [
      ...Array.from({ length: 5 }, (_, i) => ({ data: forzaFrame(1, 6 + i, 0, i * 10), rawByteOffset: 500 + i * 335 })),
      ...Array.from({ length: 35 }, (_, i) => ({ data: forzaFrame(1, i, 0, 500 + i * 100), rawByteOffset: 2175 + i * 335 })),
    ];
    const result = await processTelemetryBatch("fm-2023", frames);
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]).toMatchObject({ byteOffset: 500, frameCount: 40, complete: false });
    expect(result.laps[0]!.packets).toHaveLength(35);
    expect(result.laps[0]!.packets[0]!.CurrentLap).toBe(0);
  });

  test("trims running-start packets before completed ordinal emission", async () => {
    const frames = [
      ...Array.from({ length: 5 }, (_, i) => ({ data: forzaFrame(1, 6 + i, 0, i * 10), rawByteOffset: 500 + i * 335 })),
      ...Array.from({ length: 35 }, (_, i) => ({ data: forzaFrame(1, i, 0, 500 + i * 100), rawByteOffset: 2175 + i * 335 })),
      { data: forzaFrame(2, 0, 34, 4000), rawByteOffset: 2175 + 35 * 335 },
    ];
    const result = await processTelemetryBatch("fm-2023", frames);
    expect(result.laps[0]).toMatchObject({ complete: true, byteOffset: 500, frameCount: 40 });
    expect(result.laps[0]!.packets).toHaveLength(35);
    expect(result.laps[0]!.packets[0]!.CurrentLap).toBe(0);
  });
  test("uses packaged sector catalog when no host geometry override is supplied", async () => {
    const frames = Array.from({ length: 55 }, (_, i) => ({
      data: forzaFrame(1, i, 0, i * 100), rawByteOffset: 100 + i * 335,
    }));
    frames.push({ data: forzaFrame(2, 0, 54, 5500), rawByteOffset: 100 + 55 * 335 });
    const result = await processTelemetryBatch("fm-2023", frames);
    expect(result.laps[0]!.sectors).toEqual([19, 17, 18]);
  });
  test("preserves policy pit-cycle reason when host transition evidence is absent", async () => {
    const policy = {
      resolveLapTime: (_packets: readonly TelemetryPacket[], next: TelemetryPacket) => next.LastLap,
      classifyPitCycle: () => "outlap" as const,
    };
    const result = await processTelemetryBatch("fm-2023", lapFrames(), { policies: { "fm-2023": policy } });
    expect(result.laps[0]).toMatchObject({ valid: false, invalidReason: "outlap" });
  });
  test("merges host pit transition with policy pit evidence", async () => {
    const frames = udpFixtureFrames(resolve(import.meta.dir, "../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz"));
    const policy = {
      resolveLapTime: (_packets: readonly TelemetryPacket[], next: TelemetryPacket) => next.LastLap,
      classifyPitCycle: () => "outlap" as const,
    };
    const result = await processTelemetryBatch("fm-2023", frames, { policies: { "fm-2023": policy } });
    expect(result.laps.some(lap => lap.invalidReason === "pit lap")).toBe(true);
  });

  test("accepts authoritative iRacing complete-lap-start context on committed capture", async () => {
    const path = resolve(import.meta.dir, "../../../test/artifacts/sessions/iracing-road-america-gt3.bin.gz");
    const frames = readIRacingFrames(path).map((data, index) => ({ data, rawByteOffset: index }));
    expect(frames.length).toBeGreaterThan(0);
    const result = await processTelemetryBatch("iracing", [
      { type: "segment-context", completeLapStart: true }, frames[0]!, { type: "segment-context-end" }, ...frames.slice(1),
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.laps.slice(0, 1)).toMatchObject([{
      lapNumber: 1, lapTime: 31.917, byteOffset: 1, frameCount: 65, complete: true, valid: true,
    }]);
  });
  test("preserves canonical F1 session, lap, offset, and timing results", async () => {
    const path = resolve(import.meta.dir, "../../../test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz");
    const result = await processTelemetryBatch("f1-2025", sessionFixtureInputs(path));
    expect(result.sessions.map(({ sessionKey, carOrdinal, trackOrdinal }) => ({ sessionKey, carOrdinal, trackOrdinal }))).toEqual([
      { sessionKey: 1, carOrdinal: 0, trackOrdinal: 19 },
      { sessionKey: 2, carOrdinal: 41, trackOrdinal: 19 },
    ]);
    expect(result.laps.slice(0, 2).map(({ sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset, sectors }) => ({
      sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset, sectors,
    }))).toEqual([
      { sessionKey: 2, lapNumber: 1, lapTime: 81.535, valid: false, invalidReason: "start/end positions too far apart", frameCount: 27_312, complete: true, byteOffset: 1_833_094, sectors: [32.099, 29.003, 20.433] },
      { sessionKey: 2, lapNumber: 2, lapTime: 79.328, valid: true, invalidReason: null, frameCount: 26_508, complete: true, byteOffset: 32_468_053, sectors: [29.751, 29.382, 20.194999999999997] },
    ]);
  });
  test("retains LMU parser-provided identity in session metadata", async () => {
    const path = resolve(import.meta.dir, "../../../test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz");
    const frames = readLMUFrames(path).map((data, index) => ({ data, rawByteOffset: index }));
    expect(frames.length).toBeGreaterThan(0);
    const result = await processTelemetryBatch("lmu", frames);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      gameId: "lmu", sessionUID: expect.stringContaining("porsche_911rsr-19_2023"),
      carId: "porsche_911rsr-19_2023", trackId: "Circuit de Spa-Francorchamps",
    });
  });
  test("context primes parser without emitting telemetry; segment boundary resets lifecycle", async () => {
    const frames = lapFrames();
    const withContext = await processTelemetryBatch("fm-2023", [
      { type: "segment-context" }, frames[0]!, { type: "segment-context-end" }, ...frames,
      { type: "segment-boundary" }, ...lapFrames(20_000),
    ]);
    expect(withContext.sessions).toHaveLength(2);
    expect(withContext.laps).toHaveLength(2);
    expect(withContext.laps.map(lap => lap.byteOffset)).toEqual([100, 20_000]);
    expect(withContext.laps.every(lap => lap.packets.length === 35)).toBe(true);
  });

  test("returns empty outcomes for empty complete payload", async () => {
    expect(await processTelemetryBatch("fm-2023", [])).toEqual({ sessions: [], laps: [] });
  });
});
