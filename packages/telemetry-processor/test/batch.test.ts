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
import { F1_HEADER_SIZE, F1_PACKET_IDS } from "@raceiq/capture-formats/f1-2025/f1-wire";

function standingStartFrames(options: { startEvidence?: boolean; distanceScale?: number; duration?: number } = {}): TelemetryBatchInput[] {
  let sequence = 0;
  const frames: TelemetryBatchInput[] = [{ type: "segment-context" }];
  const add = (id: number, time: number, body: Buffer) => {
    const data = Buffer.alloc(F1_HEADER_SIZE + body.length);
    data.writeUInt16LE(2025, 0);
    data[2] = 25; data[3] = 1; data[5] = 1; data[6] = id;
    data.writeBigUInt64LE(1n, 7);
    data.writeFloatLE(time, 15);
    data.writeUInt32LE(++sequence, 19);
    data.writeUInt32LE(sequence, 23);
    data[28] = 255;
    body.copy(data, F1_HEADER_SIZE);
    frames.push({ data, rawByteOffset: sequence * 100 });
  };
  const session = Buffer.alloc(125);
  session[6] = 15;
  session.writeUInt16LE(3000, 4);
  const lap = Buffer.alloc(57);
  lap[33] = 1;
  add(F1_PACKET_IDS.MOTION, 0, Buffer.alloc(60));
  add(F1_PACKET_IDS.SESSION, 0, session);
  add(F1_PACKET_IDS.LAP_DATA, 0, lap);
  add(F1_PACKET_IDS.CAR_TELEMETRY, 0, Buffer.alloc(60));
  if (options.startEvidence !== false) {
    add(F1_PACKET_IDS.EVENT, 0.01, Buffer.from("STLG\x05", "ascii"));
    add(F1_PACKET_IDS.EVENT, 0.02, Buffer.from("LGOT", "ascii"));
  }
  frames.push({ type: "segment-context-end" });
  for (let second = 0; second <= 60; second++) {
    const motion = Buffer.alloc(60);
    motion.writeFloatLE(-50 * (1 - second / 60), 0);
    add(F1_PACKET_IDS.MOTION, second + 1, motion);
    const sample = Buffer.from(lap);
    sample.writeUInt32LE(second * 1000, 4);
    sample.writeFloatLE(second * (options.distanceScale ?? 50), 20);
    add(F1_PACKET_IDS.LAP_DATA, second + 1, sample);
  }
  const boundary = Buffer.from(lap);
  boundary[33] = 2;
  boundary.writeUInt32LE((options.duration ?? 60) * 1000, 0);
  boundary.writeFloatLE(3050, 24);
  add(F1_PACKET_IDS.LAP_DATA, 62, boundary);
  return frames;
}
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
  test("native standing starts relax only closure, not distance or timing quality", async () => {
    const clean = await processTelemetryBatch("f1-2025", standingStartFrames());
    expect(clean.laps[0]).toMatchObject({ classification: "grid_start", valid: true, invalidReason: null });
    const unknown = await processTelemetryBatch("f1-2025", standingStartFrames({ startEvidence: false }));
    expect(unknown.laps[0]).toMatchObject({ classification: null, valid: false, invalidReason: "start/end positions too far apart" });
    const short = await processTelemetryBatch("f1-2025", standingStartFrames({ distanceScale: 1 }));
    expect(short.laps[0]).toMatchObject({ classification: "grid_start", valid: false, invalidReason: "telemetry distance too short" });
    const mistimed = await processTelemetryBatch("f1-2025", standingStartFrames({ duration: 70 }));
    expect(mistimed.laps[0]).toMatchObject({ classification: "grid_start", valid: false, invalidReason: "telemetry lap time mismatch" });
  });
  test("parses committed FM race capture through session and lap transitions", async () => {
    const frames = udpFixtureFrames(resolve(import.meta.dir, "../../../test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"));
    expect(frames).toHaveLength(11_912);
    const result = await processTelemetryBatch("fm-2023", frames);
    expect(result.sessions.map(({ sessionKey, carId, trackId }) => ({ sessionKey, carId, trackId }))).toEqual([
      { sessionKey: 1, carId: "3631", trackId: "5" },
      { sessionKey: 2, carId: "3631", trackId: "5" },
    ]);
    expect(result.laps.map(({ sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset }) => ({
      sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset,
    }))).toEqual([
      { sessionKey: 1, lapNumber: 0, lapTime: 13_207.646484375, valid: false, invalidReason: "incomplete at end of input", frameCount: 2, complete: false, byteOffset: 78_729 },
      { sessionKey: 2, lapNumber: 0, lapTime: 53.954795837402344, valid: true, invalidReason: null, frameCount: 4_704, complete: true, byteOffset: 1_116_559 },
      { sessionKey: 2, lapNumber: 1, lapTime: 51.28666687011719, valid: true, invalidReason: null, frameCount: 3_077, complete: true, byteOffset: 2_692_399 },
      { sessionKey: 2, lapNumber: 2, lapTime: 10.968429565429688, valid: false, invalidReason: "incomplete at end of input", frameCount: 654, complete: false, byteOffset: 3_723_194 },
    ]);
    expect(result.laps.map(({ classification }) => classification)).toEqual([null, "pace", "pace", null]);
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
    expect(result.sessions[0]).toMatchObject({ gameId: "ac-evo", carId: "Porsche 992 GT3 R Rennsport" });
    expect(result.laps.map(({ lapNumber, lapTime, complete, valid, invalidReason, byteOffset, frameCount }) => ({
      lapNumber, lapTime, complete, valid, invalidReason, byteOffset, frameCount,
    }))).toEqual([
      { lapNumber: 1, lapTime: 92.421, complete: true, valid: false, invalidReason: "outlap", byteOffset: 17_100, frameCount: 6_865 },
      { lapNumber: 2, lapTime: 101.358, complete: true, valid: false, invalidReason: "track limits", byteOffset: 703_500, frameCount: 6_435 },
      { lapNumber: 3, lapTime: 109.441, complete: false, valid: false, invalidReason: "incomplete at end of input", byteOffset: 1_346_900, frameCount: 6_938 },
    ]);
    expect(result.laps[0]).toMatchObject({ classification: "out_lap", valid: false, invalidReason: "outlap" });
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
  test("classifies policy out-laps without marking them invalid", async () => {
    const policy = {
      resolveLapTime: (_packets: readonly TelemetryPacket[], next: TelemetryPacket) => next.LastLap,
      classifyPitCycle: () => "outlap" as const,
    };
    const result = await processTelemetryBatch("fm-2023", lapFrames(), { policies: { "fm-2023": policy } });
    expect(result.laps[0]).toMatchObject({ classification: "out_lap", valid: true, invalidReason: null });
  });
  test("merges host pit transition with policy pit evidence", async () => {
    const frames = udpFixtureFrames(resolve(import.meta.dir, "../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz"));
    const policy = {
      resolveLapTime: (_packets: readonly TelemetryPacket[], next: TelemetryPacket) => next.LastLap,
      classifyPitCycle: () => "outlap" as const,
    };
    const result = await processTelemetryBatch("fm-2023", frames, { policies: { "fm-2023": policy } });
    expect(result.laps.some(lap => lap.classification === "pit_lap")).toBe(true);
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
      lapNumber: 1, lapTime: 31.917, byteOffset: 1, frameCount: 65, complete: true, valid: true, classification: "pace",
    }]);
  });
  test("preserves canonical F1 session, lap, offset, and timing results", async () => {
    const path = resolve(import.meta.dir, "../../../test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz");
    const result = await processTelemetryBatch("f1-2025", sessionFixtureInputs(path));
    expect(result.sessions.map(({ sessionKey, carId, trackId }) => ({ sessionKey, carId, trackId }))).toEqual([
      { sessionKey: 1, carId: "", trackId: "19" },
      { sessionKey: 2, carId: "41", trackId: "19" },
    ]);
    expect(result.laps.slice(0, 2).map(({ sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset, sectors }) => ({
      sessionKey, lapNumber, lapTime, valid, invalidReason, frameCount, complete, byteOffset, sectors,
    }))).toEqual([
      { sessionKey: 2, lapNumber: 1, lapTime: 81.535, valid: false, invalidReason: "start/end positions too far apart", frameCount: 27_312, complete: true, byteOffset: 1_833_094, sectors: [32.099, 29.003, 20.433] },
      { sessionKey: 2, lapNumber: 2, lapTime: 79.328, valid: true, invalidReason: null, frameCount: 26_508, complete: true, byteOffset: 32_468_053, sectors: [29.751, 29.382, 20.194999999999997] },
    ]);
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
